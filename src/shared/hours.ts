// Hours math for a timesheet week, shared by the timesheet UI, the paycheck
// estimator, and both save paths.
//
// SSW does NOT reliably compute the reg/OT/DT split for a week the app saves:
// its own page's JavaScript fills those cells before submitting, so a week
// saved through the app came back with TotalHrsWorked right and the three
// buckets all zero — and everything downstream that reads the buckets (the
// estimator's overtime, the pay preview) saw no overtime at all. The split is
// therefore derived here.
//
// The pay rules, from CT's note to crew, applied per Monday–Sunday week:
//  - the hourly base rate is the day rate / 11, and a worked day is guaranteed
//    10 hours: 8 reg + 2 OT, which is 11 straight-time hours, the day rate;
//  - overtime (1.5x) after 8 hours a day, double time (2x) after 12;
//  - overtime after 40 regular hours in the week, the guaranteed hours
//    counting toward the 40, so from the sixth worked day on it's all OT;
//  - on the seventh consecutive workday, overtime from the first hour and
//    double time after 8.
// SSW's stored split for the week of May 18 follows these to the hour: a
// 6-hour Friday went in as 8 reg + 2 OT, and the Saturday after it, with 40
// regular hours already in the week, as 10 OT.
//   Mon 11h -> 8 / 3 / 0    Fri 6h -> 8 / 2 / 0    Sat 10h -> 0 / 10 / 0
//
// A day's split depends on the days before it, so the whole week is always
// derived again rather than kept from what SSW stored: a stored split can
// predate an edit to an earlier day, and weeks the app saved before these
// rules carry per-day splits with no weekly 40 and no guarantee.
//
// A day with only one of its two times filled in is a day still in progress
// (or half-entered), not a worked day. SSW's spreadsheet treats the blank end
// as midnight and reports "8:00 am –" as SIXTEEN hours, and a split derived
// from that total paid four hours of double time for a day that had barely
// started. So nothing here trusts a total until both times are present; such
// a day carries no payable hours and the estimator prices it as a standard day.

import type { SswDay } from './types';

export type HoursSplit = { reg: number; ot: number; dt: number };

// The hours a worked day is paid at least.
export const GUARANTEED_DAY_HOURS = 10;
const WEEKLY_REG_HOURS = 40;

// "8:00 am" / "12:30 pm" -> minutes from midnight, or null if unparseable.
export function parseTime(t: string): number | null {
  const m = (t || '').match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

// Worked hours = end - start - lunch. 0 when start or end is blank.
export function workedHours(d: Pick<SswDay, 'startTime' | 'endTime' | 'lunchStart' | 'lunchEnd'>): number {
  const start = parseTime(d.startTime);
  const end = parseTime(d.endTime);
  if (start == null || end == null) return 0;
  let mins = end - start;
  if (mins < 0) mins += 24 * 60;             // crossed midnight
  const lunchStart = parseTime(d.lunchStart);
  const lunchEnd = parseTime(d.lunchEnd);
  if (lunchStart != null && lunchEnd != null) {
    let lunch = lunchEnd - lunchStart;
    // A break across midnight (11:30 pm – 12:30 am) wraps like the shift, but
    // only on a shift that crosses midnight and only when the wrapped break
    // fits inside it: "11:30 pm – 12:30 pm" is a mistyped lunch out, not a
    // thirteen-hour break.
    if (lunch < 0 && end < start && lunch + 24 * 60 <= mins) lunch += 24 * 60;
    mins -= Math.max(0, lunch);
  }
  return Math.max(0, mins / 60);
}

// One day's hours by the daily rule alone: 8 reg, the next 4 OT, past 12 DT.
function dailySplit(hours: number): HoursSplit {
  return {
    reg: Math.min(8, hours),
    ot: Math.min(4, Math.max(0, hours - 8)),
    dt: Math.max(0, hours - 12),
  };
}

// Split a week of worked hours by the pay rules. `hours` runs Monday first,
// one entry per day, 0 for a day not worked; the result lines up with it.
export function splitWorkweek(hours: readonly number[]): HoursSplit[] {
  let weekReg = 0;
  let streak = 0;
  return hours.map((h) => {
    if (!(h > 0)) {
      streak = 0;
      return { reg: 0, ot: 0, dt: 0 };
    }
    streak += 1;
    const paid = Math.max(GUARANTEED_DAY_HOURS, h);
    if (streak >= 7) return { reg: 0, ot: Math.min(8, paid), dt: Math.max(0, paid - 8) };
    const day = dailySplit(paid);
    const reg = Math.min(day.reg, Math.max(0, WEEKLY_REG_HOURS - weekReg));
    weekReg += reg;
    return { reg, ot: day.ot + day.reg - reg, dt: day.dt };
  });
}

// Both a start and an end time are present. Only then does a total (SSW's or
// ours) describe a finished day — see the note at the top of the file.
export function hasBothTimes(d: Pick<SswDay, 'startTime' | 'endTime'>): boolean {
  return !!(d.startTime && d.startTime.trim()) && !!(d.endTime && d.endTime.trim());
}

// The hours a finished day is priced at. The two times are the source of
// truth — they are what the user edits, and a cached total goes stale the
// moment they change — with SSW's total as the fallback when the times are
// present but in a form parseTime can't read. 0 for a day missing a time.
export function pricedHours(d: SswDay): number {
  if (!hasBothTimes(d)) return 0;
  const fromTimes = workedHours(d);
  return fromTimes > 0 ? fromTimes : Math.max(0, d.totalHours);
}

// Monday = 0 … Sunday = 6, read off the ISO date itself.
function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// A timesheet week's days with their reg/OT/DT filled in by the pay rules.
// A finished day's total becomes the hours its times describe; a day missing
// either time gets no split at all, whatever SSW stored for it. Days come back
// in the order given, as new objects wherever anything changed, so callers
// never mutate cached data.
export function splitWeek(days: readonly SswDay[]): SswDay[] {
  const hours = [0, 0, 0, 0, 0, 0, 0];
  for (const d of days) {
    const i = weekdayIndex(d.date);
    if (i >= 0 && i < 7) hours[i] = pricedHours(d);
  }
  const split = splitWorkweek(hours);
  return days.map((d) => {
    const priced = pricedHours(d);
    const s = (priced > 0 && split[weekdayIndex(d.date)]) || { reg: 0, ot: 0, dt: 0 };
    const total = priced > 0 ? priced : d.totalHours;
    if (d.regHours === s.reg && d.otHours === s.ot && d.dtHours === s.dt && d.totalHours === total) return d;
    return { ...d, regHours: s.reg, otHours: s.ot, dtHours: s.dt, totalHours: total };
  });
}
