// Client for the AUTOcarl friends service (friends-worker/, deployed on
// Cloudflare). Mutual-consent gig sharing: we publish a COARSE schedule —
// job number/name, city/state, date range — and can read the same for
// friends who accepted us. The bearer token lives in config.json and never
// reaches the renderer; everything goes through the IPC handlers.

import { bumpCarlEpoch, carlEpochNow, readCachedBookings, readConfig, updateConfig } from './store';
import type { Config } from './store';
import { getCarlPassword } from './credentials';
import type { Booking } from '../shared/types';

const FRIENDS_URL = process.env.FRIENDS_URL || 'https://autocarl-friends.somerss.workers.dev';
// Enrollment goes through the API worker instead: it verifies the CARL login
// and, when this email already has a friends account (another device, a
// reinstall), issues an ADDITIONAL token instead of failing with a 409.
const API_URL = process.env.AUTOCARL_API_URL || 'https://autocarl-api.somerss.workers.dev';

// A request that went out under the C.A.R.L. login before this one writes
// nothing when it lands: enrolling goes through a full C.A.R.L. login on the
// worker, which takes seconds, and the token, name and icon coming back are the
// previous person's. Stored, they would sign the next person on as them — their
// buddy list on screen, and this person's shows published to it. Which login
// the app is working as is kept in store.ts, where the cached shows and
// itineraries answer to the same turn of the number.
const ACCOUNT_CHANGED = 'The C.A.R.L. login changed while this was in progress.';

export function carlAccountChanged(): void {
  bumpCarlEpoch();
  listCache = null;        // the buddies it holds are the last person's
  lastPublishedHash = '';  // the next account publishes even if its shows match
}

// The account a request went out under, asked about again when it lands. With a
// token, that token must still be the stored one too: signing out and back on
// leaves the C.A.R.L. login alone but mints a new one.
function accountGuard(epoch: number, token?: string): (cfg: Config) => boolean {
  return (cfg) => carlEpochNow() === epoch && (token === undefined || cfg.friendsToken === token);
}

// Store this, but only while it still belongs to the login that asked for it.
// updateConfig asks at the moment of writing, so nothing can land in between.
// Whether it said yes is remembered from that one question rather than asked
// again of what came back: signing out clears the very token being checked, so
// asking again afterwards would call every sign-out a changed login.
async function writeForAccount(patch: Partial<Config>, guard: (cfg: Config) => boolean): Promise<void> {
  let wrote = false;
  await updateConfig(patch, (cfg) => {
    wrote = guard(cfg);
    return wrote;
  });
  if (!wrote) throw new Error(ACCOUNT_CHANGED);
}

async function requireSameAccount(guard: (cfg: Config) => boolean): Promise<void> {
  if (!guard(await readConfig())) throw new Error(ACCOUNT_CHANGED);
}

export type FriendGig = {
  jobNumber: string; jobName: string; city: string; state: string;
  start: string; end: string;
};
export type FriendEntry = {
  email: string; name: string; gigs: FriendGig[]; updatedAt: string | null;
  avatar?: string | null;
};
export type FriendsList = {
  accepted: FriendEntry[];
  incoming: Array<{ email: string; name: string }>;
  outgoing: Array<{ email: string; name: string }>;
  // Your own screen name as the friends service has it (the authority).
  me?: { name: string };
};
export type FriendsStatus = {
  enrolled: boolean; email: string; name: string;
  avatar?: string;
  signedOut?: boolean;
  // Set when enrollment attached to an EXISTING account for this email
  // (second device / reinstall). Surfaced by the renderer — it's also the
  // tripwire if someone else enrolled this email first.
  linkedExisting?: { accountCreatedAt: string | null; firstVerified: boolean };
};

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${FRIENDS_URL}${path}`, {
    method: init.method || 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `Friends service HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

export async function friendsStatus(): Promise<FriendsStatus> {
  const cfg = await readConfig();
  return {
    enrolled: !!cfg.friendsToken,
    email: cfg.carlEmail,
    name: cfg.friendsName,
    avatar: cfg.friendsAvatar || undefined,
    signedOut: !!cfg.friendsSignedOut,
  };
}

// Buddy icon: push to the friends service, keep a local copy for preview.
export async function friendsSetAvatar(avatar: string): Promise<void> {
  const epoch = carlEpochNow();
  const token = await authed();
  await call('/v1/avatar', { method: 'PUT', body: { avatar } }, token);
  await writeForAccount({ friendsAvatar: avatar }, accountGuard(epoch, token));
}

// Screen name: what buddies see beside your icon. The service normalises it
// and refuses an email; its answer becomes the local copy.
export async function friendsSetName(name: string): Promise<string> {
  const epoch = carlEpochNow();
  const token = await authed();
  const r = await call<{ name: string }>('/v1/name', { method: 'PUT', body: { name } }, token);
  await writeForAccount({ friendsName: r.name }, accountGuard(epoch, token));
  return r.name;
}

// Sign out = leave: take the schedule down so friends stop seeing your
// shows, drop the token, and remember it was deliberate so auto sign-on
// stays off. The server account survives — signing back in with the same
// C.A.R.L. login restores the buddy list.
export async function friendsSignOut(): Promise<void> {
  const epoch = carlEpochNow();
  const cfg = await readConfig();
  if (cfg.friendsToken) {
    await call('/v1/schedule', { method: 'PUT', body: { gigs: [] } }, cfg.friendsToken).catch(() => {});
  }
  // Landing after a Log out, this would leave "signed out on purpose" set for
  // whoever logs in next, and hold them on the Sign On screen over a decision
  // the person before them made.
  await writeForAccount(
    { friendsToken: '', friendsName: '', friendsSignedOut: true },
    accountGuard(epoch, cfg.friendsToken),
  );
  // Signing out took the schedule down, so signing back on has to put it up
  // again. Without this, an unchanged set of shows counts as already published
  // and friends go on seeing nothing until a booking changes.
  lastPublishedHash = '';
}

export async function friendsEnroll(name: string): Promise<FriendsStatus> {
  const epoch = carlEpochNow();
  const cfg = await readConfig();
  if (!cfg.carlEmail) throw new Error('Complete C.A.R.L. setup first — your email identifies you to friends.');
  const clean = name.trim();
  if (!clean) throw new Error('Enter the name your coworkers know you by.');
  const password = await getCarlPassword(cfg.carlEmail);
  if (!password) throw new Error('C.A.R.L. password not found — sign in to C.A.R.L. again first.');
  const res = await fetch(`${API_URL}/v1/friends/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: cfg.carlEmail, password, name: clean }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `Friends service HTTP ${res.status}`;
    throw new Error(msg);
  }
  const r = parsed as {
    token: string; name?: string;
    linked?: boolean; accountCreatedAt?: string | null; firstVerified?: boolean;
  };
  const finalName = r.name || clean;
  // The worker signs in to C.A.R.L. before it answers, so this was on the wire
  // for seconds. If the login changed in that time, this token is the last
  // person's: it is dropped rather than stored, and the publish below never
  // runs. Auto sign-on enrolls the login that is stored now instead.
  await writeForAccount(
    { friendsToken: r.token, friendsName: finalName, friendsSignedOut: false },
    accountGuard(epoch),
  );
  // Share the current schedule immediately — but enrollment has already
  // succeeded, so a publish hiccup must not fail it (the refresh hook
  // republishes on the next sweep anyway). Failing here would leave the
  // renderer on the Sign On screen with a token already saved, and a retry
  // would false-alarm the "existing account" notice.
  await publishSchedule().catch((e) => {
    console.log('[autocarl] post-enroll publish skipped:', e instanceof Error ? e.message : e);
  });
  return {
    enrolled: true, email: cfg.carlEmail, name: finalName,
    ...(r.linked ? {
      linkedExisting: {
        accountCreatedAt: r.accountCreatedAt ?? null,
        firstVerified: r.firstVerified === true,
      },
    } : {}),
  };
}

// Publish the coarse upcoming schedule. Fire-and-forget safe: throws only to
// direct callers; the refresh hook wraps it. A content hash keeps the 5-min
// booking poll from re-uploading an unchanged schedule.
let lastPublishedHash = '';
export async function publishSchedule(bookings?: Booking[]): Promise<void> {
  const epoch = carlEpochNow();
  const cfg = await readConfig();
  if (!cfg.friendsToken) return;
  let source = bookings;
  if (!source) {
    const cache = await readCachedBookings();
    // A never-populated cache (fresh install, first sweep still running)
    // must not publish: PUT /v1/schedule overwrites wholesale, and an empty
    // publish would wipe a schedule another device already shared. The
    // refresh hook re-publishes as soon as a real sweep lands.
    if (!cache.fetchedAt) return;
    source = cache.bookings;
  }
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const gigs = source
    .filter((b) => b.endDate >= todayIso)
    .slice(0, 50)
    .map((b) => ({
      jobNumber: b.jobNumber, jobName: b.jobName,
      city: b.city, state: b.state,
      start: b.startDate, end: b.endDate,
    }));
  const hash = JSON.stringify(gigs);
  if (hash === lastPublishedHash) return;
  // The shows were gathered across an await, and the login may have changed
  // while that ran: publishing now would put this person's shows on the last
  // person's buddy list. The next refresh publishes under the new account.
  if (!accountGuard(epoch, cfg.friendsToken)(await readConfig())) return;
  await call('/v1/schedule', { method: 'PUT', body: { gigs } }, cfg.friendsToken);
  lastPublishedHash = hash;
}

// Called from the bookings refresh path — never throws, never blocks it.
export function publishScheduleQuietly(bookings: Booking[]): void {
  publishSchedule(bookings).catch((e) => {
    console.log('[autocarl] friends publish skipped:', e instanceof Error ? e.message : e);
  });
}

async function authed(): Promise<string> {
  const cfg = await readConfig();
  if (!cfg.friendsToken) throw new Error('Friends is not turned on.');
  return cfg.friendsToken;
}

// The list this app last received and the tag the service gave it. The
// Friends tab polls while it's open; an If-None-Match hit is a bodyless 304
// and this copy is what the tab gets. Keyed by token so a sign-out/sign-in
// never serves another account's list.
let listCache: { token: string; etag: string; list: FriendsList } | null = null;

export async function friendsList(): Promise<FriendsList> {
  const epoch = carlEpochNow();
  const token = await authed();
  const cached = listCache && listCache.token === token ? listCache : null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (cached) headers['if-none-match'] = cached.etag;
  const res = await fetch(`${FRIENDS_URL}/v1/friends`, { headers });
  // These are the buddies of the account this went out under. If that account
  // has gone since — Log out, another C.A.R.L. email, a sign-out — they are the
  // last person's: not kept, not shown, and nobody renamed by them. Asked
  // before the nothing-changed reply is answered as well: the copy held here
  // from earlier would otherwise go back to a tab that is someone else's now.
  const guard = accountGuard(epoch, token);
  await requireSameAccount(guard);
  if (res.status === 304 && cached) return cached.list;
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `Friends service HTTP ${res.status}`;
    throw new Error(msg);
  }
  const list = parsed as FriendsList;
  // Asked again: reading the reply is another wait, and the login can change
  // inside it.
  await requireSameAccount(guard);
  // The edge may weaken the tag (W/"…") when it compresses the body; the
  // service compares weakly, but store the canonical form regardless.
  const etag = (res.headers.get('etag') || '').replace(/^W\//, '');
  listCache = etag ? { token, etag, list } : null;
  // The service's copy of your screen name is the authority (a rename on
  // another device, a fix made on the server). Keep the local copy in step
  // so the Buddy List opens with the right name next time.
  if (list.me?.name) {
    const cfg = await readConfig();
    if (cfg.friendsName !== list.me.name) await writeForAccount({ friendsName: list.me.name }, guard);
  }
  return list;
}

export async function friendsRequest(email: string): Promise<void> {
  await call('/v1/friends/request', { method: 'POST', body: { email } }, await authed());
}

export async function friendsRespond(email: string, accept: boolean): Promise<void> {
  await call('/v1/friends/respond', { method: 'POST', body: { email, accept } }, await authed());
}

export async function friendsRemove(email: string): Promise<void> {
  await call(`/v1/friends/${encodeURIComponent(email)}`, { method: 'DELETE' }, await authed());
}
