// AUTOcarl web — browser implementation of the desktop Api (window.api).
//
// The desktop renderer talks to the Electron main process over IPC; on the
// web the SAME renderer talks to this shim instead, which persists state in
// localStorage and calls the Cloudflare Worker backend for everything that
// needs a server (CARL/SSW logins, iCal proxying, booking-detail scrapes,
// GSA rates, logos, friends). Side-effect module: importing it assigns
// window.api and window.__AUTOCARL_WEB__.

import type {
  Api, Booking, BookingContacts, BookingContactsCache, ExpenseReceipt,
  ExpenseReport, ExpensesCache, FlightsCache, FriendsList, FriendsStatus,
  IngestOutcome, RefreshResult, SetupStatus, SswPushResult,
  SswWeek, UserSettings,
} from '../shared/types';
import { FILING_STATUSES, type FilingStatus } from '../shared/taxes';
import { parseReceiptText } from '../shared/receipt-parse';
import {
  BAD_FORMAT_SKIP_REASON, MAX_RECEIPT_PDF_PAGES, applyReceiptPatch,
  assembleDraftReport, formFileName, imageBytesToPdf, matchBooking,
  multiPageSkipReason, orderedReceipts, receiptFileName, sanitizeReport,
} from '../shared/expense-logic';
import { extractLayoutFromPdfDoc } from '../shared/pdf-text';
import expenseTemplateUrl from '../../resources/expense-template.pdf?url';

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
  expenses: 'autocarl.web.expenses',
  identity: 'autocarl.web.identity',
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

// ---- self-update ----------------------------------------------------------
//
// The home-screen (standalone) app resumes its old session and never
// re-navigates, so a deploy would otherwise sit unseen until iOS happens to
// evict it. On launch, on every return to the foreground, and every 30
// minutes, compare the running bundle's hash against the server's
// index.html and reload when a new build is live. Guards: never reload
// while the user is mid-typing, verify the new bundle actually exists (a
// half-finished deploy must not strand us on a broken page), and remember
// attempted targets so a stale CDN copy can't cause a reload loop.

let updateCheckBusy = false;
async function checkForNewBuild(): Promise<void> {
  if (updateCheckBusy) return;
  updateCheckBusy = true;
  try {
    const current = document.querySelector<HTMLScriptElement>('script[src*="assets/index-"]')?.getAttribute('src') || '';
    const currentHash = current.match(/index-[A-Za-z0-9_-]+\.js/)?.[0];
    if (!currentHash) return;
    const res = await fetch(new URL('index.html', document.baseURI).toString(), { cache: 'no-store' });
    if (!res.ok) return;
    const liveHash = (await res.text()).match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
    if (!liveHash || liveHash === currentHash) return;
    // Don't chase the same target twice in one session (reload-loop guard).
    if (sessionStorage.getItem('autocarl.web.updateTried') === liveHash) return;
    // Mid-deploy safety: the new bundle must really be there.
    const probe = await fetch(new URL(`assets/${liveHash}`, document.baseURI).toString(), { method: 'HEAD', cache: 'no-store' });
    if (!probe.ok) return;
    // Don't yank the page out from under active typing; the next resume or
    // interval tick will catch it.
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    sessionStorage.setItem('autocarl.web.updateTried', liveHash);
    location.reload();
  } catch { /* offline or transient — try again next resume */ } finally {
    updateCheckBusy = false;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void checkForNewBuild();
});
window.setInterval(() => void checkForNewBuild(), 30 * 60 * 1000);
window.setTimeout(() => void checkForNewBuild(), 5_000);   // shortly after launch

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

// ---- expenses (browser implementation) ------------------------------------
//
// Mirrors src/main/expenses.ts with browser storage: receipt bytes live in
// IndexedDB (photos are megabytes — localStorage can't hold them), metadata
// and reports in localStorage under K.expenses. All the behavior-defining
// logic (parsing, assignment, sanitizing, draft assembly, PDF filling,
// bundle naming) is imported from shared modules, so both surfaces stay
// byte-identical where it matters. OCR is the one swap: the desktop runs
// Apple Vision locally; the browser posts the (downscaled) photo to the
// worker's /v1/receipt-ocr, which transcribes it with a vision model — the
// SAME parsing heuristics run on either transcript.

class SkipFile extends Error {}

const IDB_NAME = 'autocarl-expenses';
let idbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
      req.onsuccess = () => {
        // iOS Safari force-closes IndexedDB connections of backgrounded
        // tabs; dropping the memo means the next call reopens cleanly
        // instead of failing on a dead connection until a hard reload.
        req.result.onclose = () => { idbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => {
        idbPromise = null;   // transient open failures must not stick
        reject(req.error ?? new Error('IndexedDB unavailable'));
      };
    });
  }
  return idbPromise;
}
async function idbPut(id: string, blob: Blob): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted — storage may be full'));
  });
}
async function idbGet(id: string): Promise<Blob | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('files', 'readonly').objectStore('files').get(id);
    req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
  });
}
async function idbDelete(id: string): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();   // best-effort, like fs.rm({force:true})
    tx.onabort = () => resolve();
  });
}
const receiptKey = (r: ExpenseReceipt): string => (r.file.startsWith('idb:') ? r.file.slice(4) : r.id);

function readExpensesLS(): ExpensesCache {
  const parsed = readJson<Partial<ExpensesCache>>(K.expenses, {});
  return { receipts: parsed.receipts || [], reports: parsed.reports || [] };
}
function writeExpensesLS(cache: ExpensesCache): void {
  // NOT lsSet: that swallows quota errors, fine for re-fetchable caches but
  // not for receipts the user may have thrown the paper away for. Desktop's
  // fs.writeFile surfaces failures the same way.
  try {
    localStorage.setItem(K.expenses, JSON.stringify(cache));
  } catch {
    throw new Error("This browser's storage is full — the change couldn't be saved. Share or export the current report, then remove old receipts.");
  }
}
// One report PER GIG: saving upserts by bookingId (and by id) — the same
// rule as the desktop store.
function saveReportLS(clean: ExpenseReport): ExpensesCache {
  const cache = readExpensesLS();
  cache.reports = [
    ...cache.reports.filter((r) => r.id !== clean.id && !(clean.bookingId && r.bookingId === clean.bookingId)),
    clean,
  ];
  writeExpensesLS(cache);
  return cache;
}

// Decode + downscale a photo to a JPEG the OCR model and IndexedDB both
// like: phone camera output runs 3-8MB; 2000px @ 0.85 keeps every glyph
// legible at a fraction of the bytes.
async function normalizeImage(f: File): Promise<Blob> {
  let width = 0;
  let height = 0;
  let source: CanvasImageSource | null = await createImageBitmap(f).then(
    (bmp) => { width = bmp.width; height = bmp.height; return bmp; },
    () => null,
  );
  if (!source) {
    source = await new Promise<HTMLImageElement | null>((resolve) => {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => { width = img.naturalWidth; height = img.naturalHeight; URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  if (!source || !width || !height) throw new SkipFile(BAD_FORMAT_SKIP_REASON);
  const MAX = 2000;
  const scale = Math.min(1, MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new SkipFile(BAD_FORMAT_SKIP_REASON);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new SkipFile(BAD_FORMAT_SKIP_REASON);
  return blob;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

async function ocrImageBlob(blob: Blob): Promise<string> {
  try {
    const r = await postJson<{ text?: string }>('/v1/receipt-ocr', {
      image: await blobToBase64(blob),
      mime: 'image/jpeg',
    });
    return r.text || '';
  } catch (e) {
    console.warn('[autocarl] OCR failed:', errMsg(e));
    return '';   // OCR failure degrades to an empty-text parse, like desktop
  }
}

async function pdfTextFromBytes(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  // pdfjs transfers the buffer to its worker (detaching it) — hand it a copy.
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;
  try {
    return await extractLayoutFromPdfDoc(doc);
  } finally {
    void doc.destroy().catch(() => {});
  }
}

const RECEIPT_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff', '.bmp'];

async function ingestOneWeb(f: File, bookings: Booking[], assignTo?: string): Promise<ExpenseReceipt> {
  const name = f.name || 'receipt';
  const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
  const isPdf = ext === '.pdf' || f.type === 'application/pdf';
  const isImage = !isPdf && (f.type.startsWith('image/') || RECEIPT_IMAGE_EXTS.includes(ext));
  const id = crypto.randomUUID();

  let kind: 'image' | 'pdf';
  let stored: Blob;
  let text: string;
  if (isPdf) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let pages = 1;
    try {
      const { PDFDocument } = await import('@cantoo/pdf-lib');
      pages = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
    } catch { /* unreadable structure — let text extraction have a try */ }
    if (pages > MAX_RECEIPT_PDF_PAGES) throw new SkipFile(multiPageSkipReason(pages));
    kind = 'pdf';
    stored = new Blob([bytes], { type: 'application/pdf' });
    text = await pdfTextFromBytes(bytes).catch(() => '');
  } else if (isImage) {
    kind = 'image';
    try {
      stored = await normalizeImage(f);
    } catch (e) {
      // iPhones hand Safari a JPEG, but Chrome/Android can receive a raw
      // HEIC it cannot decode — tell the truth instead of claiming HEIC
      // works and then refusing it.
      if (e instanceof SkipFile && (ext === '.heic' || ext === '.heif')) {
        throw new SkipFile("is a HEIC photo this browser can't read — set your camera to Most Compatible, or add it as a JPG, PNG, or PDF.");
      }
      throw e;
    }
    text = await ocrImageBlob(stored);
  } else {
    throw new SkipFile(BAD_FORMAT_SKIP_REASON);
  }
  await idbPut(id, stored);

  const parsed = parseReceiptText(text, name);
  // The gig the user has selected in the UI wins outright — dropping a
  // receipt while a gig is chosen IS the assignment.
  const pinned = assignTo && bookings.some((b) => b.bookingId === assignTo) ? assignTo : '';
  return {
    id,
    addedAt: new Date().toISOString(),
    file: `idb:${id}`,
    originalName: name,
    kind,
    merchant: parsed.merchant,
    date: parsed.date,
    amount: parsed.amount,
    description: '',
    category: parsed.category,
    bookingId: pinned || matchBooking(parsed.date, bookings),
    // Parsing already used the full text; store a bounded copy so receipts
    // can't balloon the metadata key past the browser's storage quota.
    ocrText: text.slice(0, 8000),
  };
}

// Who the user is, for the expense form: cached permanently after the first
// answer. Sources in order: the identity cache, any cached timesheet week,
// then SSW's own record grid via the worker (works however long ago the
// user last worked — the newest record EVER carries the name and CT id).
async function getIdentity(): Promise<{ name: string; userId: string } | null> {
  const cached = readJson<{ name?: string; userId?: string } | null>(K.identity, null);
  if (cached && (cached.name || cached.userId)) {
    return { name: cached.name || '', userId: cached.userId || '' };
  }
  const week = Object.values(readJson<Record<string, SswWeek>>(K.sswWeeks, {}))
    .sort((a, b) => b.weekStartDate.localeCompare(a.weekStartDate))
    .find((w) => w.name || w.userId);
  if (week) {
    writeJson(K.identity, { name: week.name, userId: week.userId });
    return { name: week.name, userId: week.userId };
  }
  try {
    const { email, password } = requireSsw();
    const ident = await postJson<{ name?: string; userId?: string } | null>('/v1/ssw/identity', { email, password });
    if (ident && (ident.name || ident.userId)) {
      writeJson(K.identity, { name: ident.name || '', userId: ident.userId || '' });
      return { name: ident.name || '', userId: ident.userId || '' };
    }
  } catch (e) {
    console.warn('[autocarl] identity lookup failed:', errMsg(e));
  }
  return null;
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The export bundle as File objects: the filled form first, then each
// receipt as its own PDF, named and ordered exactly like the desktop's
// folder export.
async function buildBundleFiles(clean: ExpenseReport): Promise<File[]> {
  const cache = readExpensesLS();
  const { fillExpensePdf } = await import('../shared/expense-pdf');
  const template = new Uint8Array(await (await fetch(expenseTemplateUrl)).arrayBuffer());
  const formBytes = await fillExpensePdf(template, clean);
  const files: File[] = [new File([formBytes as BlobPart], formFileName(clean), { type: 'application/pdf' })];
  let n = 0;
  for (const r of orderedReceipts(clean, cache.receipts)) {
    n += 1;
    try {
      const blob = await idbGet(receiptKey(r));
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const pdfBytes = r.kind === 'pdf' ? bytes : await imageBytesToPdf(bytes, blob.type.includes('png'));
      files.push(new File([pdfBytes as BlobPart], receiptFileName(n, r), { type: 'application/pdf' }));
    } catch (e) {
      // A missing stored copy shouldn't sink the export — the form and the
      // other receipts still land.
      console.warn('[autocarl] receipt export failed:', errMsg(e));
    }
  }
  return files;
}

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
      // Creds verified — store them so a transient discover failure can be
      // retried without retyping the login.
      dropFriendsIfEmailChanged(cleanEmail);
      lsSet(K.carlEmail, cleanEmail);
      lsSet(K.carlPassword, password);
      try {
        const r = await postJson<{ icalUrl?: string; url?: string }>('/v1/carl/discover', { email: cleanEmail, password });
        const url = ((r && (r.icalUrl || r.url)) || '').trim();
        if (!url) throw new Error('Signed in, but your calendar couldn\u2019t be found — try Continue again in a minute.');
        lsSet(K.icalUrl, url);
        void refreshBookings();   // kick off the first iCal fetch in the background
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
    identity: getIdentity,
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
    getCached: async () => readExpensesLS(),

    // Path-based intake can't exist in a browser — the renderer feeds File
    // objects to ingestFiles instead (file input / drag-drop).
    addFiles: async () => { throw new Error('Use the Add receipts button to pick photos or files.'); },
    pickFiles: async () => null,

    ingestFiles: async (files, assignTo): Promise<IngestOutcome> => {
      // Receipts are the only copy once the paper's gone — ask the browser
      // not to evict our storage. Best-effort; browsers may silently deny.
      try { void navigator.storage?.persist?.(); } catch { /* older engines */ }
      const { bookings } = readJson<BookingsCacheShape>(K.bookings, { bookings: [], fetchedAt: null });
      const cache = readExpensesLS();
      const skipped: Array<{ name: string; reason: string }> = [];
      const newIds: string[] = [];
      for (const f of files) {
        try {
          const r = await ingestOneWeb(f, bookings, assignTo);
          cache.receipts.push(r);
          newIds.push(r.id);
        } catch (e) {
          skipped.push({
            name: f.name || 'file',
            reason: e instanceof SkipFile ? e.message : `couldn't be read (${errMsg(e)}).`,
          });
        }
      }
      try {
        writeExpensesLS(cache);
      } catch (e) {
        // Metadata didn't persist — don't leave orphaned image blobs behind.
        for (const id of newIds) await idbDelete(id).catch(() => {});
        throw e;
      }
      return { cache, skipped };
    },

    updateReceipt: async (id, patch) => {
      const cache = readExpensesLS();
      const r = cache.receipts.find((x) => x.id === id);
      if (r) applyReceiptPatch(r, patch);   // field-by-field — UI input is untrusted
      writeExpensesLS(cache);
      return cache;
    },

    removeReceipt: async (id) => {
      const cache = readExpensesLS();
      const r = cache.receipts.find((x) => x.id === id);
      if (r) await idbDelete(receiptKey(r));
      cache.receipts = cache.receipts.filter((x) => x.id !== id);
      writeExpensesLS(cache);
      return cache;
    },

    openReceipt: async (id) => {
      // Open the tab SYNCHRONOUSLY, inside the tap's activation window —
      // Safari blocks window.open issued after an await. Navigate it to the
      // blob once the read completes.
      const win = window.open('', '_blank');
      try {
        const cache = readExpensesLS();
        const r = cache.receipts.find((x) => x.id === id);
        if (!r) { win?.close(); return; }
        const blob = await idbGet(receiptKey(r));
        if (!blob) throw new Error('The stored copy of this receipt is missing.');
        if (!win) {
          throw new Error('The browser blocked the receipt window — allow pop-ups for this site and try again.');
        }
        const url = URL.createObjectURL(blob);
        win.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 300_000);
      } catch (e) {
        win?.close();
        throw e;
      }
    },

    buildDraft: async (bookingIds) => {
      const { bookings } = readJson<BookingsCacheShape>(K.bookings, { bookings: [], fetchedAt: null });
      const weeks = readJson<Record<string, SswWeek>>(K.sswWeeks, {});
      let draft = assembleDraftReport(bookingIds, bookings, readExpensesLS().receipts, weeks);
      // The draft's name + employee ID come from the newest cached
      // timesheet — which a phone may not have. Fall back to the user's
      // identity from SSW's grid (their newest record EVER, however old),
      // remembered permanently after the first lookup.
      if (!draft.name && !draft.employeeId) {
        const ident = await getIdentity();
        if (ident) draft = { ...draft, name: ident.name, employeeId: ident.userId };
      }
      return draft;
    },

    saveReport: async (report) => saveReportLS(sanitizeReport(report)),

    removeReport: async (id) => {
      const cache = readExpensesLS();
      cache.reports = cache.reports.filter((r) => r.id !== id);
      writeExpensesLS(cache);
      return cache;
    },

    resetGig: async (bookingId, reportId) => {
      const cache = readExpensesLS();
      if (!bookingId && !reportId) return cache;
      for (const r of cache.receipts) {
        if (bookingId && r.bookingId === bookingId) await idbDelete(receiptKey(r));
      }
      cache.receipts = cache.receipts.filter((r) => !bookingId || r.bookingId !== bookingId);
      cache.reports = cache.reports.filter(
        (r) => !(reportId && r.id === reportId) && !(bookingId && r.bookingId === bookingId),
      );
      writeExpensesLS(cache);
      return cache;
    },

    // The share sheet is the phone's "export": Mail, Files, AirDrop — the
    // user picks. Falls back to plain downloads where share isn't available.
    exportReport: async (report) => {
      const clean = sanitizeReport(report);
      const files = await buildBundleFiles(clean);
      const nav = navigator as Navigator & {
        canShare?: (data: { files: File[] }) => boolean;
        share?: (data: { files: File[]; title?: string }) => Promise<void>;
      };
      if (nav.canShare?.({ files }) && nav.share) {
        try {
          await nav.share({ files, title: 'CT Expense Report' });
          saveReportLS(clean);                      // shared = worth keeping
          return { path: 'shared' };
        } catch (e) {
          const name = (e as Error)?.name;
          if (name === 'AbortError') return null;   // user closed the sheet
          // Building the PDFs can outlive the tap's activation window on
          // iOS — fall through to plain downloads instead of failing.
          if (name !== 'NotAllowedError' && name !== 'NotSupportedError') throw e;
        }
      }
      for (const file of files) {
        downloadFile(file);
        await delay(300);
      }
      saveReportLS(clean);                          // downloaded = worth keeping
      return { path: 'downloaded' };
    },

    mailReport: async () => {
      throw new Error('On the web, use Share — the share sheet can hand the PDFs straight to Mail.');
    },

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
