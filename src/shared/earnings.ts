// Earnings estimates for upcoming bookings.
//
// These are *estimates for the user's own planning* — nothing here is ever
// written back to SSW or CARL. The day rate comes from Settings
// (`basePayDayRate`), deliberately separate from `defaultDailyRate`, which is
// the SSW override and does get pushed on every timesheet save.
//
// Pay model, mirroring SSW's own spreadsheet (see ssw.ts:hourlyFromDaily):
// a day rate covers 8 regular hours + 2 OT hours at 1.5x = 11 weighted hours,
// so one standard 10-hour day earns exactly one day rate. We have no hours for
// a gig that hasn't happened yet, so an estimate assumes standard days:
//
//   gross wages = calendar days (inclusive) x day rate
//
// Real OT/DT on site pushes actual pay above this, so treat the number as a
// floor rather than a forecast.
//
// ----- How tax is figured -----
//
// We tax the whole expected year with real brackets, then charge this gig its
// PROPORTIONAL share of that bill. So a gig is taxed at the user's AVERAGE
// rate for the year, not the marginal rate on the top slice.
//
// Average rather than marginal is deliberate. The bookings screen lists every
// upcoming gig and users add them up; those gigs collectively make up the rest
// of the year, so no single one of them is "the marginal gig." Taxing each at
// the top marginal rate would make the column sum to less than the year
// actually nets. Average shares are self-consistent: they sum to exactly the
// year's real tax bill.
//
// (Marginal is the right lens for a different question — "should I take ONE
// more gig on top of a full year?" — where the answer really is the top-bracket
// rate. That's not what this screen is for.)
//
// Both differ from what payroll withholds per check. Payroll annualizes each
// check in isolation (IRS Pub 15-T percentage method), so an OT-heavy check is
// withheld as though every check that year were that big. That over-withholds
// on busy periods and trues up on the return.

import type { UserSettings } from './types';
import {
  STANDARD_DEDUCTION, federalIncomeTax, ficaOnWageSlice,
} from './taxes';

export type EarningsEstimate = {
  days: number;
  dayRate: number;
  grossWages: number;
  // 401k contribution, withheld from wages. 0 when retirementPct is 0.
  retirement: number;
  // Federal income tax attributable to this gig, at the margin.
  federalTax: number;
  socialSecurity: number;
  medicare: number;
  stateTax: number;
  // Every tax above, combined. 0 when subtractTaxes is off.
  taxes: number;
  // What lands in the bank: gross - retirement - taxes.
  netWages: number;
  // Blended rate this gig is taxed at, for display. Share of gross wages.
  effectiveRate: number;
  // Per diem is a reimbursement, not wages: never taxed, never 401k-eligible,
  // so it is tracked separately and added after all deductions.
  perDiemRate: number;
  perDiem: number;
  // True when any deduction is actually being applied, so the UI can decide
  // between "take-home" and "gross" wording.
  hasDeductions: boolean;
  // True when we had no income context to place this gig in the brackets, so
  // it was taxed as though it were the year's only income. Understates tax.
  lowConfidence: boolean;
  // True when dayRate came from a per-gig override rather than base pay.
  usesCustomRate: boolean;
};

// Inclusive day count between two ISO "YYYY-MM-DD" dates. Booking.endDate is
// already collapsed to the last worked day (iCal's exclusive +1 is undone at
// parse time), so both ends count.
export function bookingDays(startDate: string, endDate: string): number {
  const start = parseISOLocal(startDate);
  const end = parseISOLocal(endDate);
  if (!start || !end) return 0;
  const diff = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return diff > 0 ? diff : 0;
}

// Parse "YYYY-MM-DD" at LOCAL midnight. `new Date("2026-05-26")` parses as UTC,
// which lands on the previous day in any negative-offset timezone and would
// silently drop a day from every estimate.
function parseISOLocal(s: string): Date | null {
  const parts = String(s || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d);
}

function pct(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 100) / 100 : 0;
}

function positive(value: number | undefined): number {
  return Number.isFinite(value as number) && (value as number) > 0 ? (value as number) : 0;
}

/**
 * Project a full year of wages from year-to-date earnings, by how much of the
 * calendar year has elapsed. Crude for seasonal work, which is why the Settings
 * screen offers it as a pre-fill the user can overwrite rather than a value
 * they're stuck with.
 */
export function projectAnnualFromYtd(ytdWages: number, on: Date): number {
  if (!(ytdWages > 0)) return 0;
  const year = on.getFullYear();
  const startOfYear = new Date(year, 0, 1).getTime();
  const startOfNext = new Date(year + 1, 0, 1).getTime();
  const elapsed = (on.getTime() - startOfYear) / (startOfNext - startOfYear);
  // Guard the first days of January, where dividing by ~0 explodes.
  if (elapsed < 0.02) return ytdWages;
  return Math.round(ytdWages / elapsed);
}

/**
 * Estimate what a booking pays. Returns null when there's nothing meaningful
 * to show — no day rate configured, or a booking whose dates don't parse — so
 * callers can simply skip rendering.
 *
 * `perDiemRate` is the GSA M&IE rate already looked up for this booking
 * (BookingContacts.gsaPerDiem), or 0/undefined when unknown.
 */
export function estimateEarnings(
  startDate: string,
  endDate: string,
  settings: UserSettings,
  perDiemRate?: number,
  /** Day rate for this gig alone, overriding basePayDayRate. 0/undefined = use the default. */
  dayRateOverride?: number,
): EarningsEstimate | null {
  const override = positive(dayRateOverride);
  const dayRate = override > 0 ? override : positive(settings.basePayDayRate);
  if (dayRate <= 0) return null;

  const days = bookingDays(startDate, endDate);
  if (days <= 0) return null;

  const grossWages = days * dayRate;
  const retirementRate = pct(settings.retirementPct);
  const retirement = grossWages * retirementRate;

  const status = settings.filingStatus;
  const ytdWages = positive(settings.ytdWages);

  // Where this gig sits in the year's income. Without any context we fall back
  // to treating the gig as the year's only earnings, which lands it in the
  // lowest brackets and understates tax — flagged via lowConfidence.
  const statedAnnual = positive(settings.expectedAnnualWages);
  const annualWages = Math.max(statedAnnual, ytdWages, grossWages);
  const lowConfidence = statedAnnual <= 0 && ytdWages <= 0;

  // ----- tax the whole year, then take this gig's share -----
  //
  // Federal brackets apply to HOUSEHOLD income, but Social Security is capped
  // PER PERSON — so a joint filer's two figures cannot be collapsed into one.
  // Everything below keeps them apart: `annualWages` is this user's own, and
  // spouse wages only ever widen the federal base.
  const spouseWages = status === 'mfj' ? positive(settings.spouseAnnualWages) : 0;

  // Federal: 401k is pre-tax, so it shrinks the taxable base — but only this
  // user defers; the spouse figure is entered as already-taxable wages.
  const ownTaxableWages = annualWages * (1 - retirementRate);
  const householdTaxableWages = ownTaxableWages + spouseWages;
  const gigTaxableWages = grossWages - retirement;

  const householdFederal = federalIncomeTax(
    householdTaxableWages - STANDARD_DEDUCTION[status],
    status,
  );
  // This gig's slice of the household's taxable wages, so the year's gigs sum
  // to the household's actual federal bill rather than each paying top rate.
  const federalShare = householdTaxableWages > 0 ? gigTaxableWages / householdTaxableWages : 0;
  const federalTax = householdFederal * federalShare;

  // FICA is levied on gross wages — a traditional 401k deferral does not
  // reduce it — and on THIS PERSON's wages alone, since each spouse gets their
  // own Social Security cap. Computed across their full year so the cap lands
  // in the right place, then shared out.
  //
  // Caveat: for joint filers the 0.9% additional-Medicare surtax is legally
  // assessed on combined wages over $250k. Using own wages here under-counts it
  // for couples who each earn a lot; the error is at most 0.9% of the excess.
  const ficaShare = annualWages > 0 ? grossWages / annualWages : 0;
  const annualFica = ficaOnWageSlice(0, annualWages, status);
  const socialSecurity = annualFica.socialSecurity * ficaShare;
  const medicare = annualFica.medicare * ficaShare;

  // State: a flat rate covers no-income-tax states exactly and approximates the
  // rest. Most states start from federal AGI, so the 401k deferral reduces it.
  const stateTax = (grossWages - retirement) * pct(settings.stateTaxRatePct);

  const taxes = settings.subtractTaxes
    ? federalTax + socialSecurity + medicare + stateTax
    : 0;
  const netWages = grossWages - retirement - taxes;

  const rate = positive(perDiemRate);

  return {
    days,
    dayRate,
    grossWages,
    retirement,
    federalTax: settings.subtractTaxes ? federalTax : 0,
    socialSecurity: settings.subtractTaxes ? socialSecurity : 0,
    medicare: settings.subtractTaxes ? medicare : 0,
    stateTax: settings.subtractTaxes ? stateTax : 0,
    taxes,
    netWages,
    effectiveRate: grossWages > 0 ? taxes / grossWages : 0,
    perDiemRate: rate,
    perDiem: days * rate,
    hasDeductions: retirement > 0 || taxes > 0,
    lowConfidence: lowConfidence && settings.subtractTaxes,
    usesCustomRate: override > 0,
  };
}

// Whole-dollar formatting with thousands separators — cents add noise to a
// number that is an estimate to begin with.
export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
