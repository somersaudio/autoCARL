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
// stored wins over this derivation — but only while it still adds up to the
// day's hours. The times are what the user edits, and a split stored for an
// earlier version of the day (8/4/4 from a 16-hour phantom, say, after the
// end time was corrected to make it 14) is stale, not authoritative: it gets
// re-derived from the hours the times actually describe.
//
// A day with only one of its two times filled in is a day still in progress
// (or half-entered), not a worked day. SSW's spreadsheet treats the blank end
// as midnight and reports "8:00 am –" as SIXTEEN hours, and a split derived
// from that total paid four hours of double time for a day that had barely
// started. So nothing here trusts a total, or a stored split, until both
// times are present; such a day carries no payable hours and the estimator
// prices it as a standard day.

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

// True when a finished day's stored split can't be used: either none of its
// hours sorted into a bucket (the shape a save through the app used to
// produce) or the buckets add up to a different day than the times describe
// (a split left over from before the times were edited).
export function splitIsMissing(d: SswDay): boolean {
  const hours = pricedHours(d);
  if (hours <= 0) return false;
  return Math.abs(d.regHours + d.otHours + d.dtHours - hours) > 0.01;
}

// The day's split: SSW's own when it stored one that still adds up to the
// day's hours, otherwise derived from those hours. A day missing either time
// gets no split at all, whatever SSW stored for it. Returned as a new day so
// callers never mutate cached data.
export function withSplit(d: SswDay): SswDay {
  if (!hasBothTimes(d)) {
    if (d.regHours === 0 && d.otHours === 0 && d.dtHours === 0) return d;
    return { ...d, regHours: 0, otHours: 0, dtHours: 0 };
  }
  if (!splitIsMissing(d)) return d;
  const hours = pricedHours(d);
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
