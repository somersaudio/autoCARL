// AUTOcarl friends service.
//
// Mutual-consent gig sharing for crew: each app publishes a COARSE schedule
// (job number/name, city/state, date range — nothing finer), and only
// accepted friends can read each other's. Privacy posture:
//   - both sides must consent (request + accept) before anything is visible
//   - schedules are capped to a ~120-day future window and overwritten on
//     every publish — no history accumulates
//   - DELETE /v1/me wipes the user, their schedule, and every edge
//
// Identity is honest-but-informal, matching a trusted crew: registration
// binds an email first-come and returns a bearer token; the real trust gate
// is the human clicking Accept on a request from a name they know.

interface Gig {
  jobNumber: string;
  jobName: string;
  city: string;
  state: string;
  start: string;   // ISO YYYY-MM-DD
  end: string;     // ISO YYYY-MM-DD
}

type UserRow = { id: string; email: string; name: string; token_hash: string };

// Secrets (INTERNAL_KEY) aren't in wrangler.jsonc, so the generated Env
// doesn't know them; merge the field in here.
declare global {
  interface Env { INTERNAL_KEY?: string }
}

const MAX_GIGS = 50;
const MAX_STR = 120;
const MAX_BODY = 64 * 1024;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const err = (status: number, message: string): Response => json({ error: message }, status);

async function sha256b64(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

// Bearer token: "<userId>.<secret>". The id routes to the row; only the
// secret's hash is stored. A user can hold several valid tokens at once —
// the original one on the users row plus per-device extras in `tokens`
// (issued by /v1/reissue when a second device signs on).
async function authenticate(req: Request, env: Env): Promise<UserRow | null> {
  const header = req.headers.get('authorization') || '';
  const m = header.match(/^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,64})$/);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT id, email, name, token_hash FROM users WHERE id = ?')
    .bind(m[1]).first<UserRow>();
  if (!row) return null;
  const hash = await sha256b64(m[2]);
  if (timingSafeEqualStr(hash, row.token_hash)) return row;
  const extra = await env.DB.prepare('SELECT 1 FROM tokens WHERE user_id = ? AND token_hash = ?')
    .bind(row.id, hash).first();
  return extra ? row : null;
}

function mintSecret(): string {
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  return btoa(String.fromCharCode(...secretBytes))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function cleanStr(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function cleanGigs(v: unknown): Gig[] | null {
  if (!Array.isArray(v) || v.length > MAX_GIGS) return null;
  const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const out: Gig[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null;
    const g = raw as Record<string, unknown>;
    const start = cleanStr(g.start, 10);
    const end = cleanStr(g.end, 10);
    if (!ISO_DAY.test(start) || !ISO_DAY.test(end)) return null;
    if (start > horizon) continue;               // beyond the sharing window
    out.push({
      jobNumber: cleanStr(g.jobNumber, 24),
      jobName: cleanStr(g.jobName),
      city: cleanStr(g.city, 60),
      state: cleanStr(g.state, 30),
      start,
      end: end > horizon ? horizon : end,
    });
  }
  return out;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const len = parseInt(req.headers.get('content-length') || '0', 10);
  if (len > MAX_BODY) return null;
  try {
    const parsed: unknown = await req.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT id, email, name, token_hash FROM users WHERE email = ?')
    .bind(email).first<UserRow>();
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    try {
      // ---- open endpoint ----
      if (route === 'POST /v1/register') {
        const body = await readBody(req);
        if (!body) return err(400, 'Bad JSON body.');
        const email = cleanStr(body.email).toLowerCase();
        const name = cleanStr(body.name, 60);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, 'A valid email is required.');
        if (!name) return err(400, 'A display name is required.');
        if (await findUserByEmail(env, email)) {
          return err(409, 'This email is already registered. If you lost access, ask John to reset it.');
        }
        const id = crypto.randomUUID();
        const secret = mintSecret();
        await env.DB.prepare(
          'INSERT INTO users (id, email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(id, email, name, await sha256b64(secret), new Date().toISOString()).run();
        console.log(JSON.stringify({ event: 'register', email }));
        return json({ userId: id, token: `${id}.${secret}` }, 201);
      }

      // ---- internal endpoint: an ADDITIONAL token for an existing account.
      // Only autocarl-api may call this (shared secret), and only after IT
      // has verified the caller controls the CARL account for that email.
      // Existing tokens are never rotated — a phone signing on must not
      // sign the desktop off.
      if (route === 'POST /v1/reissue') {
        const key = req.headers.get('x-internal-key') || '';
        if (!env.INTERNAL_KEY || !timingSafeEqualStr(key, env.INTERNAL_KEY)) {
          return err(401, 'Missing or invalid token.');
        }
        const body = await readBody(req);
        const email = body ? cleanStr(body.email).toLowerCase() : '';
        const user = email
          ? await env.DB.prepare(
              'SELECT id, name, created_at, verified_at FROM users WHERE email = ?',
            ).bind(email).first<{ id: string; name: string; created_at: string; verified_at: string | null }>()
          : null;
        if (!user) return err(404, 'No friends account with that email.');
        const secret = mintSecret();
        await env.DB.prepare(
          'INSERT INTO tokens (user_id, token_hash, created_at) VALUES (?, ?, ?)',
        ).bind(user.id, await sha256b64(secret), new Date().toISOString()).run();
        // Audit trail: registration is open/first-come, so the first
        // CARL-verified sign-on is the moment the email's true owner claims
        // the account. Record it, and tell the caller whether the account
        // predates any verified claim so the client can surface "you had an
        // existing account" — the tripwire that catches an email squatted
        // by someone else before its owner ever enrolled.
        const firstVerified = !user.verified_at;
        if (firstVerified) {
          await env.DB.prepare('UPDATE users SET verified_at = ? WHERE id = ?')
            .bind(new Date().toISOString(), user.id).run();
        }
        console.log(JSON.stringify({ event: 'reissue', email, firstVerified, accountCreatedAt: user.created_at }));
        return json({
          token: `${user.id}.${secret}`,
          name: user.name,
          accountCreatedAt: user.created_at,
          firstVerified,
        });
      }

      // ---- everything else requires auth ----
      const me = await authenticate(req, env);
      if (!me) return err(401, 'Missing or invalid token.');

      if (route === 'GET /v1/me') {
        return json({ email: me.email, name: me.name });
      }

      if (route === 'PUT /v1/schedule') {
        const body = await readBody(req);
        const gigs = body ? cleanGigs(body.gigs) : null;
        if (!gigs) return err(400, 'gigs must be an array of {jobNumber, jobName, city, state, start, end}.');
        await env.DB.prepare(
          `INSERT INTO schedules (user_id, gigs_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET gigs_json = excluded.gigs_json, updated_at = excluded.updated_at`,
        ).bind(me.id, JSON.stringify(gigs), new Date().toISOString()).run();
        return json({ ok: true, gigs: gigs.length });
      }

      if (route === 'POST /v1/friends/request') {
        const body = await readBody(req);
        const email = body ? cleanStr(body.email).toLowerCase() : '';
        if (!email) return err(400, 'email is required.');
        if (email === me.email) return err(400, "That's you.");
        const other = await findUserByEmail(env, email);
        // Same response whether or not the account exists — a friends list
        // shouldn't double as a directory of who uses the app.
        if (!other) return json({ ok: true, status: 'pending' });
        const existing = await env.DB.prepare(
          `SELECT requester_id, status FROM friendships
           WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`,
        ).bind(me.id, other.id).first<{ requester_id: string; status: string }>();
        if (existing) {
          if (existing.status === 'accepted') return json({ ok: true, status: 'accepted' });
          if (existing.requester_id === me.id) return json({ ok: true, status: 'pending' });
          // They already asked us — a request back is consent from both sides.
          await env.DB.prepare(
            'UPDATE friendships SET status = ? WHERE requester_id = ? AND addressee_id = ?',
          ).bind('accepted', other.id, me.id).run();
          return json({ ok: true, status: 'accepted' });
        }
        await env.DB.prepare(
          'INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?)',
        ).bind(me.id, other.id, 'pending', new Date().toISOString()).run();
        return json({ ok: true, status: 'pending' });
      }

      if (route === 'POST /v1/friends/respond') {
        const body = await readBody(req);
        const email = body ? cleanStr(body.email).toLowerCase() : '';
        const accept = body ? body.accept === true : false;
        const other = email ? await findUserByEmail(env, email) : null;
        if (!other) return err(404, 'No pending request from that email.');
        const pending = await env.DB.prepare(
          `SELECT 1 FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`,
        ).bind(other.id, me.id).first();
        if (!pending) return err(404, 'No pending request from that email.');
        if (accept) {
          await env.DB.prepare(
            'UPDATE friendships SET status = ? WHERE requester_id = ? AND addressee_id = ?',
          ).bind('accepted', other.id, me.id).run();
        } else {
          await env.DB.prepare(
            'DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ?',
          ).bind(other.id, me.id).run();
        }
        return json({ ok: true });
      }

      if (route === 'GET /v1/friends') {
        // PRIVACY MODEL: a friend only ever sees the gigs you SHARE — the
        // intersection by job number — never your whole schedule. Publishing
        // a full schedule to the server is what makes the intersection
        // computable; revealing it wholesale is exactly what we don't do.
        const mine = await env.DB.prepare(
          'SELECT gigs_json FROM schedules WHERE user_id = ?1',
        ).bind(me.id).first<{ gigs_json: string | null }>();
        const myJobs = new Set(
          (mine?.gigs_json ? JSON.parse(mine.gigs_json) as Gig[] : [])
            .map((g) => g.jobNumber).filter(Boolean),
        );

        const rows = await env.DB.prepare(
          `SELECT u.email, u.name, f.status, f.requester_id = ?1 AS outgoing,
                  s.gigs_json, s.updated_at
           FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END
           LEFT JOIN schedules s ON s.user_id = u.id
           WHERE f.requester_id = ?1 OR f.addressee_id = ?1`,
        ).bind(me.id).all<{
          email: string; name: string; status: string; outgoing: number;
          gigs_json: string | null; updated_at: string | null;
        }>();
        const accepted = [], incoming = [], outgoing = [];
        for (const r of rows.results) {
          if (r.status === 'accepted') {
            const theirs = r.gigs_json ? JSON.parse(r.gigs_json) as Gig[] : [];
            accepted.push({
              email: r.email, name: r.name,
              // Only shared shows cross the wire.
              gigs: theirs.filter((g) => myJobs.has(g.jobNumber)),
              updatedAt: r.updated_at,
            });
          } else if (r.outgoing) {
            outgoing.push({ email: r.email, name: r.name });
          } else {
            incoming.push({ email: r.email, name: r.name });
          }
        }
        return json({ accepted, incoming, outgoing });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/friends/')) {
        const email = decodeURIComponent(url.pathname.slice('/v1/friends/'.length)).toLowerCase();
        const other = await findUserByEmail(env, email);
        if (other) {
          await env.DB.prepare(
            `DELETE FROM friendships
             WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`,
          ).bind(me.id, other.id).run();
        }
        return json({ ok: true });
      }

      if (route === 'DELETE /v1/me') {
        // users CASCADEs into friendships and schedules.
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(me.id).run();
        console.log(JSON.stringify({ event: 'delete-me', email: me.email }));
        return json({ ok: true });
      }

      return err(404, 'No such endpoint.');
    } catch (e) {
      console.log(JSON.stringify({ event: 'error', route, message: e instanceof Error ? e.message : String(e) }));
      return err(500, 'Internal error.');
    }
  },
} satisfies ExportedHandler<Env>;
