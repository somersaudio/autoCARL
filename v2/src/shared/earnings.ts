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
): EarningsEstimate | null {
  const dayRate = positive(settings.basePayDayRate);
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
  // `share` is what fraction of the year's wages this gig represents. Every tax
  // below is computed annually and scaled by it, which is what makes the
  // per-gig figures sum to the year's real bill.
  const share = annualWages > 0 ? grossWages / annualWages : 0;

  // Federal: 401k is pre-tax, so it shrinks the taxable base.
  const annualTaxable = annualWages * (1 - retirementRate) - STANDARD_DEDUCTION[status];
  const federalTax = federalIncomeTax(annualTaxable, status) * share;

  // FICA is levied on gross wages — a traditional 401k deferral does not
  // reduce it. Computed across the full year so the Social Security cap and
  // the additional-Medicare threshold land in the right place, then shared out.
  const annualFica = ficaOnWageSlice(0, annualWages, status);
  const socialSecurity = annualFica.socialSecurity * share;
  const medicare = annualFica.medicare * share;

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
  };
}

// Whole-dollar formatting with thousands separators — cents add noise to a
// number that is an estimate to begin with.
export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
