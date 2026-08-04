import { useEffect, useState } from 'react';
import type {
  Booking, BookingContacts, BookingContactsCache, FlightPdf, FlightsCache, UserSettings,
} from '../shared/types';
import { estimateEarnings, money } from '../shared/earnings';

type Props = {
  bookings: Booking[];
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
  flights: FlightsCache;
  contacts: BookingContactsCache;
  settings: UserSettings;
  onSetDayRate: (bookingId: string, rate: number | null) => void;
  onRefresh: () => void | Promise<void>;
  onResetSetup: () => void;
};

const NO_CONTACTS: BookingContacts = { pmEmail: '', lcEmail: '' };

export default function BookingsList({
  bookings, fetchedAt, refreshing, error, flights, contacts, settings, onSetDayRate, onRefresh, onResetSetup,
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

  return (
    <>
      <div className="card">
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Your bookings</h2>
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
                onSetDayRate={onSetDayRate}
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
                  settings={settings}
                  onSetDayRate={onSetDayRate}
                  onExpand={() => setExpandedId(b.bookingId)}
                />
              ))}
            </div>
          );
        });
      })()}

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
  settings?: UserSettings;
  onSetDayRate?: (bookingId: string, rate: number | null) => void;
  // Present on upcoming rows only: clicking the row swaps it to the full view.
  onExpand?: () => void;
};

function BookingCard({ booking, pdfs, contacts, settings, onSetDayRate, onExpand }: BookingCardProps) {
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
      {contacts && settings && onSetDayRate && (
        <EarningsSummary
          booking={booking}
          contacts={contacts}
          settings={settings}
          onSetDayRate={onSetDayRate}
        />
      )}
      {(pdfs.length > 0 || flightRequestOpen(contacts)) && (
        <div className="booking-actions">
          {flightRequestOpen(contacts) && (
            <FlightRequestButton booking={booking} contacts={contacts!} />
          )}
          {pdfs.map((p) => (
            <button
              key={p.url}
              className="secondary"
              title={p.filename}
              onClick={(e) => { e.stopPropagation(); window.api.flights.open(p.localPath).catch(() => {}); }}
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
  onCollapse?: () => void;
};

function FeaturedBookingCard({ booking, pdfs, contacts, settings, onSetDayRate, onCollapse }: FeaturedBookingCardProps) {
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.api.logo.forJob(booking.jobName).then((uri) => { if (!cancelled) setLogo(uri); }).catch(() => {});
    return () => { cancelled = true; };
  }, [booking.jobName]);

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
            {contacts.gsaPerDiem && (
              <span className="subtle">· P/D ${contacts.gsaPerDiem}</span>
            )}
          </div>
        </div>
        {(pdfs.length > 0 || flightRequestOpen(contacts)) && (
          <div className="featured-flights">
            {flightRequestOpen(contacts) && (
              <FlightRequestButton booking={booking} contacts={contacts} />
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
                  onClick={() => window.api.flights.open(p.localPath).catch(() => {})}
                >
                  View itinerary{pdfs.length > 1 ? ` (${i + 1})` : ''}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
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
      <div className="featured-foot">
        <EarningsSummary
          booking={booking}
          contacts={contacts}
          settings={settings}
          onSetDayRate={onSetDayRate!}
        />
      </div>
    </div>
  );
}

// Projected pay for a booking, as two numbers: what lands in the bank, and
// per diem on its own line. Renders nothing until a base day rate is set in
// Settings, so cards are unchanged for anyone who hasn't opted in.
//
// The full breakdown (days, rate, 401k, tax) lives in the hover tooltip rather
// than on the card — the cards stay scannable, the detail is one hover away.
function EarningsSummary({
  booking, contacts, settings, onSetDayRate,
}: {
  booking: Booking;
  contacts: BookingContacts;
  settings: UserSettings;
  onSetDayRate: (bookingId: string, rate: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // GSA's zip lookup is the better number; CARL's stored rate is the fallback
  // for bookings whose venue zip we couldn't resolve.
  const perDiemRate = contacts.gsaPerDiem || contacts.perDiem || 0;
  const override = settings.gigDayRates?.[booking.bookingId];
  const est = estimateEarnings(
    booking.startDate, booking.endDate, settings, perDiemRate, override,
  );
  if (!est) return null;

  const beginEdit = () => {
    setDraft(String(est.dayRate));
    setEditing(true);
  };

  // Empty or non-positive clears the override and falls back to base pay, so
  // there's a way out without a separate "reset" control.
  const commit = () => {
    const n = parseFloat(draft);
    onSetDayRate(booking.bookingId, Number.isFinite(n) && n > 0 ? n : null);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="earnings-mini earnings-edit" onClick={(e) => e.stopPropagation()}>
        <label className="earnings-edit-label">Day rate</label>
        <input
          className="earnings-edit-input"
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
            if (e.key === 'Escape') setEditing(false);   // discard, keep old value
          }}
          onBlur={commit}
        />
      </div>
    );
  }

  // The cards show bare numbers, so the tooltip carries what they mean —
  // including whether the top figure is take-home or gross, which depends on
  // the Subtract-taxes setting.
  const tooltip = [
    'Click to edit day rate',
    '',
    `${est.days} ${est.days === 1 ? 'day' : 'days'} @ ${money(est.dayRate)}${est.usesCustomRate ? ' (custom)' : ''} = ${money(est.grossWages)} gross`,
    est.retirement > 0 ? `401k (${settings.retirementPct}%): −${money(est.retirement)}` : null,
    est.federalTax > 0 ? `Federal: −${money(est.federalTax)}` : null,
    est.socialSecurity > 0 ? `Social Security: −${money(est.socialSecurity)}` : null,
    est.medicare > 0 ? `Medicare: −${money(est.medicare)}` : null,
    est.stateTax > 0 ? `State: −${money(est.stateTax)}` : null,
    `${money(est.netWages)} ${est.hasDeductions ? 'take-home' : 'gross'}`
      + (est.taxes > 0 ? ` (${(est.effectiveRate * 100).toFixed(1)}% tax)` : ''),
    est.perDiem > 0
      ? `+${money(est.perDiem)} per diem (${est.days} × ${money(est.perDiemRate)})`
      : 'Per diem not available yet',
    'Estimate assumes standard 10-hour days.',
    est.lowConfidence
      ? 'Add your yearly wages in Settings — without them, tax is figured as if this gig were your only income.'
      : null,
    // Only drop nulls, so the deliberate blank line after the first row lives.
  ].filter((line) => line !== null).join('\n');

  return (
    <button
      type="button"
      className={`earnings-mini earnings-clickable${est.usesCustomRate ? ' is-custom' : ''}`}
      title={tooltip}
      onClick={(e) => { e.stopPropagation(); beginEdit(); }}
    >
      <div className="earnings-mini-main">{money(est.netWages)}</div>
      {est.perDiem > 0 && (
        <div className="earnings-mini-sub">+{money(est.perDiem)}</div>
      )}
    </button>
  );
}

// An LC has opened flight requests on this booking (CARL's laborTravel
// status). The exact literal today is "Flight Requests Open to Crew"; matched
// loosely so minor wording drift on CARL's side doesn't silently kill it.
function flightRequestOpen(contacts?: BookingContacts): boolean {
  return !!contacts?.laborTravel && /flight\s*requests?\s*open/i.test(contacts.laborTravel);
}

// Mirrors the blue "Add Flight Request" button on the CARL booking page.
// Clicking opens that page in the browser — the request form itself lives
// there, behind CARL's own login.
function FlightRequestButton({ booking, contacts }: { booking: Booking; contacts: BookingContacts }) {
  return (
    <button
      className="flight-request-btn"
      title={`${contacts.laborTravel} — opens this booking in C.A.R.L.`}
      onClick={(e) => {
        e.stopPropagation();
        window.api.bookings.openInCarl(booking.bookingId).catch(() => {});
      }}
    >
      Add Flight Request
    </button>
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
