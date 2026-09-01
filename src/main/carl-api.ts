// Direct CARL API client — replaces the Playwright-based DOM scrape.
//
// CARL is an Angular SPA backed by an HTTP API at /webapi/v1/app/*. Most
// booking-data endpoints look like:
//
//   POST /webapi/v1/app/g/{encrypted_token}
//
// where the token is a server-issued, server-encrypted handle that's baked
// into the booking detail page HTML as `data-u-id` attributes. We can't
// generate these tokens ourselves, so the flow is:
//
//   1. Login (POST /webapi/v1/app/auth) → session cookies + auth token
//   2. GET /crewcalendar/booking-details-1/{bookingId} → page HTML
//   3. Regex out every data-u-id token from the HTML
//   4. POST each one to /webapi/v1/app/g/{token} (with two body shapes —
//      the page uses both, we just try both)
//   5. Scan all JSON responses for the fields we care about
//
// No Chromium binary required — runs in any Electron build, on any user's
// machine.

import { net, session } from 'electron';

export const CARL = 'https://carl.ctus.live';

// We use a dedicated session partition so cookies stay scoped (and so we
// can wipe them on resetSession). Mirrors the SSW pattern.
function carlSession() {
  return session.fromPartition('carl');
}

let loggedInAs: string | null = null;
let lastUser: { id: string; name: string } | null = null;
let authToken: string | null = null;

export async function resetCarlSession(): Promise<void> {
  loggedInAs = null;
  lastUser = null;
  authToken = null;
  try { await carlSession().clearStorageData({ storages: ['cookies'] }); } catch { /* */ }
}

// ----- low-level fetch helper -----

type FetchResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text(): Promise<string>;
};

function carlFetch(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Referer: CARL + '/',
      Origin: CARL,
      'User-Agent': 'Mozilla/5.0 (AUTOcarl)',
      Accept: 'application/json, text/html, */*',
      ...(opts.headers || {}),
    };
    const req = net.request({
      method: opts.method || 'GET',
      url,
      session: carlSession(),
      useSessionCookies: true,
      redirect: 'follow',
    });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);

    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; reject(e); } };

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          text: async () => buf.toString('utf8'),
        });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    const timer = setTimeout(() => { req.abort(); fail(new Error('CARL request timed out')); }, 30_000);
    req.on('response', () => clearTimeout(timer));

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ----- auth -----

export async function loginCarl(email: string, password: string): Promise<{ id: string; name: string }> {
  // Auth payload mimics what the CARL login page sends. uniqueId is just an
  // internal page identifier from CARL's SPA; the value is non-secret and
  // appears constant across sessions, so we hardcode it.
  const body = JSON.stringify({
    username: email,
    password,
    uniqueId: 'page_1_4',
    screen: { width: 1400, height: 900, url: `${CARL}/login` },
    pageUrl: `${CARL}/login`,
  });
  const res = await carlFetch(`${CARL}/webapi/v1/app/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (res.status !== 200) throw new Error(`CARL login HTTP ${res.status}`);
  const data = JSON.parse(await res.text()) as {
    type?: string;
    msg?: string;
    token?: string;
    user?: { id?: string; name?: string };
  };
  if (data.type !== 'success') throw new Error(`CARL login rejected: ${data.msg || 'unknown'}`);
  const id = String(data.user?.id || '');
  const name = String(data.user?.name || '');
  if (!id) throw new Error('CARL auth response missing user.id');
  loggedInAs = email;
  lastUser = { id, name };
  // Stash the auth token returned in the response — the SPA echoes this
  // back on subsequent XHRs so the server can scope tokens to this session.
  authToken = data.token || null;
  return lastUser;
}

async function ensureLoggedIn(email: string, password: string): Promise<void> {
  if (loggedInAs === email) return;
  await loginCarl(email, password);
}

// ----- iCal URL discovery -----
//
// The personalized iCal URL is stored on the user's profile record in CARL
// as `field_246`. We fetch the profile via a stable encrypted token CARL's
// SPA uses (same token observed across sessions for the CT tenant), POSTing
// the user's own recordID as a param. Returns the iCal URL straight from
// the JSON response — no formula, no Playwright.

const USER_PROFILE_TOKEN = 'eyJpdiI6Im5DY3ZnVGRFelcyQTluYW91bVN4Ymc9PSIsInZhbHVlIjoiZkxDNjBuR3NzeTBaMFZUUzNEaTdyU2t0cE1aamdxOWNQR29lUzRDejY3ST0iLCJtYWMiOiIzYzIwNDQ1MzYyMmM1OGNkZGYzNGUwYWQxZTU5ZWU0MDY1ODUzM2I0NDI3ZjE3ZTE1MWY4MGRmNDY5ZDdhMmExIn0=';
const USER_TABLE_ID = '4MXQJdrZ6v';

export async function discoverIcalUrlViaApi(email: string, password: string): Promise<string> {
  const user = await loginCarl(email, password);

  const url = `${CARL}/webapi/v1/app/g/${USER_PROFILE_TOKEN}`;
  const body = `params%5BtableId%5D=${encodeURIComponent(USER_TABLE_ID)}&params%5BrecordID%5D=${encodeURIComponent(user.id)}`;
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    accept: 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest',
    referer: `${CARL}/crewcalendar`,
  };
  if (authToken) headers['x-tb-token'] = authToken;

  const res = await carlFetch(url, { method: 'POST', headers, body });
  if (res.status !== 200) throw new Error(`User profile HTTP ${res.status}`);
  const txt = await res.text();
  let data: unknown;
  try { data = JSON.parse(txt); } catch { throw new Error(`User profile returned non-JSON: ${txt.slice(0, 200)}`); }

  // Walk the response looking for field_246 anywhere — it lives on the
  // user's record. Different XHRs return it nested differently.
  let icalUrl = '';
  const walk = (v: unknown) => {
    if (icalUrl || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.field_246 === 'string' && o.field_246.startsWith('https://calendar')) {
      icalUrl = o.field_246;
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(data);

  if (!icalUrl) {
    throw new Error('User profile response did not contain field_246 (iCal URL). CARL may have changed the profile schema.');
  }
  return icalUrl;
}

// ----- booking details -----

export type CarlBookingDetails = {
  flights: Array<{
    pdfUrl: string;
    vendor?: string;
    confirmation?: string;
    bookedBy?: string;
    status?: string;
  }>;
  // CARL's API returns each contact (PM, LC, etc.) as a single-item XHR with
  // a `name` field. We collect them all here and let the caller disambiguate
  // by matching against booking.projectManager / booking.laborCoordinator.
  emailsByName: Record<string, string>;
  // Hotel reservations (fields 586-595) — laid out exactly like the flight
  // block above: name, booked-by, status, confirmation, files, notes, and
  // the two dates.
  hotels: Array<{
    name?: string;
    bookedBy?: string;
    status?: string;
    confirmation?: string;
    checkIn?: string;
    checkOut?: string;
    notes?: string;
    pdfUrl?: string;
  }>;

  perDiem?: number;
  venue?: string;
  venueAddress?: string;
  venueZip?: string;
  // CARL's "laborTravel" status (field_254), e.g. "Flight Requests Open to
  // Crew" or "Travel Details Pending". Only present when the LC has set one —
  // the field definition ships as an object on every booking, but the VALUE is
  // a string only on bookings where it's populated, which is what asString
  // keys on.
  laborTravel?: string;
  // CARL's own start/end for the WORK itself (fields 145/146). The calendar
  // feed's span is travel-inclusive, so these are what separate show days
  // from travel days. ISO YYYY-MM-DD.
  workStartDate?: string;
  workEndDate?: string;
  // How complete the record these dates came from was — see the parse below.
  workDatesScore?: number;
  // The "Booking Notes" text block from the booking page — LC instructions,
  // schedule details, etc. Plain text after entity decoding.
  bookingNotes?: string;
};

// Pull every encrypted handle the page would POST to /webapi/v1/app/g/.
// CARL bakes these into the HTML in two ways:
//   1. data-u-id="eyJ..."     — Angular component IDs
//   2. data-options='{...,"uId":"eyJ..."}'  — embedded JSON
// We capture both and dedupe.
function extractTokens(html: string): string[] {
  const tokens = new Set<string>();
  const add = (raw: string) => {
    const t = raw.trim();
    if (t.startsWith('eyJ') && t.length > 40) tokens.add(t);
  };
  for (const m of html.matchAll(/data-u-id="([^"]+)"/g)) add(m[1]);
  for (const m of html.matchAll(/data-u-id='([^']+)'/g)) add(m[1]);
  for (const m of html.matchAll(/"uId"\s*:\s*"([^"]+)"/g)) add(m[1]);
  for (const m of html.matchAll(/&quot;uId&quot;\s*:\s*&quot;([^&]+)&quot;/g)) add(m[1]);
  return Array.from(tokens);
}

type PostDiag = { status: number; bodyBytes: number; nonNull: boolean; sample?: string };
const lastPostDiags: PostDiag[] = [];
export function drainPostDiags(): PostDiag[] {
  const d = lastPostDiags.slice();
  lastPostDiags.length = 0;
  return d;
}

async function postOneToken(bookingId: string, token: string): Promise<unknown | null> {
  const url = `${CARL}/webapi/v1/app/g/${encodeURIComponent(token)}`;
  // Two body shapes show up in the page's own traffic. We send the larger
  // one — it's a strict superset, and unknown fields are ignored.
  const body = JSON.stringify({
    __cmode: 'get',
    rId: bookingId,
    pageRecordId: bookingId,
    pageUrl: `${CARL}/crewcalendar/booking-details-1/${bookingId}`,
  });
  // Laravel CSRF: the XSRF-TOKEN cookie's value must be echoed back as the
  // X-XSRF-TOKEN header for state-changing requests. Send a few SPA-typical
  // headers too so we look like the real client.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest',
    referer: `${CARL}/crewcalendar/booking-details-1/${bookingId}`,
  };
  // CARL's SPA echoes the auth-response token back as x-tb-token on every
  // API call. Without it the server returns
  // "You don't have permissions to access this page".
  if (authToken) headers['x-tb-token'] = authToken;

  try {
    const res = await carlFetch(url, { method: 'POST', headers, body });
    const txt = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(txt); } catch { /* */ }
    lastPostDiags.push({ status: res.status, bodyBytes: txt.length, nonNull: !!parsed, sample: txt.slice(0, 240) });
    if (res.status !== 200) return null;
    return parsed;
  } catch {
    lastPostDiags.push({ status: 0, bodyBytes: 0, nonNull: false });
    return null;
  }
}

// Walk a JSON value and run a visitor on every plain object encountered.
function visitObjects(v: unknown, fn: (o: Record<string, unknown>) => void): void {
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) {
      for (const item of v) visitObjects(item, fn);
    } else {
      fn(v as Record<string, unknown>);
      for (const k of Object.keys(v)) visitObjects((v as Record<string, unknown>)[k], fn);
    }
  }
}

function asNum(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim()) {
    const n = parseFloat(x);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asString(x: unknown): string | undefined {
  if (typeof x === 'string' && x.trim()) return x.trim();
  return undefined;
}

// Decode HTML entities — CARL serializes "&nbsp;" etc. in some text values.
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}


// CARL wraps some values in a record-id map, sometimes with the value in an
// array: {"VWQW7XRQZ4":["AC Hotel Palo Alto"]}. Dig out the first string.
function firstLeafString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) {
    for (const x of v) { const s = firstLeafString(x); if (s) return s; }
    return undefined;
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) { const s = firstLeafString(x); if (s) return s; }
    return undefined;
  }
  return undefined;
}

// Mine a single XHR response payload for booking facts.
function mergeResponse(resp: unknown, out: CarlBookingDetails): void {
  if (!resp || typeof resp !== 'object') return;

  visitObjects(resp, (obj) => {
    // ---- venue + per-diem (shape: field_44 / field_179 / field_238 / field_348) ----
    const venueName = asString(obj.field_44);
    if (venueName && !out.venue) out.venue = decodeEntities(venueName);

    // field_179.address = street, field_379 = "City, State", field_238.zip = zip.
    // We collect each piece on the booking-extras object and let the caller
    // (mergeResponse) assemble a single display string after the walk.
    const extras = out as CarlBookingDetails & { __street?: string; __cityState?: string };
    if (obj.field_179 && typeof obj.field_179 === 'object') {
      const addr = asString((obj.field_179 as Record<string, unknown>).address);
      if (addr && !extras.__street) extras.__street = decodeEntities(addr);
    }
    const cityState = asString(obj.field_379);
    if (cityState && !extras.__cityState) extras.__cityState = decodeEntities(cityState);
    if (obj.field_238 && typeof obj.field_238 === 'object') {
      const zip = asString((obj.field_238 as Record<string, unknown>).zip);
      if (zip && /^\d{5}/.test(zip) && !out.venueZip) out.venueZip = zip.slice(0, 5);
    }
    const pd = asNum(obj.field_348);
    if (pd !== undefined && pd > 0 && out.perDiem === undefined) out.perDiem = pd;

    // ---- labor travel status (field_254, e.g. "Flight Requests Open to Crew") ----
    const laborTravel = asString(obj.field_254);
    if (laborTravel && !out.laborTravel) out.laborTravel = decodeEntities(laborTravel);

    // ---- hotel reservation (fields 586-595) ----
    const hotelName = firstLeafString(obj.field_586);
    const checkIn = asString(obj.field_594);
    const checkOut = asString(obj.field_595);
    const hotelFiles = obj.field_591;
    const hasHotel = !!hotelName
      || (!!checkIn && /^\d{4}-\d{2}-\d{2}$/.test(checkIn))
      || (Array.isArray(hotelFiles) && hotelFiles.length > 0);
    if (hasHotel) {
      let pdfUrl: string | undefined;
      if (Array.isArray(hotelFiles)) {
        for (const f of hotelFiles) {
          if (f && typeof f === 'object') {
            const u = asString((f as Record<string, unknown>).url);
            if (u) { pdfUrl = u; break; }
          }
        }
      }
      const confirmation = asString(obj.field_589);
      const key = `${confirmation || ''}|${checkIn || ''}|${hotelName || ''}`;
      const already = out.hotels.some(
        (h) => `${h.confirmation || ''}|${h.checkIn || ''}|${h.name || ''}` === key,
      );
      if (!already) {
        const notes = asString(obj.field_593);
        out.hotels.push({
          name: hotelName,
          bookedBy: asString(obj.field_587),
          status: asString(obj.field_588),
          confirmation,
          checkIn: checkIn && /^\d{4}-\d{2}-\d{2}$/.test(checkIn) ? checkIn : undefined,
          checkOut: checkOut && /^\d{4}-\d{2}-\d{2}$/.test(checkOut) ? checkOut : undefined,
          notes: notes ? decodeEntities(notes) : undefined,
          pdfUrl,
        });
      }
    }

    // ---- work dates (fields 145/146) ----
    // The iCal feed publishes the TRAVEL-inclusive span; these two are the
    // job's own start/end, so the gap at each end is a travel day.
    // A booking whose dates were revised echoes BOTH the old and the new
    // values across responses (one of John's carries the note "Date Change -
    // Travel In - 9.6 - Start Date 9.7" beside the newer pair). The CURRENT
    // record is the fullest one — the stale copies come back thinner, missing
    // the notes and status the live record carries — so score each object by
    // how much it holds and keep the dates from the richest. Innermost breaks
    // an exact tie. Ordering can't matter: nothing here depends on which
    // response arrived first.
    const isoDate = (v: unknown): string | undefined => {
      const s = asString(v);
      return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
    };
    const ws = isoDate(obj.field_145);
    const we = isoDate(obj.field_146);
    if (ws || we) {
      const notes = asString(obj.field_162) || '';
      const score = Object.keys(obj).length * 1000 + Math.min(notes.length, 999);
      const best = out.workDatesScore ?? -1;
      if (score > best) {
        out.workDatesScore = score;
        if (ws) out.workStartDate = ws;
        if (we) out.workEndDate = we;
      } else if (score === best) {
        if (ws && (!out.workStartDate || ws > out.workStartDate)) out.workStartDate = ws;
        if (we && (!out.workEndDate || we < out.workEndDate)) out.workEndDate = we;
      }
    }

    // ---- booking notes (field_162 — CARL's own metadata names it
    // "bookingNotes", type Long Text). LC-authored, changes over a show's
    // life, so every sweep refreshes it. Long Text may carry markup: <br>
    // becomes a newline, any other tag is stripped.
    const notes = asString(obj.field_162);
    if (notes && !out.bookingNotes) {
      out.bookingNotes = decodeEntities(
        notes.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''),
      );
    }

    // ---- emails (shape: items containing { name, email }) ----
    // CARL returns each contact (PM, LC, etc.) as a separate single-item
    // response with a `name` field. We collect them all here; the caller
    // disambiguates by matching against booking.projectManager / .laborCoordinator.
    const email = asString(obj.email);
    const name = asString(obj.name);
    if (email && /@/.test(email) && name) {
      out.emailsByName[name] = email;
    }

    // ---- flights (shape: field_564 vendor, field_567 confirmation, field_569[].url) ----
    const vendorObj = obj.field_564;
    const confirmation = asString(obj.field_567);
    const bookedBy = asString(obj.field_565);
    const status = asString(obj.field_566);
    const files = obj.field_569;
    if (Array.isArray(files)) {
      for (const f of files) {
        if (!f || typeof f !== 'object') continue;
        const file = f as Record<string, unknown>;
        const url = asString(file.url);
        if (!url) continue;
        // Dedupe by URL.
        if (out.flights.some((x) => x.pdfUrl === url)) continue;
        let vendor: string | undefined;
        if (vendorObj && typeof vendorObj === 'object') {
          const v = Object.values(vendorObj as Record<string, unknown>)[0];
          vendor = asString(v);
        } else {
          vendor = asString(vendorObj);
        }
        out.flights.push({ pdfUrl: url, vendor, confirmation, bookedBy, status });
      }
    }
  });
}

// CARL is an Angular SPA — the raw `/crewcalendar/booking-details-1/...` URL
// returns just the empty app shell. The actual page template (with the
// encrypted data-u-id tokens baked in) is served from a sub-route on the
// tenant's app key. These constants come from CT's deployment and appear
// stable across users + sessions.
const CT_APP_KEY = 'PEryxM0jOn';
const BOOKING_DETAILS_PAGE_ID = '4PzQ4GgNJG';

// Public entry point — replaces scrapeBookingPage from the Playwright path.
export async function fetchBookingDetails(
  bookingId: string,
  email: string,
  password: string,
): Promise<CarlBookingDetails> {
  await ensureLoggedIn(email, password);

  // The page-template URL the SPA itself loads (with recordId as a query arg).
  // Returns rendered HTML with all the encrypted data-u-id tokens for this
  // booking — what the SPA would normally inject into the DOM.
  const ts = Date.now();
  const pageUrl = `${CARL}/app/${CT_APP_KEY}/pages/${BOOKING_DETAILS_PAGE_ID}.html?_=${ts}&recordId=${encodeURIComponent(bookingId)}`;
  const htmlRes = await carlFetch(pageUrl);
  if (htmlRes.status !== 200) throw new Error(`Booking page HTTP ${htmlRes.status}`);
  const html = await htmlRes.text();

  // If we got bounced back to login (cookie expired mid-sweep), re-auth once.
  if (/<input[^>]+name="password"/i.test(html) && /Sign\s*In/i.test(html)) {
    await loginCarl(email, password);
    return fetchBookingDetails(bookingId, email, password);
  }

  const tokens = extractTokens(html);
  const out: CarlBookingDetails & { __debug?: { htmlBytes: number; tokenCount: number } } = {
    flights: [],
    hotels: [],
    emailsByName: {},
    __debug: { htmlBytes: html.length, tokenCount: tokens.length },
  };
  if (tokens.length === 0) {
    return out;
  }

  // POST all tokens in parallel. Each returns JSON; we mine each for facts.
  const responses = await Promise.all(tokens.map((t) => postOneToken(bookingId, t)));
  for (const r of responses) mergeResponse(r, out);

  // Compose a single human-readable address from the parts we collected.
  // Example: "3150 Paradise Rd, Las Vegas, NV 89109"
  const extras = out as CarlBookingDetails & { __street?: string; __cityState?: string };
  const street = extras.__street;
  const cityState = extras.__cityState;
  const zip = out.venueZip;
  const tail = cityState && zip ? `${cityState} ${zip}` : (cityState || zip || '');
  const pieces = [street, tail].filter(Boolean);
  if (pieces.length > 0) out.venueAddress = pieces.join(', ');
  delete extras.__street;
  delete extras.__cityState;

  return out;
}
