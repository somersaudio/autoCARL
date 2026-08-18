// Direct CARL API client — Worker port of src/main/carl-api.ts.
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
//   2. GET the booking-details page template → page HTML
//   3. Regex out every data-u-id token from the HTML
//   4. POST each one to /webapi/v1/app/g/{token}
//   5. Scan all JSON responses for the fields we care about
//
// Workers are stateless, so where the desktop kept module-level state
// (cookie partition, authToken, loggedInAs), this port threads a CarlSession
// through every call. The router persists it (KV) and owns re-login: when
// fetchBookingDetails detects a login bounce it throws SessionExpiredError
// instead of re-authenticating itself.

import {
  Transport,
  FetchOpts,
  FetchResult,
  CookieJar,
  fetchWithJar,
} from './transport';

export const CARL = 'https://carl.ctus.live';

export type CarlSession = { jar: CookieJar; token: string | null };

export class SessionExpiredError extends Error {
  constructor(message = 'CARL session expired (bounced to login)') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

// ----- low-level fetch helper -----

// Same default headers the desktop's carlFetch set on every request; the
// cookie jar ride-along comes from fetchWithJar.
function carlFetch(
  t: Transport,
  jar: CookieJar,
  url: string,
  opts: FetchOpts = {},
): Promise<FetchResult> {
  return fetchWithJar(t, jar, url, {
    method: opts.method,
    body: opts.body,
    headers: {
      Referer: CARL + '/',
      Origin: CARL,
      'User-Agent': 'Mozilla/5.0 (AUTOcarl)',
      Accept: 'application/json, text/html, */*',
      ...(opts.headers || {}),
    },
  });
}

// ----- auth -----

// Shared core of carlLogin/discoverIcalUrlViaApi: POST the auth endpoint,
// absorb session cookies into `jar`, return the x-tb-token value and user.
async function authenticate(
  t: Transport,
  jar: CookieJar,
  email: string,
  password: string,
): Promise<{ token: string | null; user: { id: string; name: string } }> {
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
  const res = await carlFetch(t, jar, `${CARL}/webapi/v1/app/auth`, {
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
  // The auth token returned in the response — the SPA echoes this back on
  // subsequent XHRs (x-tb-token) so the server can scope tokens to this session.
  return { token: data.token || null, user: { id, name } };
}

export async function carlLogin(
  t: Transport,
  email: string,
  password: string,
): Promise<CarlSession> {
  const jar = new CookieJar();
  const { token } = await authenticate(t, jar, email, password);
  return { jar, token };
}

// ----- iCal URL discovery -----
//
// The personalized iCal URL is stored on the user's profile record in CARL
// as `field_246`. We fetch the profile via a stable encrypted token CARL's
// SPA uses (same token observed across sessions for the CT tenant), POSTing
// the user's own recordID as a param. Returns the iCal URL straight from
// the JSON response.
//
// NOTE: unlike the signature sketched in the port plan, this takes the
// password too — the desktop version performs a fresh login here because it
// needs user.id from the auth response (the profile POST's recordID param),
// and CarlSession doesn't carry a user id. The fresh login's cookies/token
// are written back into `s`, mirroring how the desktop refreshed its
// session partition + module-level authToken.

const USER_PROFILE_TOKEN = 'eyJpdiI6Im5DY3ZnVGRFelcyQTluYW91bVN4Ymc9PSIsInZhbHVlIjoiZkxDNjBuR3NzeTBaMFZUUzNEaTdyU2t0cE1aamdxOWNQR29lUzRDejY3ST0iLCJtYWMiOiIzYzIwNDQ1MzYyMmM1OGNkZGYzNGUwYWQxZTU5ZWU0MDY1ODUzM2I0NDI3ZjE3ZTE1MWY4MGRmNDY5ZDdhMmExIn0=';
const USER_TABLE_ID = '4MXQJdrZ6v';

export async function discoverIcalUrlViaApi(
  t: Transport,
  s: CarlSession,
  email: string,
  password: string,
): Promise<string> {
  const { token, user } = await authenticate(t, s.jar, email, password);
  s.token = token;

  const url = `${CARL}/webapi/v1/app/g/${USER_PROFILE_TOKEN}`;
  const body = `params%5BtableId%5D=${encodeURIComponent(USER_TABLE_ID)}&params%5BrecordID%5D=${encodeURIComponent(user.id)}`;
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    accept: 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest',
    referer: `${CARL}/crewcalendar`,
  };
  if (s.token) headers['x-tb-token'] = s.token;

  const res = await carlFetch(t, s.jar, url, { method: 'POST', headers, body });
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

async function postOneToken(
  t: Transport,
  s: CarlSession,
  bookingId: string,
  token: string,
): Promise<unknown | null> {
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
  if (s.token) headers['x-tb-token'] = s.token;

  try {
    const res = await carlFetch(t, s.jar, url, { method: 'POST', headers, body });
    const txt = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(txt); } catch { /* */ }
    if (res.status !== 200) return null;
    return parsed;
  } catch {
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

// Mine a single XHR response payload for booking facts.
function mergeResponse(resp: unknown, out: CarlBookingDetails): void {
  if (!resp || typeof resp !== 'object') return;

  visitObjects(resp, (obj) => {
    // ---- venue + per-diem (shape: field_44 / field_179 / field_238 / field_348) ----
    const venueName = asString(obj.field_44);
    if (venueName && !out.venue) out.venue = decodeEntities(venueName);

    // field_179.address = street, field_379 = "City, State", field_238.zip = zip.
    // We collect each piece on the booking-extras object and let the caller
    // (fetchBookingDetails) assemble a single display string after the walk.
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

// Public entry point. Where the desktop re-authenticated on a login bounce,
// this throws SessionExpiredError — the router owns credentials, so it
// re-logs-in (carlLogin) and retries.
export async function fetchBookingDetails(
  t: Transport,
  s: CarlSession,
  bookingId: string,
): Promise<CarlBookingDetails> {
  // The page-template URL the SPA itself loads (with recordId as a query arg).
  // Returns rendered HTML with all the encrypted data-u-id tokens for this
  // booking — what the SPA would normally inject into the DOM.
  const ts = Date.now();
  const pageUrl = `${CARL}/app/${CT_APP_KEY}/pages/${BOOKING_DETAILS_PAGE_ID}.html?_=${ts}&recordId=${encodeURIComponent(bookingId)}`;
  const htmlRes = await carlFetch(t, s.jar, pageUrl);
  if (htmlRes.status !== 200) throw new Error(`Booking page HTTP ${htmlRes.status}`);
  const html = await htmlRes.text();

  // If we got bounced back to login (cookie expired mid-sweep), the session
  // is dead — the router re-logs-in and retries.
  if (/<input[^>]+name="password"/i.test(html) && /Sign\s*In/i.test(html)) {
    throw new SessionExpiredError();
  }

  const tokens = extractTokens(html);
  const out: CarlBookingDetails = {
    flights: [],
    emailsByName: {},
  };
  if (tokens.length === 0) {
    return out;
  }

  // POST all tokens in parallel. Each returns JSON; we mine each for facts.
  const responses = await Promise.all(tokens.map((tok) => postOneToken(t, s, bookingId, tok)));
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
