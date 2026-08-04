import type { FilingStatus } from './taxes';

// A single CARL booking. One show can have multiple bookings (different
// date ranges + different positions); each iCal VEVENT becomes one Booking.
export type Booking = {
  bookingId: string;          // iCal UID — matches CARL's booking-details-1/<id>
  jobNumber: string;          // e.g. "CTLA025403"
  jobName: string;            // e.g. "Google I/O '26 - Tracks Audio Labor"
  status: string;             // e.g. "Confirmed"
  position: string;           // e.g. "Outdoor Audio Engineer" (numeric prefix stripped)
  projectManager: string;
  laborCoordinator: string;
  city: string;               // e.g. "Mountain View"
  state: string;              // e.g. "CA"
  startDate: string;          // ISO "YYYY-MM-DD" — first day inclusive
  endDate: string;            // ISO "YYYY-MM-DD" — LAST day inclusive (we collapse iCal's +1 exclusive)
};

// User-editable settings exposed via the Settings modal. Stored in
// userData/config.json alongside the email fields.
export type UserSettings = {
  defaultStartTime: string;  // e.g. '8:00 am' — autofilled into empty worked days
  defaultEndTime: string;    // e.g. '6:00 pm'
  autofillPerDiem: boolean;  // when false, the app leaves per-diem empty for the user to fill manually
  defaultDailyRate: number;  // 0 = use whatever SSW has stored; >0 overwrites SSW's iDailyRate on every save
  theme: string;             // theme id, see renderer/themes.ts — fresh installs get 'constellation'
  // ----- earnings estimates (display only — never pushed to SSW) -----
  // Deliberately separate from defaultDailyRate above: that one rewrites your
  // SSW record on save, this one only feeds the projection on the bookings card.
  basePayDayRate: number;    // your day rate in USD; 0 = unset, estimate is hidden
  subtractTaxes: boolean;    // when true, show take-home after tax alongside gross
  retirementPct: number;     // 401k contribution as % of gross wages; 0 = none
  // Tax inputs. Federal tax uses real brackets (see shared/taxes.ts) rather
  // than a flat rate, so it needs to know where the user sits in the year.
  filingStatus: FilingStatus;
  ytdWages: number;          // YOUR taxable wages earned so far this year; 0 = unknown
  // Date ytdWages was measured — the period-end on the stub it came from.
  // ISO 'YYYY-MM-DD', '' = treat as today. Without this the full-year
  // projection divides by too much elapsed year and understates income.
  ytdAsOf: string;
  expectedAnnualWages: number; // YOUR expected taxable wages for the full year; 0 = unknown
  // Spouse's expected wages, for married-filing-jointly only. Federal brackets
  // apply to household income, but Social Security is capped per person — so
  // the two figures have to stay separate. Ignored for other filing statuses.
  spouseAnnualWages: number;
  stateTaxRatePct: number;   // flat state rate, e.g. 0 for TX/FL/NV; 0 = none
  // Per-booking day-rate overrides, keyed by bookingId. A gig paying something
  // other than your usual rate gets an entry here; everything else falls back
  // to basePayDayRate. Absent key = no override.
  gigDayRates: Record<string, number>;
};

// Two-stage onboarding: CARL first (gives us the iCal URL + read path),
// then SSW (gives us the write path). The app is "ready" only once both are
// stored. The renderer routes on `stage` to show the right form.
export type SetupStatus =
  | { stage: 'needs-carl-credentials' }
  | { stage: 'needs-ssw-credentials' }
  | { stage: 'ready'; icalUrl: string }
  | { stage: 'error'; from: 'carl' | 'ssw'; message: string };

export type RefreshResult =
  | { ok: true; bookings: Booking[]; fetchedAt: string }
  | { ok: false; error: string };

// ----- SSW timesheet (write path) -----

// One day in a week's timesheet. Times are stored as display strings to keep
// round-tripping with SSW lossless ('8:00 am' style — exactly what SSW expects
// in its iStart_Time_IN_* inputs).
export type SswDay = {
  date: string;             // ISO YYYY-MM-DD
  weekday: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';
  job: string;              // e.g. "CTLA025403" — empty string = "no work this day"
  startTime: string;        // "8:00 am" or "" if not worked
  endTime: string;          // "7:00 pm"
  lunchStart: string;       // "" if no lunch
  lunchEnd: string;
  perDiem: number;          // 92 (USD), 0 = none
  miles: number | null;
  // Computed by SSW's spreadsheet — surfaced read-only in the UI:
  regHours: number;
  otHours: number;
  dtHours: number;
  totalHours: number;
};

// A whole week's timesheet record from SSW.
export type SswWeek = {
  recordId: string;
  weekStartDate: string;    // ISO YYYY-MM-DD (Monday)
  // PrimaryTable identity fields — preserved verbatim on save.
  name: string;
  email: string;
  phone: string;
  position: string;
  laborCoordinator: string;
  projectManager: string;
  userId: string;
  employeeId: string;
  dailyRate: string;        // iDailyRate verbatim (e.g. "525.00") — read-only in UI, preserved on save
  // Routing flags also preserved verbatim:
  groupId: number;          // PrimaryTable.intGroupId — feeds SaveInformation.SetGroupId
  californiaCheck: boolean;
  comments: string;
  // Seven entries Mon-Sun:
  days: SswDay[];
  // Status, for read-only display (0 = Saved/Draft, higher = submitted/locked):
  statusIndex: number;
};

// Result of a push attempt — same union shape as RefreshResult.
export type SswPushResult =
  | { ok: true; recordId: string; savedAt: string }
  | { ok: false; error: string };

// One flight itinerary PDF attached to a booking in CARL, with optional
// summary fields. Two layers of metadata, in order of preference:
//   1. PDF-parsed fields (outboundTo / returnTo populated → trusted)
//   2. CARL flights-table row data (departure airports + dates only)
// The renderer falls back from (1) → (2) → round-trip inference.
export type FlightPdf = {
  url: string;            // original S3 URL on CARL's bucket
  filename: string;       // e.g. "John-Somers-...-CTLA024572-PO039270.pdf"
  localPath: string;      // absolute path to cached copy in userData
  fetchedAt: string;      // ISO
  // Vendor + confirmation come from CARL's table. PDF parse may also expose
  // them but the table is more reliable.
  vendor?: string;
  confirmation?: string;
  // Per-leg origin/destination. *From* fields come from either CARL's table
  // (departure-airport column) or the PDF parse; *To* fields are PDF-only.
  outboundDate?: string;
  outboundFrom?: string;
  outboundTo?: string;    // PDF-parsed; undefined if PDF didn't yield it
  returnDate?: string;
  returnFrom?: string;
  returnTo?: string;      // PDF-parsed; undefined for one-way trips
  legCount?: number;      // PDF-parsed leg count (1 = one-way, 2 = round-trip)
};

// Cache of flight PDFs per booking. Map keyed by bookingId.
export type FlightsCache = Record<string, FlightPdf[]>;

// Per-booking extras scraped from the CARL booking detail page — stuff iCal
// doesn't carry. Email fields are empty strings when the page doesn't expose
// them; perDiem / venue / GSA fields are undefined when not present.
export type BookingContacts = {
  pmEmail: string;
  lcEmail: string;
  perDiem?: number;            // CARL's stored rate (fallback)
  venue?: string;              // e.g. "Las Vegas Convention Center"
  venueAddress?: string;       // street + city + state line
  venueZip?: string;           // 5-digit US zip
  gsaPerDiem?: number;         // M&IE rate from GSA API, looked up by zip
  gsaCity?: string;            // city name returned by GSA (for display sanity)
  // CARL's laborTravel status, e.g. "Flight Requests Open to Crew". The
  // renderer keys the flight-request button off this.
  laborTravel?: string;
};
export type BookingContactsCache = Record<string, BookingContacts>;

// Progress of an in-progress macOS auto-update. 'downloading' carries a 0–100
// percent (when the server gives a Content-Length); 'installing' means the ZIP
// is down and we're about to swap the bundle and relaunch.
export type UpdateProgress =
  | { phase: 'downloading'; percent: number }
  | { phase: 'installing' };

// ----- IPC bridge -----
export type Api = {
  setup: {
    getStatus: () => Promise<SetupStatus>;
    // Saves CARL creds and runs one-time iCal URL discovery via Playwright.
    // Resolves with 'needs-ssw-credentials' on success (or 'error' on failure).
    saveCarl: (email: string, password: string) => Promise<SetupStatus>;
    // Like saveCarl but skips auto-discovery — uses the user-pasted URL.
    // For users where the auto-discover formula doesn't match their account.
    saveCarlWithUrl: (email: string, password: string, icalUrl: string) => Promise<SetupStatus>;
    // Saves SSW creds. We don't verify them at setup time — verification
    // happens on the first write. Resolves with 'ready'.
    saveSsw: (email: string, password: string) => Promise<SetupStatus>;
    clear: () => Promise<void>;
  };
  bookings: {
    // Returns whatever's cached on disk immediately (may be empty on first run).
    getCached: () => Promise<{ bookings: Booking[]; fetchedAt: string | null }>;
    // Forces a fresh iCal fetch + parse + cache write. Resolves with result.
    refresh: () => Promise<RefreshResult>;
    // Subscribe to background refreshes (called by the 5-min poll on success).
    subscribe: (handler: (r: RefreshResult) => void) => () => void;
    // Opens this booking's CARL page in the default browser (e.g. to complete
    // a flight request).
    openInCarl: (bookingId: string) => Promise<void>;
  };
  flights: {
    // Returns the full bookingId → FlightPdf[] cache from disk.
    getCached: () => Promise<FlightsCache>;
    // Opens a cached PDF in the OS default viewer.
    open: (localPath: string) => Promise<void>;
    // Subscribe to flight cache updates (pushed during the once-per-launch sweep).
    subscribe: (handler: (cache: FlightsCache) => void) => () => void;
  };
  contacts: {
    // bookingId → { pmEmail, lcEmail } scraped from CARL booking detail page.
    getCached: () => Promise<BookingContactsCache>;
    subscribe: (handler: (cache: BookingContactsCache) => void) => () => void;
  };
  ssw: {
    // Returns the last-known snapshot of a week from disk (sub-ms). Null if
    // we've never fetched this week yet.
    getCached: (weekStartDate: string) => Promise<SswWeek | null>;
    // Pulls a week's full timesheet from SSW (RecordId lookup + GetRecordExtended).
    // Caches the result to disk on success. Returns null if no SSW record
    // exists for that week yet.
    fetchWeek: (weekStartDate: string) => Promise<SswWeek | null>;
    // Creates a new SSW record for the given week by copying identity fields
    // (name, email, position, group, rate, etc.) from the user's latest
    // existing record. Returns the new SswWeek, or throws on failure.
    createWeek: (weekStartDate: string) => Promise<SswWeek | null>;
    // Saves a modified week. Builds the 169-input Calculate payload from this.
    pushWeek: (week: SswWeek) => Promise<SswPushResult>;
  };
  logo: {
    forJob: (jobName: string) => Promise<string | null>;
  };
  app: {
    getVersion: () => Promise<string>;
  };
  updater: {
    // Fires during a macOS auto-update so the renderer can show a progress
    // overlay. The app quits shortly after the final 'installing' event.
    onProgress: (handler: (p: UpdateProgress) => void) => () => void;
  };
  settings: {
    get: () => Promise<UserSettings>;
    update: (patch: Partial<UserSettings>) => Promise<UserSettings>;
    // Returns the stored email for each service (passwords are never sent
    // to the renderer — only updated via the credential endpoints below).
    getCredentials: () => Promise<{ carlEmail: string; sswEmail: string }>;
    // Validates the creds against the live service before persisting. On
    // success, swaps the keychain entry. On failure, returns the error
    // message and leaves the existing creds untouched.
    updateCarlCredentials: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    updateSswCredentials: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
};

declare global {
  interface Window {
    api: Api;
  }
}
