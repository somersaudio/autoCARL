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
  RELAY_KEY: string;
  LOGODEV_SECRET?: string;
  LOGODEV_PUBLISHABLE?: string;
  GSA_API_KEY?: string;
}

const RELAY_URL = 'https://somersaudio.com/autocarl/api/relay.php';
const FRIENDS_URL = 'https://autocarl-friends.somerss.workers.dev';
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

      // ---- logo + GSA ----
      if (path === '/v1/logo') {
        const b = await readBody(req);
        return json(req, { dataUri: await jobLogo(env, str(b.jobName)) });
      }
      if (path === '/v1/gsa' && req.method === 'GET') {
        return json(req, await gsaRateForZip(env, url.searchParams.get('zip') || ''));
      }

      // ---- friends passthrough (token stays client-side) ----
      if (path.startsWith('/v1/friends-proxy/')) {
        const b = await readBody(req);
        const sub = path.slice('/v1/friends-proxy'.length);
        if (!/^\/v1\/[a-z/@.%-]*$/i.test(sub)) return json(req, { error: 'bad path' }, 400);
        const r = await fetch(FRIENDS_URL + sub, {
          method: str(b.method) || 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(str(b.token) ? { Authorization: `Bearer ${str(b.token)}` } : {}),
          },
          body: b.payload !== undefined ? JSON.stringify(b.payload) : undefined,
        });
        return new Response(await r.text(), {
          status: r.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
        });
      }

      return json(req, { error: 'not found' }, 404);
    } catch (e) {
      return json(req, { error: errText(e) }, 500);
    }
  },
};
