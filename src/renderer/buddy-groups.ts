import type { Booking, FriendEntry, FriendGig } from '../shared/types';

// How the Buddy List is laid out: which of your shows it leads with, who is
// on it, and what you share with each buddy. Kept apart from FriendsTab so
// the rules can be checked without drawing anything.
//
// A buddy's gig is shared with you when it's
//   'job'  - on one of your job numbers, whatever the dates. The service
//            sends these in full, because you're booked on that job together;
//   'city' - in the city of one of your shows on overlapping dates. The
//            service sends only the city and the days you're both there, since
//            a convention city is full of unrelated shows, so these are never
//            filed under one of your jobs.
// A gig that has already ended isn't shared any more. It can still be in a
// buddy's schedule until their app next publishes.

export type SharedGig = { kind: 'job' | 'city'; gig: FriendGig; booking: Booking };

// A buddy placed in one of the list's groups, with their own dates there.
export type Placed = { buddy: FriendEntry; dates: FriendGig[] };

export type ShowGroup = { show: Booking; members: Placed[] };

export type BuddyGroups = {
  // The list leads with your earliest show that a buddy is on, in progress or
  // coming up; confirmed shows before pending requests. After it come any
  // other job numbers of yours running alongside it in the same city (one
  // show is often split across several CT job numbers). Each buddy is listed
  // once, under the first of these they're on.
  jobs: ShowGroup[];
  // Buddies in the lead show's city on its dates under a job number of
  // their own. When no buddy is on any of your jobs, the first show of yours
  // with one in town.
  town: ShowGroup | null;
  rest: FriendEntry[];
  // Every buddy's shared gigs, soonest first, by email.
  shared: Map<string, SharedGig[]>;
};

// One entry in a buddy's Buddy Info window: a job of yours they're on, with
// a line per place they work it, or a city you're both in.
export type SharedShow = {
  key: string;
  title: string;
  lines: string[];
};

export function samePlace(g: { city: string; state: string }, b: { city: string; state: string }): boolean {
  const norm = (s: string | undefined) => (s || '').trim().toLowerCase();
  return !!norm(g.city)
    && norm(g.city) === norm(b.city)
    && norm(g.state).slice(0, 2) === norm(b.state).slice(0, 2);
}

export function overlaps(g: FriendGig, b: Booking): boolean {
  return g.start <= b.endDate && b.startDate <= g.end;
}

// Your two shows run alongside each other: they overlap by more than the
// changeover day that back-to-back bookings share.
function alongside(a: Booking, b: Booking): boolean {
  if (!(a.startDate <= b.endDate && b.startDate <= a.endDate)) return false;
  if (a.startDate === b.startDate && a.endDate === b.endDate) return true;
  return a.endDate !== b.startDate && b.endDate !== a.startDate;
}

function isRequest(b: Booking): boolean {
  return /\brequest/i.test(b.status || '');
}

// `mine` is your shows that haven't ended.
export function sharedWith(f: FriendEntry, mine: Booking[], todayIso: string): SharedGig[] {
  const out: SharedGig[] = [];
  for (const g of f.gigs) {
    if (g.end < todayIso) continue;
    const sameJob = g.jobNumber ? mine.filter((b) => b.jobNumber === g.jobNumber) : [];
    if (sameJob.length > 0) {
      out.push({ kind: 'job', gig: g, booking: sameJob.find((b) => overlaps(g, b)) ?? sameJob[0] });
      continue;
    }
    const town = mine.find((b) => samePlace(g, b) && overlaps(g, b));
    if (town) out.push({ kind: 'city', gig: g, booking: town });
  }
  return out.sort((a, b) => byDates(a.gig, b.gig));
}

export function groupBuddies(buddies: FriendEntry[], mine: Booking[], todayIso: string): BuddyGroups {
  const shared = new Map(buddies.map((f) => [f.email, sharedWith(f, mine, todayIso)] as const));
  const sharedOf = (f: FriendEntry) => shared.get(f.email) ?? [];
  const placed = new Set<string>();
  // The buddies not yet listed who have a shared gig passing `test`, with
  // those gigs as their dates.
  const members = (test: (s: SharedGig) => boolean): Placed[] => buddies
    .filter((buddy) => !placed.has(buddy.email))
    .map((buddy) => ({ buddy, dates: sharedOf(buddy).filter(test).map((s) => s.gig) }))
    .filter((p) => p.dates.length > 0)
    .sort(byFirstDate);
  const onJob = (show: Booking) => (s: SharedGig) => s.kind === 'job' && s.gig.jobNumber === show.jobNumber;
  const inTown = (show: Booking) => (s: SharedGig) =>
    s.kind === 'city' && samePlace(s.gig, show) && overlaps(s.gig, show);
  const list = (show: Booking, test: (s: SharedGig) => boolean): ShowGroup | null => {
    const found = members(test);
    found.forEach((p) => placed.add(p.buddy.email));
    return found.length > 0 ? { show, members: found } : null;
  };

  // In progress sorts ahead of coming up, since it started sooner. Job number
  // breaks ties so the order never depends on how the calendar listed them.
  const shows = [...mine].sort((a, b) =>
    Number(isRequest(a)) - Number(isRequest(b))
    || a.startDate.localeCompare(b.startDate)
    || a.endDate.localeCompare(b.endDate)
    || (a.jobNumber || '').localeCompare(b.jobNumber || ''));
  const lead = shows.find((show) => members(onJob(show)).length > 0);
  const jobs: ShowGroup[] = [];
  let town: ShowGroup | null = null;
  if (lead) {
    for (const show of shows) {
      const withLead = show === lead
        || (isRequest(show) === isRequest(lead) && samePlace(show, lead) && alongside(show, lead));
      if (!withLead) continue;
      const g = list(show, onJob(show));
      if (g) jobs.push(g);
    }
    town = list(lead, inTown(lead));
  } else {
    for (const show of shows) {
      town = list(show, inTown(show));
      if (town) break;
    }
  }
  return {
    jobs,
    town,
    rest: sortRest(buddies.filter((f) => !placed.has(f.email)), sharedOf),
    shared,
  };
}

// A buddy's shared shows, soonest first: each job of yours they're on, with
// a line of dates per place they work it, and each city you're both in.
export function sharedShows(shared: SharedGig[]): SharedShow[] {
  const out: Array<{ key: string; title: string; jobNumber: string; gigs: FriendGig[]; city: boolean }> = [];
  const seen = new Map<string, FriendGig[]>();
  for (const s of shared) {
    const city = s.kind === 'city';
    const key = city ? `city:${placeLabel(s.gig).toLowerCase()}` : `job:${s.gig.jobNumber}`;
    const had = seen.get(key);
    if (had) { had.push(s.gig); continue; }
    const gigs = [s.gig];
    seen.set(key, gigs);
    const title = city
      ? `In ${placeLabel(s.gig)}`
      : s.gig.jobName || s.booking.jobName || s.gig.jobNumber;
    out.push({ key, title, jobNumber: city ? '' : s.gig.jobNumber, gigs, city });
  }
  const named = jobTitles(out.map((o) => ({ name: o.title, jobNumber: o.jobNumber })));
  return out.map(({ key, gigs, city }, i) => {
    const title = named[i];
    if (city) return { key, title, lines: [`${fmtDates(gigs)} · same city, same dates`] };
    const byPlace = new Map<string, FriendGig[]>();
    for (const g of gigs) {
      const place = placeLabel(g);
      byPlace.set(place, [...(byPlace.get(place) ?? []), g]);
    }
    const lines = [...byPlace].map(([place, at]) => `${fmtDates(at)}${place ? ` · ${place}` : ''}`);
    return { key, title, lines };
  });
}

// Job names, with the job number added to any that two jobs share, so two
// of your job numbers for one show don't read as the same job twice.
export function jobTitles(jobs: Array<{ name: string; jobNumber: string }>): string[] {
  return jobs.map(({ name, jobNumber }) =>
    jobNumber && jobs.some((o) => o.jobNumber !== jobNumber && o.name === name)
      ? `${name} (${jobNumber})`
      : name);
}

export function placeLabel(g: { city: string; state: string }): string {
  return [g.city, g.state].map((s) => (s || '').trim()).filter(Boolean).join(', ');
}

// "9/21 – 9/22", or "9/21" for one day.
export function fmtRange(start: string, end: string): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  };
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}

// Date ranges that overlap or run on from one another read as one: two
// bookings on a job share their changeover day, and the same gig can arrive
// twice from a buddy's two devices.
export function fmtDates(dates: Array<{ start: string; end: string }>): string {
  const runs: Array<{ start: string; end: string }> = [];
  for (const d of [...dates].sort(byDates)) {
    const last = runs[runs.length - 1];
    if (last && d.start <= dayAfter(last.end)) {
      if (d.end > last.end) last.end = d.end;
    } else {
      runs.push({ start: d.start, end: d.end });
    }
  }
  return runs.map((r) => fmtRange(r.start, r.end)).join(', ');
}

// Local calendar day as "YYYY-MM-DD", the form gig and booking dates use.
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayAfter(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if ([y, m, d].some((n) => !Number.isFinite(n))) return iso;
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function byDates(a: { start: string; end: string }, b: { start: string; end: string }): number {
  return a.start.localeCompare(b.start) || a.end.localeCompare(b.end);
}

function byFirstDate(a: Placed, b: Placed): number {
  return byDates(a.dates[0], b.dates[0]) || a.buddy.name.localeCompare(b.buddy.name);
}

// Buddies you share something with later float to the top, soonest first;
// everyone else follows alphabetically.
function sortRest(buddies: FriendEntry[], sharedOf: (f: FriendEntry) => SharedGig[]): FriendEntry[] {
  return [...buddies].sort((a, b) => {
    const sa = sharedOf(a)[0]?.gig.start ?? '';
    const sb = sharedOf(b)[0]?.gig.start ?? '';
    if (!!sa !== !!sb) return sa ? -1 : 1;
    if (sa && sb && sa !== sb) return sa.localeCompare(sb);
    return a.name.localeCompare(b.name);
  });
}
