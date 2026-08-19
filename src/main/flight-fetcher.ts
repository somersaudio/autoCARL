import { promises as fs, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { app } from 'electron';
import type { Booking, BookingContactsCache, FlightPdf, FlightsCache } from '../shared/types';
import {
  flightsDir, readFlightsCache, writeFlightsCache,
  readContactsCache, writeContactsCache,
} from './store';
import { parseFlightPdf } from './flight-parser';
import { gsaRateForCity, gsaRateForZip } from './gsa-perdiem';
import { fetchBookingDetails, resetCarlSession, drainPostDiags } from './carl-api';

function logSweep(line: string): void {
  try {
    const path = join(app.getPath('userData'), 'autocarl-sweep.log');
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch { /* ignore */ }
}

// Normalize a person name for matching CARL's PM/LC names against the booking's
// iCal-sourced names. CARL serves "Hilton Brown", iCal sometimes "Brown, Hilton".
function normalizeName(s: string): string {
  const t = s.toLowerCase().replace(/[.,]/g, '').trim();
  // "brown hilton" → "hilton brown" if it has exactly 2 tokens.
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 2) {
    return [parts[1], parts[0]].sort().join(' ');
  }
  return parts.sort().join(' ');
}

function matchEmailForRole(emailsByName: Record<string, string>, roleName: string): string {
  if (!roleName) return '';
  const want = normalizeName(roleName);
  for (const [name, email] of Object.entries(emailsByName)) {
    if (normalizeName(name) === want) return email;
  }
  // Fuzzy fallback: any email whose name contains a token from the role.
  const roleTokens = roleName.toLowerCase().replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
  for (const [name, email] of Object.entries(emailsByName)) {
    const nLower = name.toLowerCase();
    if (roleTokens.length && roleTokens.every((tok) => nLower.includes(tok))) return email;
  }
  return '';
}

// Sweep upcoming bookings for flight PDFs + contact emails. Runs once per
// app launch. Logs in once, visits each booking's detail page, scrapes
// flights-table rows and PM/LC emails, downloads any new PDFs, and pushes
// per-booking updates to both caches.
export async function sweepFlights(
  bookings: Booking[],
  email: string,
  password: string,
  onUpdate: (cache: FlightsCache) => void,
  onContactsUpdate: (cache: BookingContactsCache) => void,
): Promise<FlightsCache> {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Visit every booking so past shows get their per-diem + contacts scraped
  // (users still submit timesheets for past weeks). PDFs only download for
  // upcoming bookings — no point pulling flight itineraries for old shows.
  const isUpcoming = (b: Booking) => new Date(b.endDate) >= today;
  const toVisit = bookings;
  if (toVisit.length === 0) return readFlightsCache();

  const cache = await readFlightsCache();
  const contacts = await readContactsCache();

  try {
    // The new XHR-based fetcher handles its own auth + cookies in an Electron
    // session partition — no Chromium binary needed. First call logs in; later
    // calls reuse the session cookies.
    await resetCarlSession();
    logSweep(`sweep: starting XHR fetcher, ${toVisit.length} booking(s)`);

    for (const booking of toVisit) {
      try {
        logSweep(`booking ${booking.bookingId} (${booking.jobNumber}): fetching`);
        const scraped = await fetchBookingDetails(booking.bookingId, email, password);
        const diags = drainPostDiags();
        const dbg = (scraped as unknown as { __debug?: { htmlBytes: number; tokenCount: number } }).__debug;
        const pmEmail = matchEmailForRole(scraped.emailsByName, booking.projectManager);
        const lcEmail = matchEmailForRole(scraped.emailsByName, booking.laborCoordinator);
        // Summarise the POST diagnostics: how many tokens returned non-null JSON.
        const ok = diags.filter((d) => d.status === 200 && d.nonNull).length;
        const sample = diags[0];
        logSweep(`booking ${booking.bookingId}: fetched — htmlBytes=${dbg?.htmlBytes ?? '?'}, tokens=${dbg?.tokenCount ?? '?'}, postsOK=${ok}/${diags.length}, perDiem=${scraped.perDiem ?? '?'}, pm=${pmEmail || '?'}, lc=${lcEmail || '?'}, flights=${scraped.flights.length}, venue=${scraped.venue || '?'}, zip=${scraped.venueZip || '?'}, travel=${scraped.laborTravel || '?'}`);
        if (sample) logSweep(`  sample post[0]: status=${sample.status} bytes=${sample.bodyBytes} body=${(sample.sample || '').replace(/\n/g, ' ')}`);

        // ----- contacts (+ per-diem + venue + GSA rate) -----
        // Look up the federal GSA M&IE rate by venue zip when we have one.
        // CARL often has no venue (and so no zip) until close to the show —
        // fall back to the booking's own city/state so future gigs still get
        // a rate. Cached in the gsa module, so this only hits the API on the
        // first booking that visits a new location.
        let gsaPerDiem: number | undefined;
        let gsaCity: string | undefined;
        let gsa = null as Awaited<ReturnType<typeof gsaRateForZip>>;
        let gsaVia = '';
        if (scraped.venueZip) {
          gsa = await gsaRateForZip(scraped.venueZip);
          gsaVia = `zip=${scraped.venueZip}`;
          if (!gsa) logSweep(`booking ${booking.bookingId}: GSA lookup for zip=${scraped.venueZip} returned nothing`);
        }
        if (!gsa && booking.city && booking.state) {
          gsa = await gsaRateForCity(booking.city, booking.state);
          gsaVia = `city=${booking.city}, ${booking.state}`;
          if (!gsa) logSweep(`booking ${booking.bookingId}: GSA city lookup (${booking.city}, ${booking.state}) returned nothing`);
        }
        if (gsa) {
          gsaPerDiem = gsa.meals;
          gsaCity = gsa.city;
          logSweep(`booking ${booking.bookingId}: GSA ${gsaVia} → meals=${gsa.meals} (${gsa.city || '?'}, ${gsa.state || '?'})`);
        }

        const prevContacts = contacts[booking.bookingId];
        const next = {
          pmEmail,
          lcEmail,
          perDiem: scraped.perDiem,
          venue: scraped.venue,
          venueAddress: scraped.venueAddress,
          venueZip: scraped.venueZip,
          gsaPerDiem,
          gsaCity,
          laborTravel: scraped.laborTravel,
          bookingNotes: scraped.bookingNotes,
          // What the user has read is renderer state, not CARL state — carry
          // it across sweeps so a refresh doesn't re-badge an already-seen note.
          notesSeen: prevContacts?.notesSeen,
        };
        const contactsChanged = !prevContacts
          || prevContacts.pmEmail !== next.pmEmail
          || prevContacts.lcEmail !== next.lcEmail
          || prevContacts.perDiem !== next.perDiem
          || prevContacts.venue !== next.venue
          || prevContacts.venueAddress !== next.venueAddress
          || prevContacts.venueZip !== next.venueZip
          || prevContacts.gsaPerDiem !== next.gsaPerDiem
          || prevContacts.laborTravel !== next.laborTravel
          || prevContacts.bookingNotes !== next.bookingNotes;
        if (contactsChanged) {
          contacts[booking.bookingId] = next;
          await writeContactsCache(contacts);
          onContactsUpdate(contacts);
        }

        // ----- flights -----
        // Skip PDF download for past bookings — those shows are over, no
        // reason to spend the bandwidth pulling old itineraries. (Contacts
        // and per-diem are still scraped above for every booking.)
        if (!isUpcoming(booking)) continue;

        const existing = cache[booking.bookingId] || [];
        const existingByUrl = new Map(existing.map((p) => [p.url, p]));
        const scrapedUrls = new Set(scraped.flights.map((f) => f.pdfUrl));

        const fresh: FlightPdf[] = [];
        for (const f of scraped.flights) {
          const url = f.pdfUrl;
          const prev = existingByUrl.get(url);
          let localPath: string;
          let filename: string;
          let fetchedAt: string;
          if (prev) {
            const present = await fs.access(prev.localPath).then(() => true).catch(() => false);
            if (present) {
              localPath = prev.localPath;
              filename = prev.filename;
              fetchedAt = prev.fetchedAt;
            } else {
              filename = filenameFromUrl(url);
              localPath = join(flightsDir(), booking.bookingId, filename);
              await fs.mkdir(join(flightsDir(), booking.bookingId), { recursive: true });
              await downloadToFile(url, localPath);
              fetchedAt = new Date().toISOString();
            }
          } else {
            filename = filenameFromUrl(url);
            localPath = join(flightsDir(), booking.bookingId, filename);
            await fs.mkdir(join(flightsDir(), booking.bookingId), { recursive: true });
            await downloadToFile(url, localPath);
            fetchedAt = new Date().toISOString();
          }
          // Read PDF text for outbound/return dates + airports + leg count.
          // (The CARL XHR doesn't expose those columns — only vendor /
          // confirmation / status. PDF parsing is the source of truth now.)
          const parsed = await parseFlightPdf(localPath);
          fresh.push({
            url, filename, localPath, fetchedAt,
            vendor: f.vendor, confirmation: f.confirmation,
            outboundDate: parsed?.outboundDate,
            outboundFrom: parsed?.outboundFrom,
            outboundTo: parsed?.outboundTo,
            returnDate: parsed?.returnDate,
            returnFrom: parsed?.returnFrom,
            returnTo: parsed?.returnTo,
            legCount: parsed?.legCount,
          });
        }

        // Prune local files for PDFs the booking no longer references.
        for (const stale of existing.filter((p) => !scrapedUrls.has(p.url))) {
          await fs.unlink(stale.localPath).catch(() => {});
        }

        const changed = fresh.length !== existing.length
          || fresh.some((f, i) => existing[i]?.url !== f.url
            || existing[i]?.vendor !== f.vendor
            || existing[i]?.confirmation !== f.confirmation
            || existing[i]?.outboundTo !== f.outboundTo
            || existing[i]?.returnTo !== f.returnTo
            || existing[i]?.legCount !== f.legCount);
        if (fresh.length === 0) {
          if (booking.bookingId in cache) {
            delete cache[booking.bookingId];
            await writeFlightsCache(cache);
            onUpdate(cache);
          }
        } else if (changed) {
          cache[booking.bookingId] = fresh;
          await writeFlightsCache(cache);
          onUpdate(cache);
        }
      } catch (e) {
        // Booking might be archived/gone from CARL — log but don't fail the
        // whole sweep. The cache for this booking stays as-is.
        logSweep(`booking ${booking.bookingId}: ERROR ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return cache;
  } finally {
    logSweep(`sweep: done`);
  }
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() || `flight-${Date.now()}.pdf`;
    return decodeURIComponent(base);
  } catch {
    return `flight-${Date.now()}.pdf`;
  }
}

function downloadToFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadToFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', async () => {
        try {
          await fs.writeFile(destPath, Buffer.concat(chunks));
          resolve();
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(45_000, () => req.destroy(new Error('timeout downloading PDF')));
    req.end();
  });
}
