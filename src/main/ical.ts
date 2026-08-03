import type { Booking } from '../shared/types';

// Fetch the user's CARL iCal feed and parse into Bookings. The whole thing is
// ~10 KB of text and runs in <200 ms — no browser, no scraping.

export async function fetchAndParseBookings(icalUrl: string): Promise<Booking[]> {
  const res = await fetch(icalUrl, { headers: { 'User-Agent': 'AUTOcarl/2' } });
  if (!res.ok) throw new Error(`iCal fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  return parseIcs(text).map(eventToBooking).filter((b): b is Booking => b !== null);
}

// ----- iCal parsing -----

// Returns one record per VEVENT, keyed by property name (params stripped).
function parseIcs(text: string): Record<string, string>[] {
  // RFC 5545 line folding: a leading space/tab on the next line is a
  // continuation of the previous line. Unfold first.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = left.split(';')[0]; // drop ;VALUE=DATE etc.
    current[name] = value;
  }
  return events;
}

function eventToBooking(ev: Record<string, string>): Booking | null {
  const summary = ev['SUMMARY'] || '';
  // "CTLA025403 - Google I/O '26 - Tracks Audio Labor - Confirmed"
  // First token before " - " is jobNumber; last token after " - " is status;
  // middle (whatever's left) is the show name.
  const parts = summary.split(' - ');
  if (parts.length < 3) return null;
  const jobNumber = parts[0].trim();
  const status = parts[parts.length - 1].trim();
  const jobName = parts.slice(1, -1).join(' - ').trim();

  const startDate = icalDateToIso(ev['DTSTART']);
  const endExclusive = icalDateToIso(ev['DTEND']);
  if (!startDate || !endExclusive) return null;
  // iCal DTEND is exclusive — collapse to inclusive (last day = endExclusive - 1).
  const endDate = addDaysIso(endExclusive, -1);

  const location = ev['LOCATION'] || '';
  const [cityRaw, stateRaw] = location.split(',').map((s) => s.trim());

  // DESCRIPTION uses literal "\n" escapes for newlines.
  const desc = (ev['DESCRIPTION'] || '').replace(/\\n/g, '\n').replace(/\\,/g, ',');
  const fields: Record<string, string> = {};
  for (const line of desc.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep > 0) fields[line.slice(0, sep).trim()] = line.slice(sep + 3).trim();
  }
  // Position field comes prefixed with a numeric code ("05 - Audio Engineer") —
  // strip the prefix to match what we displayed in v1.
  const positionRaw = fields['Position'] || '';
  const position = positionRaw.replace(/^[A-Za-z0-9]+\s*-\s*/, '');

  return {
    bookingId: ev['UID'] || '',
    jobNumber,
    jobName,
    status,
    position,
    projectManager: fields['Project Manager'] || '',
    laborCoordinator: fields['Labor Coordinator'] || '',
    city: cityRaw || '',
    state: stateRaw || '',
    startDate,
    endDate,
  };
}

// "20260503" → "2026-05-03". Returns '' if input doesn't match the date form.
function icalDateToIso(s: string | undefined): string {
  if (!s) return '';
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
