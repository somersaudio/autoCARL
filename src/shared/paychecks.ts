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

// A timesheet turned in after its Monday can miss its check, and payroll pays
// that week on the next one, two weeks later. Whether it does varies, so the
// estimator never guesses: the user marks a week "not paid on this check"
// (UserSettings.slippedWeeks, by the week's Monday) and its days are priced
// onto the following check. A check that has just paid stays on screen this
// many days, long enough to compare it with the deposit and mark a week.
export const PAID_CHECK_GRACE_DAYS = 4;

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

// One timesheet week's share of a check. Weeks run Monday to Sunday and pay
// periods are two of them, so a week is always wholly on one check.
export type WeekOnCheck = {
  monday: string;              // ISO Monday of the timesheet week
  days: number;                // gig days from this week on this check
  gross: number;
  perDiem: number;
  // The payday of the check it moved from (the one before), when the week has
  // been moved onto this check.
  movedFrom: string | null;
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
  weeks: WeekOnCheck[];  // the timesheet weeks on this check, oldest first
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

// The payday for a worked day: the Friday after the Sunday that closes its
// period. A gig's days stay owed, and belong in the estimate, until the
// payday for its LAST day has come.
export function payDateOf(iso: string): string {
  return addDays(periodStartOf(periodIndex(iso)), PERIOD_DAYS - 1 + PAY_LAG_DAYS);
}

export function mondayOf(iso: string): string {
  return addDays(iso, -((parseISOLocal(iso).getDay() + 6) % 7));
}

// A timesheet week is due the Monday after its Sunday.
export function timesheetDueDate(monday: string): string {
  return addDays(monday, 7);
}

// How many checks a timesheet week has moved: slippedWeeks lists a week's
// Monday once for each check it missed.
export function slipCount(slippedWeeks: readonly string[], monday: string): number {
  let n = 0;
  for (const m of slippedWeeks) if (m === monday) n++;
  return n;
}

// The payday a worked day is expected on, once any moves of its week count.
export function expectedPayDateOf(iso: string, slippedWeeks: readonly string[] = []): string {
  return addDays(payDateOf(iso), slipCount(slippedWeeks, mondayOf(iso)) * PERIOD_DAYS);
}

// The earliest payday the estimator still shows. A check stays on screen
// PAID_CHECK_GRACE_DAYS past its payday, and a gig is owed while any of its
// days pays on or after this date. The estimator and the week loader share it.
export function estimatorKeepFrom(todayIso: string): string {
  return addDays(todayIso, -PAID_CHECK_GRACE_DAYS);
}

// A booking is owed until its latest expected payday. That's usually its last
// day's, but a moved week earlier in the booking can pay later than that.
export function lastPayDateOf(b: { startDate: string; endDate: string }, slippedWeeks: readonly string[] = []): string {
  let last = payDateOf(b.endDate);
  if (slippedWeeks.length === 0) return last;
  const total = daysBetween(b.startDate, b.endDate) + 1;
  for (let i = 0; i < total && i < 400; i++) {
    const d = expectedPayDateOf(addDays(b.startDate, i), slippedWeeks);
    if (d > last) last = d;
  }
  return last;
}

// What slippedWeeks may hold: real Mondays as ISO dates, each listed once per
// check it moved (at most MAX_SLIPS_PER_WEEK), the newest 60 entries (a week
// moved longer ago than that has long since paid).
export const MAX_SLIPS_PER_WEEK = 4;
export function cleanSlippedWeeks(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const counts = new Map<string, number>();
  for (const x of v) {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) continue;
    const d = parseISOLocal(x);
    if (Number.isNaN(d.getTime()) || d.getDay() !== 1 || toISO(d) !== x) continue;
    counts.set(x, Math.min(MAX_SLIPS_PER_WEEK, (counts.get(x) || 0) + 1));
  }
  const out: string[] = [];
  for (const [monday, n] of counts) for (let i = 0; i < n; i++) out.push(monday);
  return out.sort().slice(-60);
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
// The Daily Rate SSW holds for the week containing `iso`, or 0 when the week
// isn't cached or carries no rate. A week's rate can differ from base pay (a
// rate edited on the Timesheet tab for that save, or one set in SSW), and it's
// what SSW pays that week's hours at.
function weekRateFor(iso: string, weeks: Record<string, SswWeek>): number {
  const monday = addDays(iso, -((parseISOLocal(iso).getDay() + 6) % 7));
  const rate = parseFloat(String(weeks[monday]?.dailyRate ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

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
 * from those hours (OT/DT included), at that week's own Daily Rate when SSW
 * holds one, instead of the standard 10-hour-day assumption, and its per diem
 * comes from the sheet rather than the GSA rate.
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
  // A week marked as not paid on its check lands on the next one, and one more
  // check later for each further check it missed.
  const slippedWeeks = settings.slippedWeeks || [];
  type Bucket = Map<string, GigOnCheck>;           // bookingId -> partial gig
  const periods = new Map<number, Bucket>();
  const periodWeeks = new Map<number, Map<string, WeekOnCheck>>();
  for (const b of upcoming) {
    const rate = settings.gigDayRates?.[b.bookingId] || baseRate;
    if (rate <= 0) continue;
    const c = contacts[b.bookingId];
    const perDiemRate = c?.gsaPerDiem || c?.perDiem || 0;
    const total = daysBetween(b.startDate, b.endDate) + 1;
    if (total <= 0) continue;
    for (let i = 0; i < total; i++) {
      const day = addDays(b.startDate, i);
      const monday = mondayOf(day);
      const home = periodIndex(day);
      const idx = home + slipCount(slippedWeeks, monday);
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
      let weekBucket = periodWeeks.get(idx);
      if (!weekBucket) { weekBucket = new Map(); periodWeeks.set(idx, weekBucket); }
      let week = weekBucket.get(monday);
      if (!week) {
        week = {
          monday, days: 0, gross: 0, perDiem: 0,
          // The check before this one, so Undo steps back one check at a time.
          movedFrom: idx !== home ? addDays(periodStartOf(idx - 1), PERIOD_DAYS - 1 + PAY_LAG_DAYS) : null,
        };
        weekBucket.set(monday, week);
      }
      week.days += 1;
      const grossBefore = gig.gross;
      const perDiemBefore = gig.perDiem;
      const sheet = timesheetDayFor(day, weeks);
      if (sheet) {
        // Saved hours are paid at the rate on that week's timesheet; the gig
        // override or base pay only stands in when the week carries none.
        const sheetRate = weekRateFor(day, weeks) || rate;
        gig.gross += hoursPay(sheet, sheetRate);
        gig.otPay += overtimePay(sheet, sheetRate);
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
      week.gross += gig.gross - grossBefore;
      week.perDiem += gig.perDiem - perDiemBefore;
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
      weeks: Array.from(periodWeeks.get(idx)?.values() || []).sort((a, b) => a.monday.localeCompare(b.monday)),
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
