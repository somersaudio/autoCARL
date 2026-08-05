import { useEffect, useState } from 'react';
import type {
  Booking, BookingContacts, BookingContactsCache, FlightPdf, FlightsCache, UserSettings,
} from '../shared/types';
import { buildPaychecks, money, type Paycheck } from '../shared/paychecks';

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

  // Map upcoming gig days onto bi-weekly checks and withhold each check the
  // way payroll does. Gig cards show their slice; the Paychecks card shows
  // the checks themselves.
  const plan = buildPaychecks(upcoming, contacts, settings);

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

      {plan.checks.length > 0 && (
        <PaychecksCard checks={plan.checks} settings={settings} onSetDayRate={onSetDayRate} />
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

function FeaturedBookingCard({ booking, pdfs, contacts, onCollapse }: FeaturedBookingCardProps) {
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
function PaychecksCard({ checks, settings, onSetDayRate }: {
  checks: Paycheck[];
  settings: UserSettings;
  onSetDayRate: (bookingId: string, rate: number | null) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commit = (bookingId: string) => {
    const n = parseFloat(draft);
    // Entering the base rate (or clearing) removes the override rather than
    // pinning it — otherwise an opened-then-blurred editor stores base pay as
    // an explicit override that silently stops tracking future base changes.
    const isOverride = Number.isFinite(n) && n > 0 && n !== settings.basePayDayRate;
    onSetDayRate(bookingId, isOverride ? n : null);
    setEditingId(null);
  };

  return (
    <div className="card">
      <h3>Paychecks</h3>
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
                  {editingId === g.bookingId ? (
                    <span className="earnings-edit" onClick={(e) => e.stopPropagation()}>
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
                          if (e.key === 'Enter') commit(g.bookingId);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => commit(g.bookingId)}
                      />
                    </span>
                  ) : (
                    <button
                      className={`paycheck-gig${settings.gigDayRates?.[g.bookingId] ? ' is-custom' : ''}`}
                      title={`${g.days}d @ ${money(g.dayRate)}${settings.gigDayRates?.[g.bookingId] ? ' (custom)' : ''} — click to edit this gig's day rate`}
                      onClick={() => { setDraft(String(g.dayRate)); setEditingId(g.bookingId); }}
                    >
                      {g.jobName} · {g.days}d
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
          {/* The white figure is the whole deposit — wages net of withholding
              PLUS per diem, matching what the bank statement will show. */}
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
              `${money(c.net + c.perDiem)} deposit`,
              'Assumes standard 10-hour days — OT and DT push real checks higher.',
            ].filter((l) => l !== null).join('\n')}
          >
            <div className="earnings-mini-main">{money(c.net + c.perDiem)}</div>
          </div>
        </div>
      ))}
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
