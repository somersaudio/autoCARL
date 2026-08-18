// Client for the AUTOcarl friends service (friends-worker/, deployed on
// Cloudflare). Mutual-consent gig sharing: we publish a COARSE schedule —
// job number/name, city/state, date range — and can read the same for
// friends who accepted us. The bearer token lives in config.json and never
// reaches the renderer; everything goes through the IPC handlers.

import { readCachedBookings, readConfig, updateConfig } from './store';
import { getCarlPassword } from './credentials';
import type { Booking } from '../shared/types';

const FRIENDS_URL = process.env.FRIENDS_URL || 'https://autocarl-friends.somerss.workers.dev';
// Enrollment goes through the API worker instead: it verifies the CARL login
// and, when this email already has a friends account (another device, a
// reinstall), issues an ADDITIONAL token instead of failing with a 409.
const API_URL = process.env.AUTOCARL_API_URL || 'https://autocarl-api.somerss.workers.dev';

export type FriendGig = {
  jobNumber: string; jobName: string; city: string; state: string;
  start: string; end: string;
};
export type FriendEntry = { email: string; name: string; gigs: FriendGig[]; updatedAt: string | null };
export type FriendsList = {
  accepted: FriendEntry[];
  incoming: Array<{ email: string; name: string }>;
  outgoing: Array<{ email: string; name: string }>;
};
export type FriendsStatus = {
  enrolled: boolean; email: string; name: string;
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
  return { enrolled: !!cfg.friendsToken, email: cfg.carlEmail, name: cfg.friendsName };
}

export async function friendsEnroll(name: string): Promise<FriendsStatus> {
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
  await updateConfig({ friendsToken: r.token, friendsName: finalName });
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

export async function friendsList(): Promise<FriendsList> {
  return call<FriendsList>('/v1/friends', {}, await authed());
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
