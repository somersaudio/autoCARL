import { useEffect, useState } from 'react';
import type {
  Booking, BookingContacts, BookingContactsCache, FlightPdf, FlightsCache, HotelBooking,
  SswWeek, UserSettings,
} from '../shared/types';
import { buildPaychecks, money, type Paycheck } from '../shared/paychecks';
import { placeLabel } from '../shared/airports';
import { matchLeg, type ItinerarySource, type LegMatch } from '../shared/flight-itinerary';

type Props = {
  bookings: Booking[];
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
  flights: FlightsCache;
  contacts: BookingContactsCache;
  settings: UserSettings;
  sswWeeks: Record<string, SswWeek>;
  onSetDayRate: (bookingId: string, rate: number | null) => void;
  onRefresh: () => void | Promise<void>;
  onResetSetup: () => void;
};

const NO_CONTACTS: BookingContacts = { pmEmail: '', lcEmail: '' };

// CARL publishes pending gig requests to the calendar feed with a "Request"
// status — they need an accept/deny on the booking-details page before they
// become real bookings, so the cards flag them loudly.
function isRequest(b: Booking): boolean {
  return /\brequest/i.test(b.status);
}

// ---- travel ribbon -------------------------------------------------------
// A booking's own dates are TRAVEL-INCLUSIVE (that's what CARL publishes to
// the calendar feed); the sweep scrapes the job's real start/end. The gap at
// each end is therefore a travel day — and when there's no gap, you're
// travelling and working the same day, which is the day worth flagging.
//
// Where a leg goes: if the neighbouring gig travels on the very same date,
// it's a direct connection and we name that city's airport. Otherwise you're
// heading home.

type TravelLeg = {
  date: string;
  from: string;
  to: string;
  sameDay: boolean;    // travel and work land on one day
  // The itinerary journey that books this day — from ANY gig's itinerary,
  // since one trip routinely covers the flight out to a show and the flight
  // on to the next one.
  match: LegMatch | null;
};

type TravelInfo = {
  arrive: TravelLeg | null;
  depart: TravelLeg | null;
  workStart: string;
  workEnd: string;
  flight: FlightStatus;
  // This booking's own ticket, for when no itinerary has been parsed yet: the
  // rows still say "Booked · <conf>" rather than the whole card dropping to a
  // single summary line. Keeps every platform's card the same shape whether
  // or not the PDF has been read.
  ownTicket: { vendor?: string; confirmation?: string } | null;
};

// Whether the travel is actually ticketed, straight from CARL's flight rows.
type FlightStatus = {
  tone: 'booked' | 'open' | 'none';
  label: string;
  detail: string;
};

function flightStatusFor(contacts: BookingContacts): FlightStatus {
  const rows = contacts.flightBookings || [];
  const ticketed = rows.filter((f) => f.confirmation || /book|tick|confirm/i.test(f.status || ''));
  if (ticketed.length > 0) {
    const first = ticketed[0];
    const extra = ticketed.length > 1 ? ` +${ticketed.length - 1} more` : '';
    const parts = [first.vendor, first.confirmation].filter(Boolean).join(' \u00b7 ');
    return {
      tone: 'booked',
      label: 'Flight booked',
      detail: `${parts || first.status || 'confirmed'}${extra}`,
    };
  }
  if (flightRequestOpen(contacts)) {
    return { tone: 'open', label: 'No flight booked', detail: 'requests are open' };
  }
  return { tone: 'none', label: 'No flight booked yet', detail: '' };
}

function travelFor(
  booking: Booking,
  contacts: BookingContacts,
  all: Booking[],
  homeAirport: string,
  itineraries: ItinerarySource[],
): TravelInfo | null {
  const workStart = contacts.workStartDate;
  const workEnd = contacts.workEndDate;
  // Without CARL's own dates there's nothing to compare the span against.
  if (!workStart || !workEnd) return null;
  // The work window must sit inside the booking's (travel-inclusive) span and
  // run forwards. Anything else means we scraped a stale or unrelated record,
  // and a wrong travel day is worse than no ribbon.
  if (workStart > workEnd) return null;
  if (workStart < booking.startDate || workEnd > booking.endDate) return null;

  const here = placeLabel(booking.city, booking.state);
  const home = homeAirport || 'home';

  // Find the connecting gig by DATE across EVERY booking, not by position in
  // the upcoming list: a gig you flew in from leaves that list the day after
  // it ends, and an overlapping booking (a pending request, typically) would
  // otherwise sit between the two and either hide the connection or name a
  // city you never worked. Confirmed bookings beat pending requests.
  const connecting = (match: (b: Booking) => boolean): Booking | null => {
    const hits = all.filter((b) => b.bookingId !== booking.bookingId && match(b));
    return hits.find((b) => !isRequest(b)) || hits[0] || null;
  };
  const prev = connecting((b) => b.endDate === booking.startDate && b.startDate < booking.startDate);
  const next = connecting((b) => b.startDate === booking.endDate && b.endDate > booking.endDate);

  const from = prev ? placeLabel(prev.city, prev.state) : home;
  const to = next ? placeLabel(next.city, next.state) : home;

  // A leg that starts and ends in the same place is not a flight — a local
  // gig you drive to, or two connecting gigs in one city. Drop it rather
  // than draw an X → X route and call it travel.
  const arrive: TravelLeg | null = from === here ? null : {
    date: booking.startDate, from, to: here, sameDay: booking.startDate === workStart,
    match: matchLeg(
      { date: booking.startDate, from, to: here, bookingId: booking.bookingId }, itineraries),
  };
  const depart: TravelLeg | null = to === here ? null : {
    date: booking.endDate, from: here, to, sameDay: booking.endDate === workEnd,
    match: matchLeg(
      { date: booking.endDate, from: here, to, bookingId: booking.bookingId }, itineraries),
  };

  // No flights and no travel days: the ribbon would say nothing the header
  // doesn't already.
  if (!arrive && !depart && workStart === booking.startDate && workEnd === booking.endDate) {
    return null;
  }

  const ticket = (contacts.flightBookings || [])
    .find((f) => f.confirmation || /book|tick|confirm/i.test(f.status || ''));
  return {
    workStart, workEnd, arrive, depart,
    flight: flightStatusFor(contacts),
    ownTicket: ticket ? { vendor: ticket.vendor, confirmation: ticket.confirmation } : null,
  };
}

// "Fri 9/11"
function fmtTravelDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${DOW[dt.getDay()]} ${m}/${d}`;
}

// Nights between two ISO dates — "1 night" reads better than the raw range.
function nightCount(checkIn?: string, checkOut?: string): number | null {
  if (!checkIn || !checkOut) return null;
  const ms = Date.parse(`${checkOut}T00:00:00`) - Date.parse(`${checkIn}T00:00:00`);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 86400000);
}

// Hotel reservations CARL has on the booking, shown like the travel card:
// where, when, and the confirmation, with the PDF a tap away.
function HotelCard({ hotels }: { hotels: HotelBooking[] }) {
  return (
    <div className="travel-card hotel-card">
      {hotels.map((h, i) => {
        const nights = nightCount(h.checkIn, h.checkOut);
        const booked = !!h.confirmation || /book|confirm/i.test(h.status || '');
        return (
          <div className="hotel-entry" key={`${h.confirmation || ''}-${h.checkIn || ''}-${i}`}>
            <div className="travel-row">
              <span className="travel-plane" aria-hidden="true">{'\u{1F3E8}'}</span>
              <span className="travel-row-kind">{h.name || 'Hotel'}</span>
              {h.checkIn && (
                <span className="travel-row-date">
                  {fmtTravelDay(h.checkIn)}
                  {h.checkOut ? ` \u2192 ${fmtTravelDay(h.checkOut)}` : ''}
                  {nights ? ` \u00b7 ${nights} night${nights > 1 ? 's' : ''}` : ''}
                </span>
              )}
              {h.pdfUrl && (
                <button
                  className="secondary hotel-view"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.api.flights.open(h.pdfUrl as string).catch(() => {});
                  }}
                >
                  View reservation
                </button>
              )}
              <span className={`travel-row-flight${booked ? '' : ' is-pending'}`}>
                <span className="travel-flight-dot" aria-hidden="true" />
                {booked ? 'Booked' : (h.status || 'Not booked')}
                {h.confirmation ? ` \u00b7 ${h.confirmation}` : ''}
                {h.bookedBy ? ` \u00b7 ${h.bookedBy}` : ''}
              </span>
            </div>
            {h.notes && <div className="travel-show">{h.notes}</div>}
          </div>
        );
      })}
    </div>
  );
}

function TravelRibbon({ travel }: { travel: TravelInfo }) {
  // A travel day that is ALSO a work day is the one that actually costs you.
  // Say which end it lands on rather than just listing dates.
  const arriveSame = !!travel.arrive?.sameDay;
  const departSame = !!travel.depart?.sameDay;
  const doubleNote = arriveSame && departSame
    ? '*Both Travel Dates are also Work Days'
    : arriveSame
      ? '*Work Starts on your Travel In Date'
      : departSame
        ? '*Work Ends on your Travel Out Date'
        : null;

  const row = (l: TravelLeg, kind: 'arrive' | 'depart') => {
    const ticket = l.match
      ? { confirmation: l.match.confirmation, borrowedFrom: l.match.borrowed ? l.match.jobName : null,
          stops: l.match.leg.via || [], exact: true }
      : travel.ownTicket
        ? { confirmation: travel.ownTicket.confirmation, borrowedFrom: null, stops: [], exact: false }
        : null;
    return (
    <div className={`travel-row${l.sameDay ? ' is-sameday' : ''}`}>
      <span className="travel-plane" aria-hidden="true">{'\u2708'}</span>
      <span className="travel-row-kind">
        {l.sameDay
          ? (kind === 'arrive' ? 'Fly in & work' : 'Wrap & fly out')
          : (kind === 'arrive' ? 'Travel in' : 'Travel out')}
      </span>
      <span className="travel-row-date">{fmtTravelDay(l.date)}</span>
      <span className="travel-row-route">
        {l.from} <span className="travel-arrow">{'\u2192'}</span> {l.to}
      </span>
      {ticket && (
        <span className="travel-row-flight">
          <span className="travel-flight-dot" aria-hidden="true" />
          Booked
          {ticket.confirmation ? ` \u00b7 ${ticket.confirmation}` : ''}
          {ticket.exact
            ? (ticket.stops.length
                ? ` \u00b7 ${ticket.stops.length} stop${ticket.stops.length > 1 ? 's' : ''}`
                  + ` in ${ticket.stops.join(', ')}`
                : ' \u00b7 nonstop')
            : ''}
          {ticket.borrowedFrom ? ` \u00b7 on ${ticket.borrowedFrom}'s itinerary` : ''}
        </span>
      )}
    </div>
    );
  };
  return (
    <div className="travel-card">
      {travel.arrive && row(travel.arrive, 'arrive')}
      {travel.depart && row(travel.depart, 'depart')}
      {!travel.arrive?.match && !travel.depart?.match && !travel.ownTicket && (
      <div className={`travel-flight is-${travel.flight.tone}`}>
        <span className="travel-flight-dot" aria-hidden="true" />
        <span className="travel-flight-label">{travel.flight.label}</span>
        {travel.flight.detail && (
          <span className="travel-flight-detail">{travel.flight.detail}</span>
        )}
      </div>
      )}
      <div className="travel-show">
        Show days: {fmtTravelDay(travel.workStart)} &ndash; {fmtTravelDay(travel.workEnd)}
        {doubleNote && <span className="travel-show-note"> &middot; {doubleNote}</span>}
      </div>
    </div>
  );
}

export default function BookingsList({
  bookings, fetchedAt, refreshing, error, flights, contacts, settings, sswWeeks, onSetDayRate, onRefresh, onResetSetup,
}: Props) {
  const [showAllPast, setShowAllPast] = useState(false);
  // Which upcoming gig shows as the full-view card. null = the default (first
  // upcoming); 'none' = everything collapsed. Rows expand on click, and only
  // one gig is ever expanded — the previous one collapses back into its row,
  // with the list keeping strict date order throughout.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = bookings
    .filter((b) => parseISOLocal(b.endDate) >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = bookings
    .filter((b) => parseISOLocal(b.endDate) < today)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  // Past gigs stay fully collapsed until asked for — they're history, and the
  // screen is about what's coming up.
  const pastVisible = showAllPast ? past : [];

  // Map upcoming gig days onto bi-weekly checks and withhold each check the
  // way payroll does. Gig cards show their slice; the Paychecks card shows
  // the checks themselves.
  //
  // Requests aren't earned money yet, so the headline figures come from a
  // confirmed-only plan; a second plan including requests supplies the
  // grayed "+$X if accepted" delta per check (and the request's gig chip).
  // Every itinerary on file, whichever booking it was filed under — one
  // trip routinely books travel for two gigs.
  const itineraries: ItinerarySource[] = [];
  for (const [bookingId, pdfs] of Object.entries(flights)) {
    const job = bookings.find((b) => b.bookingId === bookingId);
    for (const pdf of pdfs) {
      if (pdf.legs && pdf.legs.length > 0) {
        itineraries.push({
          bookingId, jobName: job?.jobName,
          vendor: pdf.vendor, confirmation: pdf.confirmation, legs: pdf.legs,
        });
      }
    }
  }

  const confirmedOnly = upcoming.filter((b) => !isRequest(b));
  const plan = buildPaychecks(confirmedOnly, contacts, settings, sswWeeks);
  const planAll = confirmedOnly.length === upcoming.length
    ? plan
    : buildPaychecks(upcoming, contacts, settings, sswWeeks);
  const estimatorRows: EstimatorRow[] = planAll.checks.map((all) => {
    const base = plan.checks.find((c) => c.periodStart === all.periodStart);
    const extra = Math.round((all.net + all.perDiem) - (base ? base.net + base.perDiem : 0));
    if (!base) return { ...all, requestOnly: true, requestExtra: extra };
    if (extra <= 0) return base;
    return { ...base, gigs: all.gigs, requestExtra: extra };
  });

  return (
    <>
      <div className="card">
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Bookings</h2>
          <div className="row-actions">
            <span className="subtle">
              {fetchedAt
                ? `Updated ${new Date(fetchedAt).toLocaleString()}${refreshing ? ' · refreshing…' : ''}`
                : refreshing ? 'Fetching…' : 'No data yet'}
            </span>
            <button className="secondary" onClick={onRefresh} disabled={refreshing}>Refresh</button>
            <button className="link" onClick={onResetSetup}>Reset</button>
          </div>
        </div>
        {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      {upcoming.length > 0 && (() => {
        const expanded = expandedId ?? upcoming[0].bookingId;
        // Walk the date-ordered list, grouping consecutive collapsed gigs into
        // row cards and emitting the expanded gig as a full card in place.
        const segments: Array<{ full: Booking } | { rows: Booking[] }> = [];
        for (const b of upcoming) {
          if (b.bookingId === expanded) {
            segments.push({ full: b });
          } else {
            const last = segments[segments.length - 1];
            if (last && 'rows' in last) last.rows.push(b);
            else segments.push({ rows: [b] });
          }
        }
        let headerUsed = false;
        return segments.map((seg) => {
          if ('full' in seg) {
            return (
              <FeaturedBookingCard
                key={seg.full.bookingId}
                booking={seg.full}
                pdfs={flights[seg.full.bookingId] || []}
                contacts={contacts[seg.full.bookingId] || NO_CONTACTS}
                settings={settings}
                travel={travelFor(
                  seg.full, contacts[seg.full.bookingId] || NO_CONTACTS,
                  bookings, settings.homeAirport, itineraries,
                )}
                onCollapse={() => setExpandedId('none')}
              />
            );
          }
          const withHeader = !headerUsed;
          headerUsed = true;
          return (
            <div className="card" key={seg.rows[0].bookingId}>
              {withHeader && <h3>Upcoming</h3>}
              {seg.rows.map((b) => (
                <BookingCard
                  key={b.bookingId}
                  booking={b}
                  pdfs={flights[b.bookingId] || []}
                  contacts={contacts[b.bookingId] || NO_CONTACTS}
                  onExpand={() => setExpandedId(b.bookingId)}
                />
              ))}
            </div>
          );
        });
      })()}

      {estimatorRows.length > 0 && (
        <PaychecksCard checks={estimatorRows} settings={settings} bookings={bookings} onSetDayRate={onSetDayRate} />
      )}

      {past.length > 0 && (
        <div className="card past-card">
          <button
            className="past-toggle"
            onClick={() => setShowAllPast((v) => !v)}
            aria-expanded={showAllPast}
          >
            {/* One glyph rotated, rather than swapping ▸/▾ — the two render at
                different optical sizes and read as a dot at small sizes. */}
            <span className="past-toggle-chevron" aria-hidden="true">›</span>
            <span>Past</span>
            <span className="past-toggle-count subtle">{past.length}</span>
          </button>
          {showAllPast && (
            <div style={{ marginTop: 10 }}>
              {pastVisible.map((b) => (
                <BookingCard key={b.bookingId} booking={b} pdfs={flights[b.bookingId] || []} />
              ))}
            </div>
          )}
        </div>
      )}

      {bookings.length === 0 && !refreshing && (
        <div className="card">
          <p className="subtle">No bookings in your C.A.R.L. calendar yet.</p>
        </div>
      )}
    </>
  );
}

type BookingCardProps = {
  booking: Booking;
  pdfs: FlightPdf[];
  // Supplied for upcoming bookings only — past gigs are already paid, so an
  // estimate there would be noise. Both must be present to show earnings.
  contacts?: BookingContacts;
  // Present on upcoming rows only: clicking the row swaps it to the full view.
  onExpand?: () => void;
};

function BookingCard({ booking, pdfs, contacts, onExpand }: BookingCardProps) {
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.api.logo.forJob(booking.jobName).then((uri) => { if (!cancelled) setLogo(uri); }).catch(() => {});
    return () => { cancelled = true; };
  }, [booking.jobName]);

  return (
    <div
      className={`booking${onExpand ? ' booking-clickable' : ''}`}
      onClick={onExpand}
      title={onExpand ? 'Show full view' : undefined}
    >
      {logo && <img src={logo} alt="" className="booking-logo" />}
      <div className="booking-main">
        <div className="booking-line1">
          <span className="show-num">{booking.jobNumber}</span>
          <span className="booking-name">{booking.jobName}</span>
          <span className="booking-status">{booking.status}</span>
        </div>
        <div className="booking-line2 subtle">
          <span>{formatDateRange(booking.startDate, booking.endDate)}</span>
          {booking.city && <span>· {booking.city}, {booking.state}</span>}
          {booking.position && <span>· {booking.position}</span>}
          {booking.projectManager && <span>· PM: {booking.projectManager}</span>}
          {booking.laborCoordinator && <span>· LC: {booking.laborCoordinator}</span>}
        </div>
      </div>
      {isRequest(booking) && (
        <span className="request-bang" title="Request — needs to be accepted or denied in C.A.R.L.">!</span>
      )}
      {notesUnseen(contacts) && (
        <NoteIcon size={24} title="New booking notes — open the card to read them" />
      )}
      {flightRequestOpen(contacts) && (
        <PlaneIcon size={34} title={contacts!.laborTravel} />
      )}
      {pdfs.length > 0 && (
        <div className="booking-actions">
          {pdfs.map((p) => (
            <button
              key={p.url}
              className="secondary"
              title={p.filename}
              onClick={(e) => { e.stopPropagation(); window.api.flights.open(p.localPath || p.url).catch(() => {}); }}
            >
              View itinerary{pdfs.length > 1 ? ` (${pdfs.indexOf(p) + 1})` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDateRange(start: string, end: string): string {
  const fmt = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  };
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

// Parse "YYYY-MM-DD" as a LOCAL midnight so we don't get TZ-shifted by 1 day.
// (new Date("2026-05-26") treats the string as UTC, which becomes the previous
// local day in any negative-offset timezone.)
function parseISOLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Days until / day-of indicator for the featured card.
function relativeWhen(start: string, end: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const s = parseISOLocal(start);
  const e = parseISOLocal(end);
  const oneDay = 86_400_000;
  if (today < s) {
    const diff = Math.round((s.getTime() - today.getTime()) / oneDay);
    return diff === 1 ? 'Starts tomorrow' : `Starts in ${diff} days`;
  }
  if (today > e) {
    return 'Wrapped';
  }
  const dayIdx = Math.round((today.getTime() - s.getTime()) / oneDay) + 1;
  const totalDays = Math.round((e.getTime() - s.getTime()) / oneDay) + 1;
  if (today.getTime() === e.getTime()) return totalDays === 1 ? 'Today only' : 'Last day';
  return `Day ${dayIdx} of ${totalDays}`;
}

type FeaturedBookingCardProps = BookingCardProps & {
  contacts: BookingContacts;
  settings: UserSettings;
  travel?: TravelInfo | null;
  onCollapse?: () => void;
};

function FeaturedBookingCard({ booking, pdfs, contacts, travel, onCollapse }: FeaturedBookingCardProps) {
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.api.logo.forJob(booking.jobName).then((uri) => { if (!cancelled) setLogo(uri); }).catch(() => {});
    return () => { cancelled = true; };
  }, [booking.jobName]);

  // The full card shows the note text, so having it open counts as reading
  // it. A few seconds' grace keeps the shimmer visible long enough to
  // register before the badge retires; collapsing sooner leaves it unread.
  const unseen = notesUnseen(contacts);
  useEffect(() => {
    if (!unseen) return;
    const t = window.setTimeout(() => {
      window.api.contacts.markNotesSeen(booking.bookingId).catch(() => {});
    }, 4000);
    return () => window.clearTimeout(t);
  }, [unseen, booking.bookingId]);

  return (
    <div className="card featured-booking">
      <div className="featured-top">
        {logo && <img src={logo} alt="" className="featured-logo" />}
        <div
          className={`featured-headline${onCollapse ? ' featured-collapsible' : ''}`}
          onClick={onCollapse}
          title={onCollapse ? 'Collapse' : undefined}
        >
          <div className="featured-jobnum show-num">{booking.jobNumber}</div>
          <div className="featured-name">{booking.jobName}</div>
          <div className="featured-when">
            <span className="featured-when-tag">{relativeWhen(booking.startDate, booking.endDate)}</span>
            <span className="subtle">{formatDateRange(booking.startDate, booking.endDate)}</span>
            {booking.city && <span className="subtle">· {booking.city}, {booking.state}</span>}
            {/* Prefer the federal GSA rate; fall back to CARL's own stored
                rate so gigs without a GSA match still show their per diem
                (the estimator already sums with the same preference). */}
            {(contacts.gsaPerDiem || contacts.perDiem) && (
              <span className="subtle">· P/D ${contacts.gsaPerDiem || contacts.perDiem}</span>
            )}
          </div>
        </div>
        {(pdfs.length > 0 || flightRequestOpen(contacts) || unseen) && (
          <div className="featured-flights">
            {(unseen || flightRequestOpen(contacts)) && (
              <span className="flight-request-wrap">
                {unseen && <NoteIcon size={30} title="New booking notes" />}
                {flightRequestOpen(contacts) && (
                  <FlightRequestButton booking={booking} contacts={contacts} />
                )}
              </span>
            )}
            {pdfs.map((p, i) => (
              <div key={p.url} className="featured-flight">
                {(p.vendor || p.confirmation) && (
                  <div className="featured-flight-header subtle">
                    {p.vendor && <span className="featured-flight-vendor">{p.vendor}</span>}
                    {p.vendor && p.confirmation && <span>·</span>}
                    {p.confirmation && <span>{p.confirmation}</span>}
                  </div>
                )}
                <button
                  className="secondary"
                  title={p.filename}
                  onClick={() => window.api.flights.open(p.localPath || p.url).catch(() => {})}
                >
                  View itinerary{pdfs.length > 1 ? ` (${i + 1})` : ''}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {travel && <TravelRibbon travel={travel} />}
      {(contacts.hotels || []).length > 0 && <HotelCard hotels={contacts.hotels!} />}
      {isRequest(booking) && (
        <button
          className="request-banner"
          onClick={() => { void window.api.bookings.openInCarl(booking.bookingId); }}
        >
          <span className="request-bang">!</span>
          <span>This gig is a request — accept or deny it in C.A.R.L.</span>
          <span className="request-go">Open ›</span>
        </button>
      )}
      {(contacts.venue || contacts.venueAddress) && (
        <a
          className="featured-venue subtle"
          href={mapsUrl(booking, contacts)}
          title="Open in Apple Maps"
        >
          {contacts.venue && <span className="featured-venue-name">{contacts.venue}</span>}
          {contacts.venue && contacts.venueAddress && <span> · </span>}
          {contacts.venueAddress && <span>{contacts.venueAddress}</span>}
        </a>
      )}
      {contacts.bookingNotes && (
        <div className="featured-notes">
          <div className="featured-notes-head">
            <NoteIcon size={18} />
            <span className="featured-field-label subtle">Booking Notes</span>
          </div>
          <div className="featured-notes-text">{contacts.bookingNotes}</div>
        </div>
      )}
      <div className="featured-grid">
        {booking.position && <FeaturedField label="Position" value={booking.position} />}
        {booking.status && <FeaturedField label="Status" value={booking.status} />}
        {booking.projectManager && (
          <FeaturedField
            label="Project Manager"
            value={booking.projectManager}
            email={contacts.pmEmail}
          />
        )}
        {booking.laborCoordinator && (
          <FeaturedField
            label="Labor Coord"
            value={booking.laborCoordinator}
            email={contacts.lcEmail}
          />
        )}
      </div>
    </div>
  );
}

// "Sep 10" from an ISO date, for check labels.
function fmtPayDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MONTHS[m - 1]} ${d}`;
}

// Upcoming bi-weekly checks: which gigs land on each, and what should hit
// the bank. Withholding is per check — heavy checks carry a higher rate,
// exactly as payroll computes them. This card is also where day rates are
// edited now that gig cards carry no amounts: click a gig chip to override
// its rate; clearing the field falls back to base pay.
// A Paycheck row plus the request overlay: `requestExtra` is the additional
// deposit if pending request gigs get accepted; `requestOnly` marks checks
// made up entirely of requests (no confirmed money to headline).
type EstimatorRow = Paycheck & { requestExtra?: number; requestOnly?: boolean };

function PaychecksCard({ checks, settings, bookings, onSetDayRate }: {
  checks: EstimatorRow[];
  settings: UserSettings;
  bookings: Booking[];
  onSetDayRate: (bookingId: string, rate: number | null) => void;
}) {
  // The editor is a modal, not an inline input: the old inline box's
  // blur-commit swallowed the tap that tried to open a second gig's editor
  // (blur fired first, the row reflowed, the click landed on moved DOM —
  // the "bounce"). A modal has no blur minefield and works on phones.
  const [edit, setEdit] = useState<{ bookingId: string; jobName: string; jobNumber: string } | null>(null);
  const [draft, setDraft] = useState('');

  // Jobs with an override on ANY of their bookings — the underline marks
  // every appearance of the job, on every paycheck.
  const customJobs = new Set(
    bookings.filter((b) => settings.gigDayRates?.[b.bookingId]).map((b) => b.jobNumber),
  );

  // Pending requests — their gig chips gray out to match their "if accepted"
  // money line.
  const requestIds = new Set(bookings.filter(isRequest).map((b) => b.bookingId));

  const commit = () => {
    if (!edit) return;
    const n = parseFloat(draft);
    // Entering the base rate (or clearing) removes the override rather than
    // pinning it — otherwise a saved-then-forgotten editor stores base pay as
    // an explicit override that silently stops tracking future base changes.
    const isOverride = Number.isFinite(n) && n > 0 && n !== settings.basePayDayRate;
    onSetDayRate(edit.bookingId, isOverride ? n : null);
    setEdit(null);
  };

  return (
    <div className="card">
      <h3>Paycheck Estimator</h3>
      {checks.map((c) => (
        <div className="paycheck-row" key={c.periodStart}>
          <div className="paycheck-main">
            <div className="paycheck-line1">
              <span className="paycheck-date">{fmtPayDate(c.payDate)}</span>
              <span className="subtle">{fmtPayDate(c.periodStart)} – {fmtPayDate(c.periodEnd)}</span>
            </div>
            <div className="paycheck-gigs subtle">
              {c.gigs.map((g, i) => (
                <span key={g.bookingId} className="paycheck-gig-wrap">
                  {i > 0 && <span className="paycheck-gig-sep">+</span>}
                  <button
                    className={`paycheck-gig${customJobs.has(g.jobNumber) ? ' is-custom' : ''}${requestIds.has(g.bookingId) ? ' is-request' : ''}`}
                    title={`${g.days}d @ ${money(g.dayRate)}${customJobs.has(g.jobNumber) ? ' (custom)' : ''}${requestIds.has(g.bookingId) ? ' (request — not yet accepted)' : ''}${g.actualDays > 0 ? ` — ${g.actualDays}d from timesheet hours` : ''} — click to edit this job's day rate`}
                    onClick={() => {
                      setDraft(String(g.dayRate));
                      setEdit({ bookingId: g.bookingId, jobName: g.jobName, jobNumber: g.jobNumber });
                    }}
                  >
                    {g.jobName} · {g.days}d
                  </button>
                </span>
              ))}
            </div>
          </div>
          {/* The headline figure is the whole deposit — wages net of
              withholding PLUS per diem, matching the bank statement. With
              "include per diem in total" off, it shows wages only and per
              diem rides underneath as its own + line (the old look). */}
          <div
            className="earnings-mini"
            title={[
              `${money(c.gross)} gross wages`,
              c.retirement > 0 ? `401k: −${money(c.retirement)}` : null,
              c.federal > 0 ? `Federal: −${money(c.federal)}` : null,
              c.socialSecurity > 0 ? `Social Security: −${money(c.socialSecurity)}` : null,
              c.medicare > 0 ? `Medicare: −${money(c.medicare)}` : null,
              c.state > 0 ? `State: −${money(c.state)}` : null,
              c.withholdingRate > 0 ? `Withheld: ${(c.withholdingRate * 100).toFixed(1)}% of wages` : null,
              c.perDiem > 0 ? `Per diem (untaxed): +${money(c.perDiem)}` : null,
              c.requestOnly
                ? `${money(c.net + c.perDiem)} if accepted — this gig is still a request`
                : settings.perDiemInTotal || c.perDiem <= 0
                  ? `${money(c.net + c.perDiem)} deposit`
                  : `${money(c.net)} wages + ${money(c.perDiem)} per diem`,
              !c.requestOnly && (c.requestExtra ?? 0) > 0
                ? `Request gigs not counted above: +${money(c.requestExtra!)} if accepted`
                : null,
              c.actualDays > 0
                ? `${c.actualDays} of ${c.gigs.reduce((n, g) => n + g.days, 0)} days priced from saved timesheet hours (OT/DT included); the rest assume standard 10-hour days.`
                : 'Assumes standard 10-hour days — OT and DT push real checks higher.',
            ].filter((l) => l !== null).join('\n')}
          >
            {!c.requestOnly && (
              <div className="earnings-mini-main">
                {money(settings.perDiemInTotal ? c.net + c.perDiem : c.net)}
              </div>
            )}
            {!c.requestOnly && !settings.perDiemInTotal && c.perDiem > 0 && (
              <div className="earnings-mini-sub">+{money(c.perDiem)} per diem</div>
            )}
            {(c.requestExtra ?? 0) > 0 && (
              <div className="earnings-mini-sub is-request">
                {c.requestOnly ? '' : '+'}{money(c.requestExtra!)} if accepted
              </div>
            )}
          </div>
        </div>
      ))}

      {edit && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal-card" style={{ width: 'min(380px, calc(100vw - 32px))' }} onClick={(e) => e.stopPropagation()}>
            <div className="row-between">
              <h2 style={{ margin: 0, fontSize: 16 }}>Change your day rate for just this job?</h2>
              <button className="link" onClick={() => setEdit(null)}>✕</button>
            </div>
            <p className="subtle" style={{ fontSize: 12, margin: '8px 0 2px' }}>
              {edit.jobName} ({edit.jobNumber}) — the new rate applies to this job on
              every paycheck it spans, and each one shows the edited underline.
            </p>
            <div className="field">
              <label>Day rate ($)</label>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={draft}
                autoFocus
                onFocus={(e) => e.target.select()}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEdit(null);
                }}
              />
            </div>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              {customJobs.has(edit.jobNumber) && (
                <button className="link" onClick={() => { onSetDayRate(edit.bookingId, null); setEdit(null); }}>
                  Back to base rate
                </button>
              )}
              <button className="primary" onClick={commit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// An LC has opened flight requests on this booking (CARL's laborTravel
// status). The exact literal today is "Flight Requests Open to Crew"; matched
// loosely so minor wording drift on CARL's side doesn't silently kill it.
function flightRequestOpen(contacts?: BookingContacts): boolean {
  return !!contacts?.laborTravel && /flight\s*requests?\s*open/i.test(contacts.laborTravel);
}

// The plane silhouette (user-supplied art, converted to an alpha mask) tinted
// through the theme accent — see .plane-icon in styles.css.
function PlaneIcon({ size, title }: { size: number; title?: string }) {
  return (
    <span
      className="plane-icon"
      style={{ width: size }}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  );
}

// This booking has notes the user hasn't viewed yet — either the first note
// to appear, or an edit since the full card was last opened.
function notesUnseen(contacts?: BookingContacts): boolean {
  return !!contacts?.bookingNotes && contacts.bookingNotes !== (contacts.notesSeen ?? '');
}

// The chat-bubbles glyph (user-supplied art → alpha mask), tinted through the
// theme accent exactly like the plane. Shown while a booking's notes are
// unseen; sits to the LEFT of the plane when both are present.
function NoteIcon({ size, title }: { size: number; title?: string }) {
  return (
    <span
      className="note-icon"
      style={{ width: size }}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  );
}

// Full-view treatment: plane to the left of the button that mirrors CARL's
// "Add Flight Request". Clicking opens that page in the browser — the request
// form itself lives there, behind CARL's own login. Collapsed rows show
// PlaneIcon alone instead of this.
function FlightRequestButton({ booking, contacts }: { booking: Booking; contacts: BookingContacts }) {
  return (
    <span className="flight-request-wrap">
      <PlaneIcon size={46} />
      <button
        className="flight-request-btn"
        title={`${contacts.laborTravel} — opens this booking in C.A.R.L.`}
        onClick={(e) => {
          e.stopPropagation();
          window.api.bookings.openInCarl(booking.bookingId).catch(() => {});
        }}
      >
        Flight Request Open
      </button>
    </span>
  );
}

// Apple Maps via its URL scheme — the OS hands maps:// straight to the native
// app, exactly like the mailto: links elsewhere on this card. (An
// https://maps.apple.com link would detour through the default browser.)
// Prefer the scraped street address; fall back to searching venue + city.
function mapsUrl(booking: Booking, contacts: BookingContacts): string {
  if (contacts.venueAddress) {
    return `maps://?address=${encodeURIComponent(contacts.venueAddress)}`;
  }
  const q = [contacts.venue, booking.city, booking.state].filter(Boolean).join(', ');
  return `maps://?q=${encodeURIComponent(q)}`;
}

function FeaturedField({ label, value, email }: { label: string; value: string; email?: string }) {
  return (
    <div className="featured-field">
      <div className="featured-field-label subtle">{label}</div>
      <div className="featured-field-value">{value}</div>
      {email && (
        <a className="featured-field-email" href={`mailto:${email}`}>{email}</a>
      )}
    </div>
  );
}
