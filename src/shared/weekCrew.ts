import type { Booking, SswDay, WeekCrew } from './types';

// Who a timesheet week lists as project manager and labor coordinator.
//
// These two names belong to the GIG, not to the person filling the sheet, so
// they are derived from the week's own booking every time and never carried
// over from another week. A blank is a real answer — "this gig lists nobody" —
// and must not be filled in from an older timesheet. SSW's own Add button, and
// createWeek before this module existed, copied them off the most recently
// edited record, which put a stranger's name on a new week.
//
// The worker holds no booking data, so the client sends it the answer
// (cfg.weekCrew in worker-api/src/ssw.ts) rather than working it out there.
export type { WeekCrew };

export const NO_CREW: WeekCrew = { projectManager: '', laborCoordinator: '' };

// A pending request, which only counts when no confirmed gig is in the running.
// Same test as expense-logic.ts currentGigFor and city-view.ts cityViewGig.
const isRequest = (b: Booking) => /\brequest/i.test(b.status || '');

const jobKey = (job: string) => (job || '').trim().toUpperCase();

const covers = (b: Booking, iso: string) => b.startDate <= iso && iso <= b.endDate;

// Of several bookings in the running, the one a timesheet follows: a confirmed
// gig over a pending request, then the one that STARTS latest. On a changeover
// day the gig beginning that day is the one you travel to, which is how the
// day's own show is already picked (bookingsCoveringDate's sort in
// TimesheetTab.tsx).
function bestOf(candidates: Booking[]): Booking | null {
  const confirmed = candidates.filter((b) => !isRequest(b));
  const pool = confirmed.length > 0 ? confirmed : candidates;
  return pool.slice().sort((a, b) => b.startDate.localeCompare(a.startDate))[0] ?? null;
}

// The gig a week's crew comes from, read in the order the week itself reads:
//   1. the first worked day's show (past or today) — what the week is billing;
//   2. else the first day with any show on it, including an upcoming one;
//   3. else, on a week with no show on it yet — which is every week at the
//      moment it is created — the earliest day of the week a gig covers.
//
// A day's show is identified by its job number, so only a gig carrying that
// job may speak for it: a job that matches no gig yields nobody rather than
// the wrong person, even when some other gig happens to cover that day. Step 3
// is reached only by a week with no show on it anywhere, never as a fallback
// for a job that didn't resolve. CARL splits one show into several bookings
// (one per date range and position), and those can disagree about the PM, so
// the gig covering that very day wins over one that merely shares the job.
export function primaryGigForWeek(
  days: ReadonlyArray<Pick<SswDay, 'date' | 'job'>>,
  bookings: readonly Booking[],
  todayIso: string,
): Booking | null {
  const all = bookings.slice();
  const forJob = (job: string, iso: string) => {
    const want = jobKey(job);
    if (!want) return null;
    const sameJob = all.filter((b) => jobKey(b.jobNumber) === want);
    return bestOf(sameJob.filter((b) => covers(b, iso))) ?? bestOf(sameJob);
  };
  const dated = days.filter((d) => !!d.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  const worked = dated.filter((d) => d.job && d.date <= todayIso);
  const withJob = dated.filter((d) => d.job);
  for (const d of [...worked, ...withJob]) {
    const gig = forJob(d.job, d.date);
    if (gig) return gig;
  }
  // Only a week carrying no show at all falls through to "whichever gig covers
  // the week": with a show on it, that show is the week's identity, and a gig
  // the week isn't billing must not put its people on the sheet.
  if (withJob.length > 0) return null;
  for (const d of dated) {
    const gig = bestOf(all.filter((b) => covers(b, d.date)));
    if (gig) return gig;
  }
  return null;
}

// What a crew name may hold. CARL writes these into one line of the iCal
// description, so anything strange in it is a parse artifact rather than a
// person: too long, or carrying control or invisible characters (a zero-width
// space would land in SSW looking just like the real name), reads as nobody.
// The worker re-runs this on whatever a client sends it.
export const CREW_NAME_MAX = 80;

export function cleanCrewName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const n = raw.trim();
  if (!n || n.length > CREW_NAME_MAX) return '';
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(n) ? '' : n;
}

// The two names a gig puts on a timesheet. No gig means nobody, which is
// exactly what a week with no show on it should carry.
export function crewOf(gig: Booking | null): WeekCrew {
  if (!gig) return NO_CREW;
  return {
    projectManager: cleanCrewName(gig.projectManager),
    laborCoordinator: cleanCrewName(gig.laborCoordinator),
  };
}

// The crew for a week that already has days on it.
export function crewForWeek(
  days: ReadonlyArray<Pick<SswDay, 'date' | 'job'>>,
  bookings: readonly Booking[],
  todayIso: string,
): WeekCrew {
  return crewOf(primaryGigForWeek(days, bookings, todayIso));
}

// The seven dates of a week, Monday first.
function weekDates(weekStartDate: string): string[] {
  const [y, m, d] = weekStartDate.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + i);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
  }
  return out;
}

// The crew for a week being created, which has no days yet: the gig covering
// the earliest day of that week. This is what both backends are handed, so a
// new timesheet starts with its own gig's people or with nobody at all.
export function crewForNewWeek(weekStartDate: string, bookings: readonly Booking[]): WeekCrew {
  return crewForWeek(weekDates(weekStartDate).map((date) => ({ date, job: '' })), bookings, weekStartDate);
}
