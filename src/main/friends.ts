// Client for the AUTOcarl friends service (friends-worker/, deployed on
// Cloudflare). Mutual-consent gig sharing: we publish a COARSE schedule —
// job number/name, city/state, date range — and can read the same for
// friends who accepted us. The bearer token lives in config.json and never
// reaches the renderer; everything goes through the IPC handlers.

import { readCachedBookings, readConfig, updateConfig } from './store';
import type { Booking } from '../shared/types';

const FRIENDS_URL = process.env.FRIENDS_URL || 'https://autocarl-friends.somerss.workers.dev';

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
export type FriendsStatus = { enrolled: boolean; email: string; name: string };

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
  const r = await call<{ token: string }>('/v1/register', {
    method: 'POST',
    body: { email: cfg.carlEmail, name: clean },
  });
  await updateConfig({ friendsToken: r.token, friendsName: clean });
  await publishSchedule();   // share the current schedule immediately
  return { enrolled: true, email: cfg.carlEmail, name: clean };
}

// Publish the coarse upcoming schedule. Fire-and-forget safe: throws only to
// direct callers; the refresh hook wraps it. A content hash keeps the 5-min
// booking poll from re-uploading an unchanged schedule.
let lastPublishedHash = '';
export async function publishSchedule(bookings?: Booking[]): Promise<void> {
  const cfg = await readConfig();
  if (!cfg.friendsToken) return;
  const source = bookings ?? (await readCachedBookings()).bookings;
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
