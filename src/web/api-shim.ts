// AUTOcarl web — browser implementation of the desktop Api (window.api).
//
// The desktop renderer talks to the Electron main process over IPC; on the
// web the SAME renderer talks to this shim instead, which persists state in
// localStorage and calls the Cloudflare Worker backend for everything that
// needs a server (CARL/SSW logins, iCal proxying, booking-detail scrapes,
// GSA rates, logos, friends). Side-effect module: importing it assigns
// window.api and window.__AUTOCARL_WEB__.

import type {
  Api, Booking, BookingContacts, BookingContactsCache, FlightsCache,
  FriendsList, FriendsStatus, RefreshResult, SetupStatus, SswPushResult,
  SswWeek, UserSettings,
} from '../shared/types';
import { FILING_STATUSES, type FilingStatus } from '../shared/taxes';

const API: string =
  ((window as unknown as { __AUTOCARL_API__?: string }).__AUTOCARL_API__)
  || 'https://autocarl-api.somerss.workers.dev';

// ---- localStorage keys ----------------------------------------------------

const K = {
  carlEmail: 'autocarl.web.carlEmail',
  carlPassword: 'autocarl.web.carlPassword',
  sswEmail: 'autocarl.web.sswEmail',
  sswPassword: 'autocarl.web.sswPassword',
  icalUrl: 'autocarl.web.icalUrl',
  settings: 'autocarl.web.settings',
  bookings: 'autocarl.web.bookings',
  contacts: 'autocarl.web.contacts',
  sswWeeks: 'autocarl.web.sswWeeks',
  logos: 'autocarl.web.logos',
  friendsToken: 'autocarl.web.friendsToken',
  friendsName: 'autocarl.web.friendsName',
} as const;

function lsGet(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota/private mode */ }
}
function lsRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// Friends identity follows the CARL login: when the stored email changes,
// drop the previous token so schedules never publish to another person's
// buddy list. Auto sign-on re-enrolls the new email on the next visit.
function dropFriendsIfEmailChanged(newEmail: string): void {
  const prev = lsGet(K.carlEmail);
  if (prev && prev !== newEmail) {
    lsRemove(K.friendsToken);
    lsRemove(K.friendsName);
  }
}
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function writeJson(key: string, value: unknown): void {
  lsSet(key, JSON.stringify(value));
}

// ---- worker calls ---------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- iCal parsing (lifted verbatim from web/app.js / src/main/ical.ts) ----

function parseIcs(text: string): Record<string, string>[] {
  // RFC 5545 line folding: a leading space/tab continues the previous line.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(';')[0];   // drop ;VALUE=DATE etc.
    current[name] = line.slice(colon + 1);
  }
  return events;
}

function icalDateToIso(s: string): string {
  const m = (s || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function addDaysIso(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function eventToBooking(ev: Record<string, string>): Booking | null {
  const parts = (ev.SUMMARY || '').split(' - ');
  if (parts.length < 3) return null;
  const startDate = icalDateToIso(ev.DTSTART);
  const endExclusive = icalDateToIso(ev.DTEND);
  if (!startDate || !endExclusive) return null;
  const desc = (ev.DESCRIPTION || '').replace(/\\n/g, '\n').replace(/\\,/g, ',');
  const fields: Record<string, string> = {};
  for (const line of desc.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep > 0) fields[line.slice(0, sep).trim()] = line.slice(sep + 3).trim();
  }
  const location = ev.LOCATION || '';
  const [cityRaw, stateRaw] = location.split(',').map((s) => s.trim());
  return {
    bookingId: ev.UID || '',
    jobNumber: parts[0].trim(),
    jobName: parts.slice(1, -1).join(' - ').trim(),
    status: parts[parts.length - 1].trim(),
    position: (fields['Position'] || '').replace(/^[A-Za-z0-9]+\s*-\s*/, ''),
    projectManager: fields['Project Manager'] || '',
    laborCoordinator: fields['Labor Coordinator'] || '',
    city: cityRaw || '',
    state: stateRaw || '',
    startDate,
    endDate: addDaysIso(endExclusive, -1),   // collapse iCal's +1 exclusive end
  };
}

// ---- settings -------------------------------------------------------------

// Exactly the UserSettings subset of src/main/store.ts DEFAULT_CONFIG.
const DEFAULT_SETTINGS: UserSettings = {
  defaultStartTime: '8:00 am',
  defaultEndTime: '6:00 pm',
  autofillPerDiem: true,
  defaultDailyRate: 0,
  timesheetEmail: '',
  theme: 'constellation',
  basePayDayRate: 0,
  subtractTaxes: false,
  retirementPct: 0,
  filingStatus: 'single',
  ytdWages: 0,
  ytdAsOf: '',
  expectedAnnualWages: 0,
  spouseAnnualWages: 0,
  stateTaxRatePct: 0,
  gigDayRates: {},
};

function getSettings(): UserSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<UserSettings>>(K.settings, {}) };
}

function nonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Same field-by-field validation as the desktop's settings:update handler.
function applySettingsPatch(patch: Partial<UserSettings>): UserSettings {
  const allowed: Partial<UserSettings> = {};
  if (typeof patch?.defaultStartTime === 'string') allowed.defaultStartTime = patch.defaultStartTime.trim();
  if (typeof patch?.defaultEndTime === 'string') allowed.defaultEndTime = patch.defaultEndTime.trim();
  if (typeof patch?.autofillPerDiem === 'boolean') allowed.autofillPerDiem = patch.autofillPerDiem;
  if (nonNegative(patch?.defaultDailyRate)) allowed.defaultDailyRate = patch.defaultDailyRate;
  if (typeof patch?.timesheetEmail === 'string') {
    const e = patch.timesheetEmail.trim();
    if (!e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) allowed.timesheetEmail = e.slice(0, 120);
  }
  if (typeof patch?.theme === 'string' && patch.theme.trim()) allowed.theme = patch.theme.trim();
  if (nonNegative(patch?.basePayDayRate)) allowed.basePayDayRate = patch.basePayDayRate;
  if (typeof patch?.subtractTaxes === 'boolean') allowed.subtractTaxes = patch.subtractTaxes;
  if (nonNegative(patch?.retirementPct)) allowed.retirementPct = Math.min(patch.retirementPct as number, 100);
  if (nonNegative(patch?.stateTaxRatePct)) allowed.stateTaxRatePct = Math.min(patch.stateTaxRatePct as number, 100);
  if (nonNegative(patch?.ytdWages)) allowed.ytdWages = patch.ytdWages;
  if (typeof patch?.ytdAsOf === 'string' && /^(\d{4}-\d{2}-\d{2})?$/.test(patch.ytdAsOf)) {
    allowed.ytdAsOf = patch.ytdAsOf;
  }
  if (nonNegative(patch?.expectedAnnualWages)) allowed.expectedAnnualWages = patch.expectedAnnualWages;
  if (nonNegative(patch?.spouseAnnualWages)) allowed.spouseAnnualWages = patch.spouseAnnualWages;
  if (FILING_STATUSES.includes(patch?.filingStatus as FilingStatus)) {
    allowed.filingStatus = patch.filingStatus as FilingStatus;
  }
  if (patch?.gigDayRates && typeof patch.gigDayRates === 'object') {
    const clean: Record<string, number> = {};
    for (const [id, rate] of Object.entries(patch.gigDayRates)) {
      if (typeof id === 'string' && id && nonNegative(rate) && rate > 0) {
        clean[id] = Math.min(rate, 1_000_000);
      }
    }
    allowed.gigDayRates = clean;
  }
  const next = { ...getSettings(), ...allowed };
  writeJson(K.settings, next);
  return next;
}

// ---- setup ----------------------------------------------------------------

const ICAL_URL_RE = /^https:\/\/calendar\..*carl\.ctus\.live\//;

function currentStatus(): SetupStatus {
  const url = lsGet(K.icalUrl);
  if (!url || !lsGet(K.carlEmail) || !lsGet(K.carlPassword)) return { stage: 'needs-carl-credentials' };
  if (!lsGet(K.sswEmail) || !lsGet(K.sswPassword)) return { stage: 'needs-ssw-credentials' };
  return { stage: 'ready', icalUrl: url };
}

// ---- bookings: cache + subscribe + refresh --------------------------------

type BookingsCacheShape = { bookings: Booking[]; fetchedAt: string | null };

const bookingsListeners = new Set<(r: RefreshResult) => void>();
function notifyBookings(payload: RefreshResult): void {
  for (const fn of bookingsListeners) { try { fn(payload); } catch { /* listener error */ } }
}

const contactsListeners = new Set<(c: BookingContactsCache) => void>();
function notifyContacts(cache: BookingContactsCache): void {
  for (const fn of contactsListeners) { try { fn(cache); } catch { /* listener error */ } }
}

async function refreshBookings(): Promise<RefreshResult> {
  const url = lsGet(K.icalUrl);
  if (!url) return { ok: false, error: 'No iCal URL configured — complete setup first.' };
  try {
    const res = await fetch(`${API}/v1/ical?u=${encodeURIComponent(url)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`iCal fetch failed: HTTP ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/.test(text)) {
      throw new Error('That link didn’t return a calendar — check it and try again.');
    }
    const bookings = parseIcs(text).map(eventToBooking).filter((b): b is Booking => b !== null);
    const fetchedAt = new Date().toISOString();
    writeJson(K.bookings, { bookings, fetchedAt } satisfies BookingsCacheShape);
    const payload: RefreshResult = { ok: true, bookings, fetchedAt };
    notifyBookings(payload);
    publishScheduleQuietly(bookings);
    void sweepContacts(bookings);
    return payload;
  } catch (e) {
    const payload: RefreshResult = { ok: false, error: errMsg(e) };
    notifyBookings(payload);
    return payload;
  }
}

// Light-weight 5-min background poll once setup is complete — mirrors the
// desktop main process's startBackgroundPoll().
setInterval(() => {
  if (lsGet(K.icalUrl)) void refreshBookings();
}, 5 * 60 * 1000);

// ---- contacts sweep (ported from src/main/flight-fetcher.ts, minus PDFs) --

// Normalize a person name for matching CARL's PM/LC names against the
// booking's iCal-sourced names ("Hilton Brown" vs "Brown, Hilton").
function normalizeName(s: string): string {
  const t = s.toLowerCase().replace(/[.,]/g, '').trim();
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

// What POST /v1/carl/details returns — the worker-side port of
// src/main/carl-api.ts's CarlBookingDetails (flights unused on web v1).
type CarlDetails = {
  flights?: Array<{ pdfUrl: string; vendor?: string; confirmation?: string }>;
  emailsByName?: Record<string, string>;
  perDiem?: number;
  venue?: string;
  venueAddress?: string;
  venueZip?: string;
  laborTravel?: string;
  bookingNotes?: string;
};

type GsaRateLite = { meals?: number; city?: string };

// Per-zip session cache, like the desktop's gsa-perdiem module cache (the
// worker owns the fiscal-year logic).
const gsaCache = new Map<string, GsaRateLite | null>();

async function gsaRateForZip(zip: string): Promise<GsaRateLite | null> {
  const cleaned = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(cleaned)) return null;
  if (gsaCache.has(cleaned)) return gsaCache.get(cleaned) ?? null;
  try {
    const res = await fetch(`${API}/v1/gsa?zip=${encodeURIComponent(cleaned)}`);
    if (!res.ok) { gsaCache.set(cleaned, null); return null; }
    const data: unknown = await res.json();
    const rate = data && typeof data === 'object' ? (data as GsaRateLite) : null;
    gsaCache.set(cleaned, rate);
    return rate;
  } catch {
    gsaCache.set(cleaned, null);
    return null;
  }
}

// Visit each booking's CARL detail data through the worker and merge results
// into the contacts cache exactly as the desktop sweep does — one booking at
// a time, 250 ms apart, notifying subscribers as entries land.
let sweepRunning = false;

async function sweepContacts(bookings: Booking[]): Promise<void> {
  if (sweepRunning) return;
  const email = lsGet(K.carlEmail);
  const password = lsGet(K.carlPassword);
  if (!email || !password || bookings.length === 0) return;
  sweepRunning = true;
  try {
    for (const booking of bookings) {
      try {
        const scraped = await postJson<CarlDetails>('/v1/carl/details', {
          email, password, bookingId: booking.bookingId,
        });
        const emailsByName = scraped.emailsByName || {};
        const pmEmail = matchEmailForRole(emailsByName, booking.projectManager);
        const lcEmail = matchEmailForRole(emailsByName, booking.laborCoordinator);

        let gsaPerDiem: number | undefined;
        let gsaCity: string | undefined;
        if (scraped.venueZip) {
          const gsa = await gsaRateForZip(scraped.venueZip);
          if (gsa && typeof gsa.meals === 'number') {
            gsaPerDiem = gsa.meals;
            gsaCity = gsa.city;
          }
        }

        const contacts = readJson<BookingContactsCache>(K.contacts, {});
        const prevContacts = contacts[booking.bookingId];
        const next: BookingContacts = {
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
          // it across sweeps so a refresh doesn't re-badge a seen note.
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
          writeJson(K.contacts, contacts);
          notifyContacts(contacts);
        }
      } catch {
        // Booking might be archived/gone from CARL — keep sweeping the rest.
      }
      await delay(250);
    }
  } finally {
    sweepRunning = false;
  }
}

// ---- friends (mirrors src/main/friends.ts through the worker) -------------

let lastPublishedHash = '';

async function publishSchedule(bookings?: Booking[]): Promise<void> {
  const token = lsGet(K.friendsToken);
  if (!token) return;
  let source = bookings;
  if (!source) {
    const cache = readJson<BookingsCacheShape>(K.bookings, { bookings: [], fetchedAt: null });
    // A never-populated cache (fresh browser, first refresh still in flight)
    // must not publish: PUT /v1/schedule overwrites wholesale, and an empty
    // publish here would wipe the schedule the desktop app already shared.
    // Once a real fetch lands, publishScheduleQuietly re-publishes anyway.
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
  await postJson('/v1/friends/publish', { token, gigs });
  lastPublishedHash = hash;
}

function publishScheduleQuietly(bookings: Booking[]): void {
  publishSchedule(bookings).catch((e) => {
    console.log('[autocarl] friends publish skipped:', errMsg(e));
  });
}

function friendsToken(): string {
  const token = lsGet(K.friendsToken);
  if (!token) throw new Error('Friends is not turned on.');
  return token;
}

// ---- ssw ------------------------------------------------------------------

function requireSsw(): { email: string; password: string } {
  const email = lsGet(K.sswEmail);
  const password = lsGet(K.sswPassword);
  if (!email || !password) throw new Error('SSW credentials missing — complete setup first.');
  return { email, password };
}

function sswCfg(): { defaultDailyRate: number; timesheetEmail: string } {
  const s = getSettings();
  return { defaultDailyRate: s.defaultDailyRate, timesheetEmail: s.timesheetEmail };
}

function unwrapWeek(r: unknown): SswWeek | null {
  if (r == null) return null;
  if (typeof r === 'object' && 'week' in (r as Record<string, unknown>)) {
    return ((r as { week: SswWeek | null }).week ?? null);
  }
  if (typeof r === 'object' && 'recordId' in (r as Record<string, unknown>)) return r as SswWeek;
  return null;
}

function cacheWeek(week: SswWeek): void {
  const weeks = readJson<Record<string, SswWeek>>(K.sswWeeks, {});
  weeks[week.weekStartDate] = week;
  writeJson(K.sswWeeks, weeks);
}

// ---- the Api --------------------------------------------------------------

const DESKTOP_ONLY_EXPENSES = 'Expense reports are desktop-only for now';

const api: Api = {
  setup: {
    getStatus: async () => currentStatus(),

    saveCarl: async (email, password) => {
      const cleanEmail = (email || '').trim();
      if (!cleanEmail || !password) return { stage: 'error', from: 'carl', message: 'Email and password are required.' };
      try {
        await postJson('/v1/carl/verify', { email: cleanEmail, password });
      } catch (e) {
        return { stage: 'error', from: 'carl', message: errMsg(e) };
      }
      // Creds verified — store them (desktop persists before discovery too),
      // so a discover failure drops the user into the paste-URL fallback
      // without retyping the login.
      dropFriendsIfEmailChanged(cleanEmail);
      lsSet(K.carlEmail, cleanEmail);
      lsSet(K.carlPassword, password);
      try {
        const r = await postJson<{ icalUrl?: string; url?: string }>('/v1/carl/discover', { email: cleanEmail, password });
        const url = ((r && (r.icalUrl || r.url)) || '').trim();
        if (!url) throw new Error('Could not discover your calendar URL — paste it manually below.');
        lsSet(K.icalUrl, url);
        void refreshBookings();   // kick off the first iCal fetch in the background
        return currentStatus();
      } catch (e) {
        return { stage: 'error', from: 'carl', message: errMsg(e) };
      }
    },

    saveCarlWithUrl: async (email, password, icalUrl) => {
      const cleanEmail = (email || '').trim();
      const cleanUrl = (icalUrl || '').trim();
      if (!cleanEmail || !password) return { stage: 'error', from: 'carl', message: 'Email and password are required.' };
      if (!cleanUrl) return { stage: 'error', from: 'carl', message: 'iCal URL is required.' };
      if (!ICAL_URL_RE.test(cleanUrl)) {
        return { stage: 'error', from: 'carl', message: 'That doesn\'t look like a CARL iCal URL. It should start with https://calendar.prod.carl.ctus.live/' };
      }
      try {
        await postJson('/v1/carl/verify', { email: cleanEmail, password });
        dropFriendsIfEmailChanged(cleanEmail);
        lsSet(K.carlEmail, cleanEmail);
        lsSet(K.carlPassword, password);
        lsSet(K.icalUrl, cleanUrl);
        void refreshBookings();
        return currentStatus();
      } catch (e) {
        return { stage: 'error', from: 'carl', message: errMsg(e) };
      }
    },

    saveSsw: async (email, password) => {
      const cleanEmail = (email || '').trim();
      if (!cleanEmail || !password) return { stage: 'error', from: 'ssw', message: 'Email and password are required.' };
      try {
        await postJson('/v1/ssw/verify', { email: cleanEmail, password });
      } catch (e) {
        return { stage: 'error', from: 'ssw', message: errMsg(e) };
      }
      lsSet(K.sswEmail, cleanEmail);
      lsSet(K.sswPassword, password);
      return currentStatus();
    },

    clear: async () => {
      lsRemove(K.carlEmail);
      lsRemove(K.carlPassword);
      lsRemove(K.sswEmail);
      lsRemove(K.sswPassword);
      lsRemove(K.icalUrl);
      // Friends identity follows the CARL login (see desktop setup:clear).
      lsRemove(K.friendsToken);
      lsRemove(K.friendsName);
    },
  },

  bookings: {
    getCached: async () => readJson<BookingsCacheShape>(K.bookings, { bookings: [], fetchedAt: null }),
    refresh: () => refreshBookings(),
    subscribe: (handler) => {
      bookingsListeners.add(handler);
      return () => { bookingsListeners.delete(handler); };
    },
    openInCarl: async (bookingId) => {
      if (typeof bookingId !== 'string' || !/^[A-Za-z0-9]{4,32}$/.test(bookingId)) return;
      window.open(`https://carl.ctus.live/crewcalendar/booking-details-1/${bookingId}`, '_blank', 'noopener');
    },
  },

  flights: {
    getCached: async () => ({} as FlightsCache),
    open: async () => { /* flight PDFs are desktop-only on web v1 */ },
    subscribe: () => () => { /* never fires on web */ },
  },

  contacts: {
    getCached: async () => readJson<BookingContactsCache>(K.contacts, {}),
    subscribe: (handler) => {
      contactsListeners.add(handler);
      return () => { contactsListeners.delete(handler); };
    },
    markNotesSeen: async (bookingId) => {
      if (typeof bookingId !== 'string' || !bookingId) return;
      const cache = readJson<BookingContactsCache>(K.contacts, {});
      const entry = cache[bookingId];
      if (!entry || (entry.notesSeen ?? '') === (entry.bookingNotes ?? '')) return;
      entry.notesSeen = entry.bookingNotes ?? '';
      writeJson(K.contacts, cache);
      notifyContacts(cache);
    },
  },

  ssw: {
    getCached: async (weekStartDate) =>
      readJson<Record<string, SswWeek>>(K.sswWeeks, {})[weekStartDate] || null,
    getCachedWeeks: async () => readJson<Record<string, SswWeek>>(K.sswWeeks, {}),
    fetchWeek: async (weekStartDate) => {
      const { email, password } = requireSsw();
      const r = await postJson<unknown>('/v1/ssw/week', { email, password, weekMonday: weekStartDate });
      const week = unwrapWeek(r);
      if (week) cacheWeek(week);
      return week;
    },
    createWeek: async (weekStartDate) => {
      const { email, password } = requireSsw();
      const r = await postJson<unknown>('/v1/ssw/create', {
        email, password, weekMonday: weekStartDate, cfg: sswCfg(),
      });
      const week = unwrapWeek(r);
      if (week) cacheWeek(week);
      return week;
    },
    pushWeek: async (week) => {
      try {
        const { email, password } = requireSsw();
        const r = await postJson<SswPushResult>('/v1/ssw/save', { email, password, week, cfg: sswCfg() });
        if (r && r.ok) cacheWeek(week);
        return r;
      } catch (e) {
        // Desktop pushWeek resolves with the error union rather than throwing.
        return { ok: false, error: errMsg(e) };
      }
    },
  },

  logo: {
    forJob: async (jobName) => {
      if (!jobName) return null;
      const cache = readJson<Record<string, string | null>>(K.logos, {});
      if (jobName in cache) return cache[jobName];
      try {
        const r = await postJson<{ logo?: string | null; dataUri?: string | null } | null>('/v1/logo', { jobName });
        const logo = r && typeof r === 'object' ? (r.logo ?? r.dataUri ?? null) : null;
        // Null results are cached too — "no logo found" is an answer. Thrown
        // network errors are NOT cached so a transient failure can retry.
        cache[jobName] = logo;
        writeJson(K.logos, cache);
        return logo;
      } catch {
        return null;
      }
    },
  },

  app: {
    getVersion: async () => 'web',
  },

  friends: {
    // Status is derived locally, exactly like the desktop's friendsStatus().
    status: async (): Promise<FriendsStatus> => ({
      enrolled: !!lsGet(K.friendsToken),
      email: lsGet(K.carlEmail),
      name: lsGet(K.friendsName),
    }),
    enroll: async (name): Promise<FriendsStatus> => {
      const carlEmail = lsGet(K.carlEmail);
      if (!carlEmail || !lsGet(K.carlPassword)) {
        throw new Error('Complete C.A.R.L. setup first — your email identifies you to friends.');
      }
      const clean = String(name ?? '').trim();
      if (!clean) throw new Error('Enter the name your coworkers know you by.');
      // The worker verifies the CARL login, then registers — or, when this
      // email already has a friends account (enrolled on the desktop, say),
      // issues an extra token for this browser. Same person, same buddy
      // list, and the account keeps its original display name.
      const r = await postJson<{
        token: string; name?: string;
        linked?: boolean; accountCreatedAt?: string | null; firstVerified?: boolean;
      }>('/v1/friends/enroll', {
        email: carlEmail, password: lsGet(K.carlPassword), name: clean,
      });
      const finalName = r.name || clean;
      lsSet(K.friendsToken, r.token);
      lsSet(K.friendsName, finalName);
      // Share the current schedule immediately — but enrollment has already
      // succeeded, so a publish hiccup must not fail it (the refresh path
      // republishes anyway; a retry would false-alarm the "existing
      // account" notice).
      await publishSchedule().catch((e) => {
        console.log('[autocarl] post-enroll publish skipped:', errMsg(e));
      });
      return {
        enrolled: true, email: carlEmail, name: finalName,
        ...(r.linked ? {
          linkedExisting: {
            accountCreatedAt: r.accountCreatedAt ?? null,
            firstVerified: r.firstVerified === true,
          },
        } : {}),
      };
    },
    list: async () => postJson<FriendsList>('/v1/friends/list', { token: friendsToken() }),
    request: async (email) => { await postJson('/v1/friends/request', { token: friendsToken(), email }); },
    respond: async (email, accept) => {
      await postJson('/v1/friends/respond', { token: friendsToken(), email, accept: accept === true });
    },
    remove: async (email) => { await postJson('/v1/friends/remove', { token: friendsToken(), email }); },
  },

  expenses: {
    getCached: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    addFiles: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    pickFiles: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    updateReceipt: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    removeReceipt: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    openReceipt: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    buildDraft: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    saveReport: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    removeReport: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    resetGig: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    exportReport: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    mailReport: async () => { throw new Error(DESKTOP_ONLY_EXPENSES); },
    pathForFile: () => '',
  },

  updater: {
    onProgress: () => () => { /* no auto-updates on web */ },
  },

  settings: {
    get: async () => getSettings(),
    update: async (patch) => applySettingsPatch(patch ?? {}),
    getCredentials: async () => ({ carlEmail: lsGet(K.carlEmail), sswEmail: lsGet(K.sswEmail) }),
    updateCarlCredentials: async (email, password) => {
      const cleanEmail = (email || '').trim();
      if (!cleanEmail || !password) return { ok: false as const, error: 'Email and password are required.' };
      try {
        await postJson('/v1/carl/verify', { email: cleanEmail, password });
        dropFriendsIfEmailChanged(cleanEmail);
        lsSet(K.carlEmail, cleanEmail);
        lsSet(K.carlPassword, password);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
    updateSswCredentials: async (email, password) => {
      const cleanEmail = (email || '').trim();
      if (!cleanEmail || !password) return { ok: false as const, error: 'Email and password are required.' };
      try {
        await postJson('/v1/ssw/verify', { email: cleanEmail, password });
        lsSet(K.sswEmail, cleanEmail);
        lsSet(K.sswPassword, password);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  },
};

(window as unknown as { api: Api }).api = api;
(window as unknown as { __AUTOCARL_WEB__: boolean }).__AUTOCARL_WEB__ = true;

export {};
