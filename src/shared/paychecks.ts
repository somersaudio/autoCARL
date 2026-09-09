// Per-paycheck earnings: what each bi-weekly check should actually deposit.
//
// CT pays bi-weekly. Gig days land on whichever check covers their pay
// period, so one check can carry several gigs and one gig can split across
// two checks (a booking that straddles a period boundary). This module maps
// upcoming gig days onto checks and withholds each check THE WAY PAYROLL
// DOES — each check in isolation, annualized (IRS Pub 15-T percentage
// method) — so heavy checks show the higher withholding rate they'll really
// have and quiet checks the lower one.
//
// Validated against John's real 6/1–6/14 stub: same gross in → federal
// within ~1%, Social Security and Medicare to the cent, net to the dollar.
//
// The rates here are cash-flow truth per check, not the year's blended rate:
// over-withholding on heavy checks comes back at tax time.

import { withSplit } from './hours';
import type { Booking, BookingContactsCache, SswWeek, SswDay, UserSettings } from './types';
import {
  STANDARD_DEDUCTION, SS_RATE, MEDICARE_RATE, federalIncomeTax,
} from './taxes';

// Known pay-period start (a Monday) from John's real stub: period
// 6/1/2026–6/14/2026. All periods are 14 days off this anchor, so every
// period runs Monday through Sunday and the last day on a check is always
// that closing Sunday.
export const PERIOD_ANCHOR_ISO = '2026-06-01';
// The stub's Check Date for that period was Thursday 6/18, but the deposit
// lands the Friday after — payday as crew actually experience it. We show
// the Friday, which also makes the rule read true on screen: the last day
// on a check is the Sunday before the Friday it pays.
export const PAY_LAG_DAYS = 5;
const PERIOD_DAYS = 14;
const CHECKS_PER_YEAR = 26;

export type GigOnCheck = {
  bookingId: string;
  jobName: string;
  jobNumber: string;
  days: number;          // this gig's worked days inside this period
  dayRate: number;
  gross: number;         // standard days * dayRate, actual-hours days by hours
  perDiem: number;       // per-diem dollars accrued on this check (untaxed)
  // Gross dollars on this gig that came from OT and DT hours (time-and-a-half
  // and double time), 0 when the days are priced from the standard-day
  // assumption rather than a saved timesheet.
  otPay: number;
  actualHours: number;   // hours actually read off the timesheet
  // Days whose pay came from saved timesheet hours rather than the standard
  // 10-hour-day assumption.
  actualDays: number;
};

export type Paycheck = {
  periodStart: string;   // ISO, Monday
  periodEnd: string;     // ISO, Sunday (inclusive)
  payDate: string;       // ISO, periodEnd + PAY_LAG_DAYS
  gigs: GigOnCheck[];
  gross: number;
  retirement: number;    // 401k withheld
  federal: number;
  socialSecurity: number;
  medicare: number;
  state: number;
  taxes: number;         // sum of the four above; 0 when subtractTaxes is off
  net: number;           // gross - retirement - taxes  (per diem NOT included)
  perDiem: number;       // untaxed, lands on the same deposit
  otPay: number;         // gross dollars from OT + DT hours across this check
  actualHours: number;   // hours read off saved timesheets for this check
  withholdingRate: number; // taxes / gross — varies per check, by design
  actualDays: number;    // days priced from saved timesheet hours
};

// A gig's totals across every check it appears on, for the booking cards.
export type GigPay = {
  net: number;
  perDiem: number;
  gross: number;
  days: number;
  dayRate: number;
  // One entry per check this gig touches, for the tooltip breakdown.
  parts: Array<{ payDate: string; days: number; net: number; withholdingRate: number }>;
};

export type PaycheckPlan = {
  checks: Paycheck[];
  perGig: Record<string, GigPay>;
};

// Whole-dollar formatting with thousands separators — cents add noise to a
// number that is an estimate to begin with.
export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

// ---- local-midnight date helpers (same rationale as elsewhere: bare
// new Date('YYYY-MM-DD') parses as UTC and shifts a day west of Greenwich).
function parseISOLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(iso: string, n: number): string {
  const d = parseISOLocal(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
function daysBetween(aIso: string, bIso: string): number {
  return Math.round((parseISOLocal(bIso).getTime() - parseISOLocal(aIso).getTime()) / 86_400_000);
}

// Which pay period (index from the anchor) a date falls in.
function periodIndex(iso: string): number {
  return Math.floor(daysBetween(PERIOD_ANCHOR_ISO, iso) / PERIOD_DAYS);
}
function periodStartOf(index: number): string {
  return addDays(PERIOD_ANCHOR_ISO, index * PERIOD_DAYS);
}

function pct(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 100) / 100 : 0;
}

// Federal withholding on one check, payroll-style: annualize the check's
// taxable wages, run the year's brackets and standard deduction, divide back.
// This is why an OT-heavy check withholds at a higher rate than a quiet one —
// payroll prices every check as if the whole year looked like it.
function federalPerCheck(taxableCheckWages: number, settings: UserSettings): number {
  const annualized = taxableCheckWages * CHECKS_PER_YEAR;
  const annualTax = federalIncomeTax(
    annualized - STANDARD_DEDUCTION[settings.filingStatus],
    settings.filingStatus,
  );
  return annualTax / CHECKS_PER_YEAR;
}

// SSW's own pay model (see ssw.ts): a day rate covers 8 reg + 2 OT×1.5 = 11
// weighted hours, so hourly = dayRate / 11 and a day's wages are
// hourly × (reg + 1.5×OT + 2×DT). Reproduces John's stub exactly
// (72 reg + 29 OT at $650/day = $6,824.90).
function hoursPay(day: SswDay, dayRate: number): number {
  const hourly = dayRate / 11;
  return hourly * (day.regHours + 1.5 * day.otHours + 2 * day.dtHours);
}

// A standard show day is ten hours, which SSW books as 8 regular + 2 OT — and
// the app autofills exactly that (8:00 am - 6:00 pm) into every day you don't
// type over. Those two hours are the normal day, not overtime worked, so they
// stay out of the figure: only OT beyond them counts, plus all double time.
const STANDARD_OT_HOURS = 2;

// The slice of a day's pay that came from genuine overtime, at premium rates.
// It earns its own line because a ten-hour day prices to exactly the day rate,
// so real extra hours can be in a check without moving the headline at all.
function overtimePay(day: SswDay, dayRate: number): number {
  const hourly = dayRate / 11;
  const extraOt = Math.max(0, day.otHours - STANDARD_OT_HOURS);
  return hourly * (1.5 * extraOt + 2 * day.dtHours);
}

// The saved timesheet entry for a date, if its week is cached and the day has
// SSW-computed hours. Unsaved grid edits don't qualify — the reg/OT/DT split
// comes from SSW's spreadsheet on save, and we won't guess it locally.
function timesheetDayFor(iso: string, weeks: Record<string, SswWeek>): SswDay | null {
  const monday = addDays(iso, -((parseISOLocal(iso).getDay() + 6) % 7));
  const week = weeks[monday];
  if (!week) return null;
  const found = week.days.find((d) => d.date === iso);
  if (!found) return null;
  // SSW returns a day the app saved with its total right and the reg/OT/DT
  // buckets all zero; derive them so overtime doesn't vanish.
  const day = withSplit(found);
  // Only a day with PAYABLE hours may override the day-rate assumption.
  // SSW can hand back a day carrying a total with no reg/OT/DT split — a
  // freshly created week, or one saved before its spreadsheet recalculated —
  // and pricing that day from those hours pays it $0, which silently wipes an
  // otherwise real paycheck. A day with nothing payable on it simply hasn't
  // been filled in yet, so it falls back to the standard-day estimate.
  const payable = day.regHours + day.otHours + day.dtHours;
  return payable > 0 ? day : null;
}

/**
 * Map upcoming bookings onto bi-weekly checks and withhold each check the way
 * payroll will. Gigs with no day rate contribute nothing (same rule as the
 * old per-gig estimate: no base pay configured, no numbers shown).
 *
 * `weeks` is the cached SSW timesheet map: any day with saved hours is priced
 * from those hours (OT/DT included) instead of the standard 10-hour-day
 * assumption, and its per diem comes from the sheet rather than the GSA rate.
 */
export function buildPaychecks(
  upcoming: Booking[],
  contacts: BookingContactsCache,
  settings: UserSettings,
  weeks: Record<string, SswWeek> = {},
): PaycheckPlan {
  const baseRate = Number.isFinite(settings.basePayDayRate) && settings.basePayDayRate > 0
    ? settings.basePayDayRate : 0;
  const retirementRate = pct(settings.retirementPct);

  // ---- bucket every gig day into its period ----
  type Bucket = Map<string, GigOnCheck>;           // bookingId -> partial gig
  const periods = new Map<number, Bucket>();
  for (const b of upcoming) {
    const rate = settings.gigDayRates?.[b.bookingId] || baseRate;
    if (rate <= 0) continue;
    const c = contacts[b.bookingId];
    const perDiemRate = c?.gsaPerDiem || c?.perDiem || 0;
    const total = daysBetween(b.startDate, b.endDate) + 1;
    if (total <= 0) continue;
    for (let i = 0; i < total; i++) {
      const day = addDays(b.startDate, i);
      const idx = periodIndex(day);
      let bucket = periods.get(idx);
      if (!bucket) { bucket = new Map(); periods.set(idx, bucket); }
      let gig = bucket.get(b.bookingId);
      if (!gig) {
        gig = {
          bookingId: b.bookingId, jobName: b.jobName, jobNumber: b.jobNumber,
          days: 0, dayRate: rate, gross: 0, perDiem: 0, otPay: 0, actualHours: 0, actualDays: 0,
        };
        bucket.set(b.bookingId, gig);
      }
      gig.days += 1;
      const sheet = timesheetDayFor(day, weeks);
      if (sheet) {
        gig.gross += hoursPay(sheet, rate);
        gig.otPay += overtimePay(sheet, rate);
        gig.actualHours += sheet.regHours + sheet.otHours + sheet.dtHours;
        // A blank per-diem box on the timesheet means "not filled in", not
        // "none owed" — taking it literally quietly removes the day's per
        // diem from the estimate, so a saved sheet could LOWER the projected
        // deposit. Fall back to the rate the day would otherwise have used.
        gig.perDiem += sheet.perDiem > 0 ? sheet.perDiem : perDiemRate;
        gig.actualDays += 1;
      } else {
        gig.gross += rate;
        gig.perDiem += perDiemRate;
      }
    }
  }

  // ---- withhold each check in isolation ----
  const checks: Paycheck[] = [];
  const perGig: Record<string, GigPay> = {};
  for (const idx of Array.from(periods.keys()).sort((a, b) => a - b)) {
    const gigs = Array.from(periods.get(idx)!.values());
    const gross = gigs.reduce((s, g) => s + g.gross, 0);
    const perDiem = gigs.reduce((s, g) => s + g.perDiem, 0);
    const otPay = gigs.reduce((s, g) => s + g.otPay, 0);
    const actualHours = gigs.reduce((s, g) => s + g.actualHours, 0);
    const retirement = gross * retirementRate;
    const taxable = gross - retirement;            // 401k is pre-tax for income tax…
    let federal = 0, socialSecurity = 0, medicare = 0, state = 0;
    if (settings.subtractTaxes) {
      federal = federalPerCheck(taxable, settings);
      socialSecurity = gross * SS_RATE;            // …but FICA is on gross.
      medicare = gross * MEDICARE_RATE;
      state = taxable * pct(settings.stateTaxRatePct);
    }
    const taxes = federal + socialSecurity + medicare + state;
    const net = gross - retirement - taxes;
    const periodStart = periodStartOf(idx);
    const periodEnd = addDays(periodStart, PERIOD_DAYS - 1);
    const check: Paycheck = {
      periodStart,
      periodEnd,
      payDate: addDays(periodEnd, PAY_LAG_DAYS),
      gigs, gross, retirement, federal, socialSecurity, medicare, state, taxes,
      net, perDiem, otPay, actualHours,
      withholdingRate: gross > 0 ? taxes / gross : 0,
      actualDays: gigs.reduce((s2, g) => s2 + g.actualDays, 0),
    };
    checks.push(check);

    // Attribute the check's net back to its gigs, proportional to each gig's
    // gross. Within one check the withholding rate is uniform, so this is
    // exact — gig cards sum to precisely what the checks deposit.
    for (const g of gigs) {
      const share = gross > 0 ? g.gross / gross : 0;
      const gigNet = net * share;
      let acc = perGig[g.bookingId];
      if (!acc) {
        acc = { net: 0, perDiem: 0, gross: 0, days: 0, dayRate: g.dayRate, parts: [] };
        perGig[g.bookingId] = acc;
      }
      acc.net += gigNet;
      acc.perDiem += g.perDiem;
      acc.gross += g.gross;
      acc.days += g.days;
      acc.parts.push({
        payDate: check.payDate,
        days: g.days,
        net: gigNet,
        withholdingRate: check.withholdingRate,
      });
    }
  }

  return { checks, perGig };
}
