// Turn an airline itinerary's text into the journeys it actually books.
//
// One itinerary often covers more than one gig: John's Southwest booking
// AQET8Z flies AUS→BOS on 9/6 for a Boston show and BOS→SFO on 9/11 for the
// San Francisco show that follows. So the unit that matters is the JOURNEY
// (the flight you take on a given day, ignoring connections), not the file.
//
// Two Southwest layouts are in play: multi-city ("Flight 1 9/6/26 …
// Flight 2 9/11/26") and round trip ("Departing 5/26/26 … Returning
// 6/4/26"). Both list per-segment DEPARTS/ARRIVES pairs and a trip-summary
// route ("AUS BOS SFO" / "AUS LAS"), which is what splits segments into
// journeys — connections chain airport-to-airport and can't be told from
// journey boundaries any other way.

export type ItineraryLeg = {
  date: string;      // ISO YYYY-MM-DD
  from: string;      // IATA
  to: string;        // IATA
  via?: string[];    // connecting stops, in order
};

export type ParsedItinerary = {
  confirmation?: string;
  legs: ItineraryLeg[];
};

// Month abbreviations look exactly like airport codes; the trip summary is
// full of them ("SEP 6 - 11 AUS BOS SFO"). Treating them as airports is how
// a leg ends up claiming to depart from "MAY".
const MONTHS = new Set([
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
]);

// "9/6/26" / "9/6/2026" → "2026-09-06"
function toIso(raw: string): string | null {
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Journey dates, in itinerary order.
function journeyDates(text: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const iso = toIso(raw);
    if (iso && !out.includes(iso)) out.push(iso);
  };
  // Multi-city: "Flight 1 9/6/26 Sunday"
  for (const m of text.matchAll(/\bFlight\s+\d+\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/g)) push(m[1]);
  if (out.length > 0) return out;
  // Round trip: "Departing 5/26/26 Tuesday … Returning 6/4/26 Thursday"
  const dep = text.match(/\bDepart(?:ing|s)?\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const ret = text.match(/\bReturn(?:ing|s)?\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (dep) push(dep[1]);
  if (ret) push(ret[1]);
  return out;
}

// Per-segment hops: "DEPARTS BOS … ARRIVES MDW".
function segments(text: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const m of text.matchAll(/DEPARTS\s+([A-Z]{3})[\s\S]{0,400}?ARRIVES\s+([A-Z]{3})/g)) {
    out.push({ from: m[1], to: m[2] });
  }
  return out;
}

// The trip-summary route: airport codes listed beside the confirmation.
// Filtered against the codes that actually appear in the segments, because
// the summary text is littered with three-letter words ("PASSENGERS EST.
// POINTS") that look exactly like airport codes.
function routeWaypoints(text: string, known: Set<string>): string[] {
  const start = text.search(/CONFIRMATION\s*#/i);
  if (start < 0) return [];
  const window = text.slice(start, start + 220);
  const codes: string[] = [];
  for (const m of window.matchAll(/\b([A-Z]{3})\b/g)) {
    const code = m[1];
    if (MONTHS.has(code) || !known.has(code)) continue;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

// Where each journey ENDS. Connections chain airport-to-airport exactly like
// journey boundaries do, so the segment list alone can't be split — the
// summary route is what says BOS is a destination and MDW a connection.
function journeyStops(
  segs: Array<{ from: string; to: string }>,
  waypoints: string[],
  dateCount: number,
): string[] {
  if (segs.length === 0 || dateCount === 0) return [];
  const origin = segs[0].from;
  // One journey: it simply ends where the last segment lands.
  if (dateCount === 1) return [segs[segs.length - 1].to];
  // Multi-city, e.g. AUS BOS SFO for two journeys — trust it only when it
  // starts where the first segment departs.
  if (waypoints.length - 1 === dateCount && waypoints[0] === origin) {
    return waypoints.slice(1);
  }
  // Round trip. The summary may list the route from either end (a re-issued
  // return document leads with the inbound), so take the destination as
  // whichever waypoint isn't home rather than trusting the order.
  if (dateCount === 2) {
    const dest = waypoints.find((w) => w !== origin)
      || segs.find((sg) => sg.to !== origin)?.to;
    if (dest) return [dest, origin];
  }
  return [];
}

export function parseItinerary(rawText: string): ParsedItinerary {
  const text = rawText.replace(/\s+/g, ' ');
  const confirmation = text.match(/CONFIRMATION\s*#\s*([A-Z0-9]{5,8})\b/i)?.[1];
  const dates = journeyDates(text);
  const segs = segments(text);
  const known = new Set<string>();
  for (const sg of segs) { known.add(sg.from); known.add(sg.to); }
  const waypoints = routeWaypoints(text, known);

  if (dates.length === 0 || segs.length === 0) return { confirmation, legs: [] };

  const stops = journeyStops(segs, waypoints, dates.length);

  // Walk the segments, cutting a journey each time we land on the next stop.
  const legs: ItineraryLeg[] = [];
  let idx = 0;
  for (const stop of stops) {
    if (idx >= segs.length) break;
    const from = segs[idx].from;
    const via: string[] = [];
    let to = segs[idx].to;
    while (idx < segs.length) {
      to = segs[idx].to;
      idx++;
      if (to === stop) break;
      via.push(to);
    }
    const date = dates[legs.length];
    if (!date) break;
    legs.push({ date, from, to, ...(via.length ? { via } : {}) });
  }

  return { confirmation, legs };
}

// ---- matching a travel day against every itinerary on file ----------------
//
// The itinerary that books a leg is often filed under a DIFFERENT gig: the
// Boston show's confirmation carries the 9/11 BOS→SFO flight that gets John
// to Dreamforce. So a job asks "is my travel day ticketed?" against every
// itinerary, not just its own.

export type ItinerarySource = {
  bookingId: string;
  jobName?: string;
  vendor?: string;
  confirmation?: string;
  legs: ItineraryLeg[];
};

export type LegMatch = {
  leg: ItineraryLeg;
  vendor?: string;
  confirmation?: string;
  bookingId: string;
  jobName?: string;
  /** true when the itinerary belongs to a different booking than the one asking */
  borrowed: boolean;
  /** the DATE matched but neither endpoint did — a flight that day, route unclaimed */
  loose: boolean;
};

// Find the itinerary journey that covers a travel day. The date must match;
// beyond that, a journey that both leaves and arrives where we expect beats
// one that only matches at one end (a return leg can share a date with an
// outbound in a re-issued document).
export function matchLeg(
  opts: { date: string; from?: string; to?: string; bookingId: string },
  sources: ItinerarySource[],
): LegMatch | null {
  let best: LegMatch | null = null;
  let bestScore = -1;
  for (const src of sources) {
    for (const leg of src.legs) {
      if (leg.date !== opts.date) continue;
      const toHit = !!opts.to && leg.to === opts.to;
      const fromHit = !!opts.from && leg.from === opts.from;
      if (!toHit && src.bookingId !== opts.bookingId) continue;
      // Both ends matching is a certainty; one end is still a real match (the
      // other side may be "home", with no airport code to compare). Neither
      // end matching is kept as a LOOSE match — there is a flight that day,
      // but we won't claim its route: crews fly into a neighbouring airport
      // often enough (OAK for SFO) that dropping it would hide a real ticket.
      const score = (toHit ? 2 : 0) + (fromHit ? 1 : 0);
      // Another gig's itinerary only counts when the flight ARRIVES where
      // this gig is. Sharing a date, or even a departure airport, proves
      // nothing: two trips can leave the same city the same morning, and
      // matching on that claims a flight for what is really a car ride.
      if (score > bestScore) {
        bestScore = score;
        best = {
          leg,
          vendor: src.vendor,
          confirmation: src.confirmation,
          bookingId: src.bookingId,
          jobName: src.jobName,
          borrowed: src.bookingId !== opts.bookingId,
          loose: score === 0,
        };
      }
    }
  }
  return best;
}

// ---- a ticket for the wrong day -------------------------------------------
//
// When a gig's dates move, the flight already bought doesn't move with it.
// Google AITE slid a day later (travel out Thu 9/24 became Fri 9/25) while
// its itinerary still flies SJC->AUS on 9/24. matchLeg requires the date, so
// it found nothing and the travel row quietly lost its ticket. This finds
// that ticket, the same trip on a nearby day, so the card can say the flight
// needs to be changed.
//
// It is deliberately stricter than matchLeg, because a false "needs to be
// changed" sends someone chasing a travel coordinator for nothing:
//  - the leg must run in this travel day's direction: land at this gig's
//    airport on the way in, leave it on the way out. On this booking's OWN
//    itinerary a flight between a neighbouring airport and the right far
//    end also counts (OAK->AUS for an SFO show), as matchLeg allows;
//  - the far end must match whenever it's a real airport code;
//  - another booking's itinerary counts only when BOTH ends match, within a
//    few days; otherwise a nearby flight between the same cities is just
//    someone else's trip;
//  - a leg the caller says is spoken for (another booking's own travel day,
//    or this card's other row) is never claimed.

export type DateMismatch = LegMatch & {
  /** days from the travel day to the ticket's day: -1 = the flight is a day early */
  offsetDays: number;
};

const OWN_WINDOW_DAYS = 7;
const BORROWED_WINDOW_DAYS = 3;
const IATA_CODE = /^[A-Z]{3}$/;

function isoDayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return NaN;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000);
}

export function findRebookNeeded(
  opts: {
    date: string;
    from: string;
    to: string;
    side: 'arrive' | 'depart';
    bookingId: string;
    isClaimed?: (leg: ItineraryLeg, src: ItinerarySource) => boolean;
  },
  sources: ItinerarySource[],
): DateMismatch | null {
  const here = opts.side === 'arrive' ? opts.to : opts.from;
  const there = opts.side === 'arrive' ? opts.from : opts.to;
  const day = isoDayNumber(opts.date);
  if (!Number.isFinite(day)) return null;
  const hereKnown = IATA_CODE.test(here);
  const thereKnown = IATA_CODE.test(there);

  let best: DateMismatch | null = null;
  let bestRank = Infinity;
  for (const src of sources) {
    const own = src.bookingId === opts.bookingId;
    for (const leg of src.legs) {
      if (leg.date === opts.date) continue;          // same day is matchLeg's call
      const legHere = opts.side === 'arrive' ? leg.to : leg.from;
      const legThere = opts.side === 'arrive' ? leg.from : leg.to;
      const hereHit = hereKnown && legHere === here;
      const thereHit = thereKnown && legThere === there;
      let ok: boolean;
      if (own) {
        // Right gig end, far end matching or unknown ("home" with no airport
        // set) — or a neighbouring airport with the far end matching.
        ok = (hereHit && (!thereKnown || thereHit)) || (!hereHit && thereHit);
      } else {
        ok = hereHit && thereHit;
      }
      if (!ok) continue;
      const offset = isoDayNumber(leg.date) - day;
      if (!Number.isFinite(offset) || offset === 0) continue;
      if (Math.abs(offset) > (own ? OWN_WINDOW_DAYS : BORROWED_WINDOW_DAYS)) continue;
      if (opts.isClaimed?.(leg, src)) continue;
      // Closest day first; then this booking's own itinerary; then both ends.
      const rank = Math.abs(offset) * 4 + (own ? 0 : 2) + (hereHit && thereHit ? 0 : 1);
      if (rank < bestRank) {
        bestRank = rank;
        best = {
          leg,
          vendor: src.vendor,
          confirmation: src.confirmation,
          bookingId: src.bookingId,
          jobName: src.jobName,
          borrowed: !own,
          loose: false,
          offsetDays: offset,
        };
      }
    }
  }
  return best;
}
