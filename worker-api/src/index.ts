// AUTOcarl web API — the desktop app's main process, as a Cloudflare Worker.
//
// The browser build of the renderer talks to this instead of Electron IPC.
// Credentials live in the USER'S browser (localStorage), never here: each
// request carries them, we keep only short-lived session cookie jars in KV
// (keyed by a credential hash) so consecutive calls skip the login cost.
//
// CARL is fetched directly. SSW's legacy TLS is unreachable from Workers,
// so its traffic tunnels through a host-locked PHP relay on somersaudio.com
// (see relay.php) — the logic all lives here; the relay is a dumb pipe.

import {
  CookieJar, DirectTransport, RelayTransport, sessionKey,
  type Transport, type SessionState,
} from './transport';
import * as carl from './carl';
import * as ssw from './ssw';

export interface Env {
  SESS: KVNamespace;
  // Workers AI — vision-model OCR for the web app's receipt photos (the
  // desktop uses Apple Vision locally; this is the browser's stand-in).
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  // Service binding to the autocarl-friends worker — a direct workers.dev
  // fetch between two workers on the same account is blocked (CF error 1042).
  FRIENDS: { fetch: typeof fetch };
  RELAY_KEY: string;
  // Shared secret for the friends worker's /v1/reissue endpoint.
  FRIENDS_KEY?: string;
  LOGODEV_SECRET?: string;
  LOGODEV_PUBLISHABLE?: string;
  GSA_API_KEY?: string;
}

const RELAY_URL = 'https://somersaudio.com/autocarl/api/relay.php';
const SESSION_TTL_S = 1500;

const ALLOWED_ORIGINS = new Set([
  'https://somersaudio.com',
  'https://www.somersaudio.com',
  'http://127.0.0.1:8931',
  'http://localhost:8931',
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      }
    : {};
}

function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req) },
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- session persistence around the ported modules -----------------------

async function loadSession(env: Env, key: string): Promise<SessionState | null> {
  return env.SESS.get<SessionState>(key, 'json');
}

async function saveSession(env: Env, key: string, jar: CookieJar, token: string | null): Promise<void> {
  const state: SessionState = { cookies: jar.toJSON(), token: token ?? undefined, ts: Date.now() };
  await env.SESS.put(key, JSON.stringify(state), { expirationTtl: SESSION_TTL_S });
}

// Run `op` with a live CARL session: cached jar first, fresh login on miss
// or expiry, one retry.
async function withCarl<T>(
  env: Env, email: string, password: string,
  op: (t: Transport, s: carl.CarlSession) => Promise<T>,
): Promise<T> {
  const t = new DirectTransport();
  const key = await sessionKey('carl', email, password);
  const cached = await loadSession(env, key);
  let session: carl.CarlSession = cached
    ? { jar: CookieJar.fromJSON(cached.cookies), token: cached.token ?? null }
    : await carl.carlLogin(t, email, password);
  if (!cached) await saveSession(env, key, session.jar, session.token);
  try {
    const out = await op(t, session);
    await saveSession(env, key, session.jar, session.token);
    return out;
  } catch (e) {
    if (!(e instanceof carl.SessionExpiredError)) throw e;
    session = await carl.carlLogin(t, email, password);
    const out = await op(t, session);
    await saveSession(env, key, session.jar, session.token);
    return out;
  }
}

async function withSsw<T>(
  env: Env, email: string, password: string,
  op: (t: Transport, s: ssw.SswSession) => Promise<T>,
): Promise<T> {
  const t = new RelayTransport(RELAY_URL, env.RELAY_KEY);
  const key = await sessionKey('ssw', email, password);
  const cached = await loadSession(env, key);
  let session: ssw.SswSession = cached
    ? { jar: CookieJar.fromJSON(cached.cookies), token: cached.token ?? null }
    : await ssw.sswLogin(t, email, password);
  if (!cached) await saveSession(env, key, session.jar, session.token);
  try {
    const out = await op(t, session);
    await saveSession(env, key, session.jar, session.token);
    return out;
  } catch (e) {
    if (!(e instanceof ssw.SessionExpiredError)) throw e;
    session = await ssw.sswLogin(t, email, password);
    const out = await op(t, session);
    await saveSession(env, key, session.jar, session.token);
    return out;
  }
}

// ---- small ports ---------------------------------------------------------

async function gsaRateForZip(env: Env, zip: string): Promise<unknown> {
  const cleaned = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(cleaned)) return null;
  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  const url = `https://api.gsa.gov/travel/perdiem/v2/rates/zip/${cleaned}/year/${year}?api_key=${encodeURIComponent(env.GSA_API_KEY || 'DEMO_KEY')}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json() as {
    rates?: Array<{ rate?: Array<{ meals?: number; months?: { month?: Array<{ value?: number }> } }>; city?: string; state?: string }>;
  };
  const r = data.rates?.[0]?.rate?.[0];
  if (!r || typeof r.meals !== 'number') return null;
  const monthly = (r.months?.month || []).map((m) => m.value).filter((v): v is number => typeof v === 'number');
  return {
    meals: r.meals,
    lodging: monthly.length ? Math.round(monthly.reduce((a, b) => a + b, 0) / monthly.length) : undefined,
    city: data.rates?.[0]?.city,
    state: data.rates?.[0]?.state,
    zip: cleaned,
    year,
  };
}

function logoQuery(jobName: string): string {
  const beforeDash = (jobName.split(/\s[-–—]\s/)[0] || jobName).trim();
  return (beforeDash.split(/\s+/)[0] || '').replace(/[^A-Za-z0-9&]/g, '');
}

async function jobLogo(env: Env, jobName: string): Promise<string | null> {
  const query = logoQuery(jobName);
  if (!query || !env.LOGODEV_SECRET || !env.LOGODEV_PUBLISHABLE) return null;
  const sr = await fetch(`https://api.logo.dev/search?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${env.LOGODEV_SECRET}` },
  });
  if (!sr.ok) return null;
  const list = await sr.json() as Array<{ domain?: string }>;
  const domain = Array.isArray(list) && list[0]?.domain ? list[0].domain : null;
  if (!domain) return null;
  const ir = await fetch(`https://img.logo.dev/${encodeURIComponent(domain)}?token=${env.LOGODEV_PUBLISHABLE}&size=64&format=png&retina=true`);
  if (!ir.ok) return null;
  const buf = new Uint8Array(await ir.arrayBuffer());
  if (buf.length === 0) return null;
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return `data:${ir.headers.get('content-type') || 'image/png'};base64,${btoa(bin)}`;
}

// ---- router --------------------------------------------------------------

type Body = Record<string, unknown>;

async function readBody(req: Request): Promise<Body> {
  try { return await req.json() as Body; } catch { return {}; }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    try {
      // ---- calendar proxy (no auth — the URL itself is the secret) ----
      if (path === '/v1/ical' && req.method === 'GET') {
        const u = url.searchParams.get('u') || '';
        if (!/^https:\/\/calendar\.[a-z0-9.-]*carl\.ctus\.live\//i.test(u)) {
          return json(req, { error: 'not a CARL calendar link' }, 400);
        }
        const r = await fetch(u, { headers: { 'User-Agent': 'AUTOcarl-web/1' } });
        return new Response(await r.text(), {
          status: r.ok ? 200 : 502,
          headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req) },
        });
      }

      if (req.method !== 'POST' && path !== '/v1/gsa') {
        return json(req, { error: 'not found' }, 404);
      }

      // ---- CARL ----
      if (path === '/v1/carl/verify') {
        const b = await readBody(req);
        await withCarl(env, str(b.email), str(b.password), async () => null);
        return json(req, { ok: true });
      }
      if (path === '/v1/carl/discover') {
        const b = await readBody(req);
        const icalUrl = await withCarl(env, str(b.email), str(b.password), (t, s) =>
          carl.discoverIcalUrlViaApi(t, s, str(b.email), str(b.password)));
        return json(req, { icalUrl });
      }
      if (path === '/v1/carl/details') {
        const b = await readBody(req);
        const bookingId = str(b.bookingId);
        if (!/^[A-Za-z0-9]{4,32}$/.test(bookingId)) return json(req, { error: 'bad bookingId' }, 400);
        const details = await withCarl(env, str(b.email), str(b.password), (t, s) =>
          carl.fetchBookingDetails(t, s, bookingId));
        return json(req, details);
      }

      // ---- SSW ----
      if (path === '/v1/ssw/verify') {
        const b = await readBody(req);
        await withSsw(env, str(b.email), str(b.password), async () => null);
        return json(req, { ok: true });
      }
      if (path === '/v1/ssw/week') {
        const b = await readBody(req);
        const week = await withSsw(env, str(b.email), str(b.password), (t, s) =>
          ssw.fetchWeek(t, s, str(b.weekMonday)));
        return json(req, week);
      }
      if (path === '/v1/ssw/create') {
        const b = await readBody(req);
        const cfg = (b.cfg ?? {}) as { defaultDailyRate?: number; timesheetEmail?: string };
        const week = await withSsw(env, str(b.email), str(b.password), (t, s) =>
          ssw.createWeek(t, s, str(b.weekMonday), {
            defaultDailyRate: typeof cfg.defaultDailyRate === 'number' ? cfg.defaultDailyRate : 0,
            timesheetEmail: str(cfg.timesheetEmail),
          }));
        return json(req, week);
      }
      if (path === '/v1/ssw/save') {
        const b = await readBody(req);
        const cfg = (b.cfg ?? {}) as { defaultDailyRate?: number; timesheetEmail?: string };
        const result = await withSsw(env, str(b.email), str(b.password), (t, s) =>
          ssw.pushWeek(t, s, b.week as never, {
            defaultDailyRate: typeof cfg.defaultDailyRate === 'number' ? cfg.defaultDailyRate : 0,
            timesheetEmail: str(cfg.timesheetEmail),
          }));
        return json(req, result);
      }

      // ---- receipt OCR (web expenses; desktop runs Apple Vision locally) ----
      // Input: { image: <base64 JPEG/PNG, no data: prefix>, mime? }.
      // Output: { text } — a plain transcription, so the SAME parsing
      // heuristics run on it as on the desktop's OCR output.
      if (path === '/v1/receipt-ocr') {
        // Anonymous like /v1/logo, but AI inference is costlier — damp abuse
        // with a per-IP hourly cap (approximate; KV isn't atomic, close enough).
        const ip = req.headers.get('cf-connecting-ip') || 'unknown';
        const rlKey = `ocr-rl:${ip}`;
        const used = parseInt((await env.SESS.get(rlKey)) || '0', 10);
        if (used >= 60) return json(req, { error: 'Too many receipts this hour — try again later.' }, 429);
        await env.SESS.put(rlKey, String(used + 1), { expirationTtl: 3600 });

        const b = await readBody(req);
        const image = str(b.image);
        const mime = str(b.mime) || 'image/jpeg';
        if (!image || image.length > 4_000_000 || !/^image\/(jpeg|png)$/.test(mime)) {
          return json(req, { error: 'bad image' }, 400);
        }
        const result = await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Transcribe ALL text visible in this receipt image, line by line, top to bottom, exactly as printed. Keep amounts, labels, and their line positions. Output ONLY the transcribed text — no commentary, no formatting, no markdown.',
              },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${image}` } },
            ],
          }],
          // Long itemized receipts (grocery, pharmacy) can run hundreds of
          // lines and the Total prints at the BOTTOM — a low cap would cut
          // exactly the line the parser needs.
          max_tokens: 4000,
        });
        const text = typeof result === 'object' && result !== null && 'response' in result
          ? String((result as { response: unknown }).response ?? '')
          : '';
        return json(req, { text });
      }

      // ---- logo + GSA ----
      if (path === '/v1/logo') {
        const b = await readBody(req);
        return json(req, { dataUri: await jobLogo(env, str(b.jobName)) });
      }
      if (path === '/v1/gsa' && req.method === 'GET') {
        return json(req, await gsaRateForZip(env, url.searchParams.get('zip') || ''));
      }

      // ---- friends (tokens stay client-side; we just relay them) ----
      // Mirrors src/web/api-shim.ts's contract on one side and the friends
      // worker's real API on the other.
      if (path.startsWith('/v1/friends/')) {
        const call = (sub: string, init: {
          method?: string; token?: string; body?: unknown; headers?: Record<string, string>;
        } = {}) =>
          env.FRIENDS.fetch(`https://autocarl-friends.internal${sub}`, {
            method: init.method || 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
              ...(init.headers || {}),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          });
        const passthrough = async (r: Response) => new Response(await r.text(), {
          status: r.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req) },
        });
        const b = await readBody(req);
        const token = str(b.token);

        if (path === '/v1/friends/enroll') {
          const rawEmail = str(b.email).trim();
          const email = rawEmail.toLowerCase();
          const name = str(b.name).trim();
          if (!email || !str(b.password) || !name) {
            return json(req, { error: 'email, password, and name are required.' }, 400);
          }
          // Prove the caller controls this CARL account before handing out
          // a friends identity bound to its email.
          await withCarl(env, rawEmail, str(b.password), async () => null);
          let r = await call('/v1/register', { body: { email, name } });
          let linked = false;
          if (r.status === 409) {
            // The email already has a friends account (say, enrolled on the
            // desktop) — issue an ADDITIONAL token for this device. `linked`
            // tells the client to say so, which is also the tripwire for an
            // account someone else created on this email first.
            linked = true;
            r = await call('/v1/reissue', {
              body: { email },
              headers: { 'X-Internal-Key': env.FRIENDS_KEY || '' },
            });
          }
          const data = await r.json() as {
            token?: string; name?: string; error?: string;
            accountCreatedAt?: string; firstVerified?: boolean;
          };
          if (!r.ok || !data.token) {
            return json(req, { error: data.error || `Friends service HTTP ${r.status}` }, 502);
          }
          return json(req, {
            token: data.token,
            name: data.name || name,
            ...(linked ? {
              linked: true,
              accountCreatedAt: data.accountCreatedAt ?? null,
              firstVerified: data.firstVerified === true,
            } : {}),
          });
        }
        if (path === '/v1/friends/publish') {
          return passthrough(await call('/v1/schedule', { method: 'PUT', token, body: { gigs: b.gigs } }));
        }
        if (path === '/v1/friends/list') {
          return passthrough(await call('/v1/friends', { method: 'GET', token }));
        }
        if (path === '/v1/friends/request') {
          return passthrough(await call('/v1/friends/request', { token, body: { email: str(b.email) } }));
        }
        if (path === '/v1/friends/respond') {
          return passthrough(await call('/v1/friends/respond', {
            token, body: { email: str(b.email), accept: b.accept === true },
          }));
        }
        if (path === '/v1/friends/remove') {
          return passthrough(await call(`/v1/friends/${encodeURIComponent(str(b.email))}`, {
            method: 'DELETE', token,
          }));
        }
      }

      return json(req, { error: 'not found' }, 404);
    } catch (e) {
      return json(req, { error: errText(e) }, 500);
    }
  },
};
