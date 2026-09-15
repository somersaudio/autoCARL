// Which timesheet days SSW holds as a day off. Shared by the Timesheet tab,
// which leaves a day off empty instead of autofilling it, and the paycheck
// estimator, which pays nothing for it.
//
// SSW keeps no "day off" flag: a day saved without hours looks much like a day
// nobody has filled in yet. Two things tell them apart:
//  - A job with no times. Since days off could be saved, nothing else leaves
//    that shape: a save blanks days still ahead entirely, a new week starts
//    blank, and autofill fills a job together with its times. Before commit
//    1da102a (Sep 14, 2026), though, an evening save from the web app wrote
//    the next day's preview job with no times, so a job alone only counts
//    from JOB_WITHOUT_TIMES_OFF_FROM, the day after the change shipped.
//  - A later day of the same week, already past, with a time. That day was
//    past (or today) when the week was saved, so this one was past too, and
//    autofill fills every booked past day unless someone emptied it. This is
//    what catches a day off saved as "— no work —", which leaves no job.
// A blank day with nothing saved after it can't be told from a day never
// touched, so it doesn't count.

import type { SswDay } from './types';

export const JOB_WITHOUT_TIMES_OFF_FROM = '2026-09-16';

// The dates in one saved week, past days and today only, that it holds as a
// day off. `todayIso` is the local date, YYYY-MM-DD.
export function savedDaysOff(days: readonly SswDay[], todayIso: string): Set<string> {
  const off = new Set<string>();
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let timeLater = false;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const d = sorted[i];
    const hasTime = !!(d.startTime || d.endTime);
    if (!hasTime && d.date <= todayIso && (timeLater || (!!d.job && d.date >= JOB_WITHOUT_TIMES_OFF_FROM))) {
      off.add(d.date);
    }
    if (hasTime && d.date <= todayIso) timeLater = true;
  }
  return off;
}
