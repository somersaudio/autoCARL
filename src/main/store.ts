import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Booking, BookingContactsCache, FlightsCache, SswWeek } from '../shared/types';
import type { FilingStatus } from '../shared/taxes';

// These live inside userData, which is already the app's own directory, so the
// filenames don't repeat the app name.
const CONFIG_FILE = 'config.json';
const BOOKINGS_FILE = 'bookings.json';
const FLIGHTS_FILE = 'flights.json';
const FLIGHTS_DIR = 'flights';
const SSW_WEEKS_FILE = 'ssw-weeks.json';
const CONTACTS_FILE = 'contacts.json';

// What these files were called when this app shipped alongside its predecessor
// and prefixed everything to stay out of its way. migrateStoreFiles() copies
// them across on first run.
//
// Note the old prefix was 'autocarl2-'; the *predecessor's* files are named
// 'autocarl-*' and still sit in the same directory. That is exactly why the
// new names drop the prefix entirely rather than shortening it — reusing
// 'autocarl-config.json' would silently adopt the old app's config.
const LEGACY_FILES: Record<string, string> = {
  [CONFIG_FILE]: 'autocarl2-config.json',
  [BOOKINGS_FILE]: 'autocarl2-bookings.json',
  [FLIGHTS_FILE]: 'autocarl2-flights.json',
  [SSW_WEEKS_FILE]: 'autocarl2-ssw-weeks.json',
  [CONTACTS_FILE]: 'autocarl2-contacts.json',
};

/**
 * Copy any store files still under their old names across to the current ones.
 * Safe on every launch: only writes when the new file is absent, and leaves the
 * old one in place so a partial run can simply be repeated. Never throws —
 * losing a cache should not stop the app booting.
 */
export async function migrateStoreFiles(): Promise<void> {
  const dir = app.getPath('userData');
  for (const [current, legacy] of Object.entries(LEGACY_FILES)) {
    try {
      await fs.access(join(dir, current));
      continue;                                   // already migrated
    } catch { /* not there yet — fall through and try the copy */ }
    try {
      await fs.copyFile(join(dir, legacy), join(dir, current));
    } catch {
      /* no legacy file either (fresh install) — nothing to do */
    }
  }
}

export type Config = {
  carlEmail: string;
  sswEmail: string;
  defaultStartTime: string;  // e.g. '8:00 am' — autofilled on empty worked days
  defaultEndTime: string;    // e.g. '6:00 pm'
  autofillPerDiem: boolean;  // when false, leave per-diem empty for user to fill
  defaultDailyRate: number;  // legacy; Settings saves clear it. When >0 it stands in for basePayDayRate as the timesheet rate (see saveDailyRate)
  // Email submitted on the timesheet. '' = keep whatever SSW has stored
  // (iEmail); anything else overwrites it on every save. Separate from
  // sswEmail, which is the LOGIN — some crew log in with one address and
  // want a different one on the paperwork.
  timesheetEmail: string;
  // Phone submitted on the timesheet, digits only. '' = keep whatever SSW has
  // stored (iPhone); anything else overwrites it on every save.
  timesheetPhone: string;
  theme: string;             // theme id, see renderer/themes.ts — fresh installs get 'constellation'
  // Earnings inputs. basePayDayRate is also the rate timesheets save with,
  // unless a week's rate is edited in that save.
  basePayDayRate: number;    // day rate for projections; 0 = unset, estimate hidden
  subtractTaxes: boolean;    // show after-tax take-home as well as gross
  perDiemInTotal: boolean;   // estimator: fold per diem into the deposit figure
  homeAirport: string;       // IATA home base for travel legs, '' = unset
  retirementPct: number;     // 401k contribution as % of gross wages; 0 = none
  filingStatus: FilingStatus;
  ytdWages: number;          // taxable wages so far this year; 0 = unknown
  ytdAsOf: string;           // ISO date ytdWages was measured; '' = today
  expectedAnnualWages: number; // YOUR expected taxable wages for the year; 0 = unknown
  spouseAnnualWages: number;   // spouse's expected wages; married-filing-jointly only
  stateTaxRatePct: number;   // flat state income tax rate; 0 = none
  gigDayRates: Record<string, number>;  // per-booking day-rate overrides, by bookingId
  slippedWeeks: string[];  // Mondays of timesheet weeks marked not paid on their check
  // Friends service (see main/friends.ts). The token is a bearer credential —
  // deliberately NOT exposed through UserSettings to the renderer.
  friendsToken: string;
  friendsName: string;
  // Who the user is per SSW's newest timesheet record — cached permanently
  // once learned (see the ssw:identity handler). Feeds expense drafts and
  // friends auto sign-on on installs with no cached weeks yet.
  identityName: string;
  identityUserId: string;
  // The user signed out of friends ON PURPOSE — blocks auto sign-on.
  friendsSignedOut: boolean;
  // Local copy of the buddy icon (data URI) for instant preview.
  friendsAvatar: string;
  // "I don't submit timesheets through C.A.R.L." — SSW setup skipped;
  // Timesheet tab and timesheet settings hidden.
  sswSkipped: boolean;
};

const DEFAULT_CONFIG: Config = {
  carlEmail: '',
  sswEmail: '',
  defaultStartTime: '8:00 am',
  defaultEndTime: '6:00 pm',
  autofillPerDiem: true,
  defaultDailyRate: 0,
  timesheetEmail: '',
  timesheetPhone: '',
  theme: 'constellation',
  basePayDayRate: 0,
  subtractTaxes: false,
  perDiemInTotal: true,
  homeAirport: '',
  retirementPct: 0,
  filingStatus: 'single',
  ytdWages: 0,
  ytdAsOf: '',
  expectedAnnualWages: 0,
  spouseAnnualWages: 0,
  stateTaxRatePct: 0,
  gigDayRates: {},
  slippedWeeks: [],
  friendsToken: '',
  friendsName: '',
  identityName: '',
  identityUserId: '',
  friendsSignedOut: false,
  friendsAvatar: '',
  sswSkipped: false,
};

function configPath(): string { return join(app.getPath('userData'), CONFIG_FILE); }
function bookingsPath(): string { return join(app.getPath('userData'), BOOKINGS_FILE); }

export async function readConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    throw e;
  }
}

// Config writes take turns. Two at once — a friends reply landing while Log out
// runs, say — each read the whole file and each write the whole thing back, so
// the slower one puts everything the other just cleared straight back.
let configQueue: Promise<unknown> = Promise.resolve();
function inConfigQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = configQueue.then(task, task);
  configQueue = run.catch(() => {});
  return run;
}

// `stillCurrent` is asked about the file as it stands when the write's turn
// comes, so a reply that belongs to a login since logged out can refuse its own
// write with nothing able to land between the question and the write. It gets
// back what is stored, patched or not, so the caller can see which happened.
export async function updateConfig(
  patch: Partial<Config>,
  stillCurrent: (cfg: Config) => boolean = () => true,
): Promise<Config> {
  return inConfigQueue(async () => {
    const current = await readConfig();
    if (!stillCurrent(current)) return current;
    const next = { ...current, ...patch };
    await fs.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}

export async function readCachedBookings(): Promise<{ bookings: Booking[]; fetchedAt: string | null }> {
  try {
    const raw = await fs.readFile(bookingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { bookings: parsed.bookings || [], fetchedAt: parsed.fetchedAt || null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { bookings: [], fetchedAt: null };
    throw e;
  }
}

export async function writeCachedBookings(bookings: Booking[]): Promise<string> {
  const fetchedAt = new Date().toISOString();
  await fs.writeFile(bookingsPath(), JSON.stringify({ bookings, fetchedAt }, null, 2), 'utf8');
  return fetchedAt;
}

// ----- flights cache -----

function flightsIndexPath(): string { return join(app.getPath('userData'), FLIGHTS_FILE); }
export function flightsDir(): string { return join(app.getPath('userData'), FLIGHTS_DIR); }

export async function readFlightsCache(): Promise<FlightsCache> {
  try {
    const raw = await fs.readFile(flightsIndexPath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

export async function writeFlightsCache(cache: FlightsCache): Promise<void> {
  await fs.mkdir(flightsDir(), { recursive: true });
  await fs.writeFile(flightsIndexPath(), JSON.stringify(cache, null, 2), 'utf8');
}

// ----- SSW week cache (per-week disk snapshot) -----
//
// Keyed by week-start-Monday ISO ("2026-05-18"). We snapshot the SswWeek shape
// after every successful fetchWeek so the renderer can paint last-known data
// instantly on app open while the live refresh runs in the background.

type SswWeekCache = Record<string, SswWeek>;

function sswWeeksPath(): string { return join(app.getPath('userData'), SSW_WEEKS_FILE); }

export async function readSswWeeksCache(): Promise<SswWeekCache> {
  try {
    const raw = await fs.readFile(sswWeeksPath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

export async function readSswWeek(weekStartDate: string): Promise<SswWeek | null> {
  const cache = await readSswWeeksCache();
  return cache[weekStartDate] || null;
}

// Writes and deletes of the week cache run one at a time, so a delete can't
// land between a write's read and its write and bring the whole old cache back.
let sswWeeksQueue: Promise<unknown> = Promise.resolve();
function inSswWeeksQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = sswWeeksQueue.then(task, task);
  sswWeeksQueue = run.catch(() => {});
  return run;
}

// `stillCurrent` is checked when the write's turn comes; a week read for an
// account that has since been logged out is dropped.
export async function writeSswWeek(
  weekStartDate: string,
  week: SswWeek,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  return inSswWeeksQueue(async () => {
    if (!stillCurrent()) return;
    // A file cut short (a crash mid-write) starts over instead of failing every
    // later write until Log out removes it.
    const cache = await readSswWeeksCache().catch((): SswWeekCache => ({}));
    cache[weekStartDate] = week;
    await fs.writeFile(sswWeeksPath(), JSON.stringify(cache, null, 2), 'utf8');
  });
}

// Logout, Reset, or a switch to another account: the weeks cached here are the
// last person's timesheets, and the Timesheet tab paints them before fetching.
// The copy under the old file name goes too: with ssw-weeks.json gone, the next
// launch's migrateStoreFiles would copy it back.
export async function clearSswWeeksCache(): Promise<void> {
  return inSswWeeksQueue(async () => {
    await fs.rm(sswWeeksPath(), { force: true });
    await fs.rm(join(app.getPath('userData'), LEGACY_FILES[SSW_WEEKS_FILE]), { force: true });
  });
}

// ----- BookingContacts cache (PM/LC emails scraped from CARL) -----

function contactsPath(): string { return join(app.getPath('userData'), CONTACTS_FILE); }

export async function readContactsCache(): Promise<BookingContactsCache> {
  try {
    const raw = await fs.readFile(contactsPath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

export async function writeContactsCache(cache: BookingContactsCache): Promise<void> {
  await fs.writeFile(contactsPath(), JSON.stringify(cache, null, 2), 'utf8');
}
