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
  onRefresh: () => void | Promise<void>;
  onResetSetup: () => void;
};

const NO_CONTACTS: BookingContacts = { pmEmail: '', lcEmail: '' };

export default function BookingsList({
  bookings, fetchedAt, refreshing, error, flights, contacts, settings, onRefresh, onResetSetup,
}: Props) {
  const [showAllPast, setShowAllPast] = useState(false);
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

      {upcoming.length > 0 && (
        <>
          <FeaturedBookingCard
            booking={upcoming[0]}
            pdfs={flights[upcoming[0].bookingId] || []}
            contacts={contacts[upcoming[0].bookingId] || NO_CONTACTS}
            settings={settings}
          />
          {upcoming.length > 1 && (
            <div className="card">
              <h3>Upcoming</h3>
              {upcoming.slice(1).map((b) => (
                <BookingCard
                  key={b.bookingId}
                  booking={b}
                  pdfs={flights[b.bookingId] || []}
                  contacts={contacts[b.bookingId] || NO_CONTACTS}
                  settings={settings}
                />
              ))}
            </div>
          )}
        </>
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
  settings?: UserSettings;
};

function BookingCard({ booking, pdfs, contacts, settings }: BookingCardProps) {
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.api.logo.forJob(booking.jobName).then((uri) => { if (!cancelled) setLogo(uri); }).catch(() => {});
    return () => { cancelled = true; };
  }, [booking.jobName]);

  return (
    <div className="booking">
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
      {contacts && settings && (
        <EarningsSummary booking={booking} contacts={contacts} settings={settings} />
      )}
      {pdfs.length > 0 && (
        <div className="booking-actions">
          {pdfs.map((p) => (
            <button
              key={p.url}
              className="secondary"
              title={p.filename}
              onClick={() => window.api.flights.open(p.localPath).catch(() => {})}
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
};

function FeaturedBookingCard({ booking, pdfs, contacts, settings }: FeaturedBookingCardProps) {
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
        <div className="featured-headline">
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
        {pdfs.length > 0 && (
          <div className="featured-flights">
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
        <div className="featured-venue subtle">
          {contacts.venue && <span className="featured-venue-name">{contacts.venue}</span>}
          {contacts.venue && contacts.venueAddress && <span> · </span>}
          {contacts.venueAddress && <span>{contacts.venueAddress}</span>}
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
      <div className="featured-foot">
        <EarningsSummary booking={booking} contacts={contacts} settings={settings} />
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
  booking, contacts, settings,
}: { booking: Booking; contacts: BookingContacts; settings: UserSettings }) {
  // GSA's zip lookup is the better number; CARL's stored rate is the fallback
  // for bookings whose venue zip we couldn't resolve.
  const perDiemRate = contacts.gsaPerDiem || contacts.perDiem || 0;
  const est = estimateEarnings(booking.startDate, booking.endDate, settings, perDiemRate);
  if (!est) return null;

  // The cards show bare numbers, so the tooltip carries what they mean —
  // including whether the top figure is take-home or gross, which depends on
  // the Subtract-taxes setting.
  const tooltip = [
    `${est.days} ${est.days === 1 ? 'day' : 'days'} @ ${money(est.dayRate)} = ${money(est.grossWages)} gross`,
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
  ].filter(Boolean).join('\n');

  return (
    <div className="earnings-mini" title={tooltip}>
      <div className="earnings-mini-main">{money(est.netWages)}</div>
      {est.perDiem > 0 && (
        <div className="earnings-mini-sub">+{money(est.perDiem)}</div>
      )}
    </div>
  );
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
