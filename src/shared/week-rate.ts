// Which day rate a timesheet week saves with. Rates belong to shows, not to
// weeks: a gig's own rate (set on the Timesheet tab, or on its chip in the
// paycheck estimator, stored as gigDayRates) when it has one, else base pay.
// Every save writes it, so a rate SSW merely copied into a new week can never
// stick (see saveDailyRate in worker-api/src/ssw.ts and src/main/ssw.ts).

import type { Booking, SswWeek } from './types';

export function localTodayIso(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The show a week belongs to: the first worked (today or past) day with a
// job, else the first upcoming day with one. The same rule the Timesheet tab
// uses to sync the week's position, PM and LC.
export function primaryJobOf(week: Pick<SswWeek, 'days'>, todayIso: string): string {
  return week.days.find((d) => !!d.job && d.date <= todayIso)?.job
    ?? week.days.find((d) => !!d.job)?.job
    ?? '';
}

export function expectedWeekRate(
  week: Pick<SswWeek, 'days'>,
  bookings: Booking[],
  rates: { basePayDayRate: number; defaultDailyRate?: number; gigDayRates?: Record<string, number> },
  todayIso: string,
): { rate: number; bookingId: string | null } {
  const job = primaryJobOf(week, todayIso);
  const matches = job ? bookings.filter((b) => b.jobNumber === job) : [];
  for (const b of matches) {
    const own = rates.gigDayRates?.[b.bookingId];
    if (typeof own === 'number' && own > 0) return { rate: own, bookingId: b.bookingId };
  }
  const legacy = rates.defaultDailyRate ?? 0;
  const base = legacy > 0 ? legacy : (rates.basePayDayRate > 0 ? rates.basePayDayRate : 0);
  return { rate: base, bookingId: matches[0]?.bookingId ?? null };
}
