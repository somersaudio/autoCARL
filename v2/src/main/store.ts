import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Booking, BookingContactsCache, FlightsCache, SswWeek } from '../shared/types';

const CONFIG_FILE = 'autocarl2-config.json';
const BOOKINGS_FILE = 'autocarl2-bookings.json';
const FLIGHTS_FILE = 'autocarl2-flights.json';
const FLIGHTS_DIR = 'flights';
const SSW_WEEKS_FILE = 'autocarl2-ssw-weeks.json';
const CONTACTS_FILE = 'autocarl2-contacts.json';

type Config = {
  carlEmail: string;
  sswEmail: string;
  defaultStartTime: string;  // e.g. '8:00 am' — autofilled on empty worked days
  defaultEndTime: string;    // e.g. '6:00 pm'
  autofillPerDiem: boolean;  // when false, leave per-diem empty for user to fill
  defaultDailyRate: number;  // 0 = use SSW's stored iDailyRate; >0 overrides on every push
  theme: string;             // theme id, see renderer/themes.ts — 'default' is the CT-gold dark
};

const DEFAULT_CONFIG: Config = {
  carlEmail: '',
  sswEmail: '',
  defaultStartTime: '8:00 am',
  defaultEndTime: '6:00 pm',
  autofillPerDiem: true,
  defaultDailyRate: 0,
  theme: 'default',
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

export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await readConfig()), ...patch };
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
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

export async function writeSswWeek(weekStartDate: string, week: SswWeek): Promise<void> {
  const cache = await readSswWeeksCache();
  cache[weekStartDate] = week;
  await fs.writeFile(sswWeeksPath(), JSON.stringify(cache, null, 2), 'utf8');
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
