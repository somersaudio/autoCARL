// Hours math for a timesheet day, shared by the timesheet UI, the paycheck
// estimator, and both save paths.
//
// SSW does NOT reliably compute the reg/OT/DT split for a week the app saves:
// its own page's JavaScript fills those cells before submitting, so a week
// saved through the app came back with TotalHrsWorked right and the three
// buckets all zero — and everything downstream that reads the buckets (the
// estimator's overtime, the pay preview) saw no overtime at all. The split is
// therefore derived here, from the same rule SSW applies on its own page.
//
// The rule, read straight off weeks SSW split itself: 8 hours regular, the
// next 4 at overtime, anything past 12 at double time.
//   10h  -> 8 / 2 / 0      12h -> 8 / 4 / 0      16h -> 8 / 4 / 4
//
// One known approximation: SSW moved a Saturday's hours past 10 into double
// time (a sixth-consecutive-day rule, most likely). A split SSW has actually
// stored always wins over this derivation, so that only affects a week SSW
// left blank.

import type { SswDay } from './types';

export type HoursSplit = { reg: number; ot: number; dt: number };

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
  if (lunchStart != null && lunchEnd != null) mins -= Math.max(0, lunchEnd - lunchStart);
  return Math.max(0, mins / 60);
}

// Split a day's worked hours the way SSW does.
export function splitWorkedHours(hours: number): HoursSplit {
  if (!(hours > 0)) return { reg: 0, ot: 0, dt: 0 };
  return {
    reg: Math.min(8, hours),
    ot: Math.min(4, Math.max(0, hours - 8)),
    dt: Math.max(0, hours - 12),
  };
}

// True when SSW handed back a day with hours on it but none of them sorted
// into a bucket — the exact shape a save through the app produces.
export function splitIsMissing(d: SswDay): boolean {
  return d.regHours + d.otHours + d.dtHours === 0 && (d.totalHours > 0 || workedHours(d) > 0);
}

// The day's split: SSW's own when it stored one, otherwise derived from its
// total (or, failing that, from the times). Returned as a new day so callers
// never mutate cached data.
export function withSplit(d: SswDay): SswDay {
  if (!splitIsMissing(d)) return d;
  const hours = d.totalHours > 0 ? d.totalHours : workedHours(d);
  const s = splitWorkedHours(hours);
  return { ...d, regHours: s.reg, otHours: s.ot, dtHours: s.dt, totalHours: hours };
}

// CT's pay rule for the timesheet's own totals line: a worked day is paid at a
// 10-hour minimum (8 reg + 2 OT). Display only — the estimator and the save
// path use the plain split above, which is what SSW itself stores.
export function ctSplit(d: SswDay): HoursSplit & { total: number } {
  const raw = workedHours(d);
  if (raw === 0) return { reg: 0, ot: 0, dt: 0, total: 0 };
  const s = splitWorkedHours(Math.max(10, raw));
  return { ...s, total: s.reg + s.ot + s.dt };
}
