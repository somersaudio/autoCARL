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
  // Email that goes onto the timesheet. '' = keep SSW's stored address;
  // anything else overwrites it on every save. Not the login address.
  timesheetEmail: string;
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
  // The LC-authored "Booking Notes" text from the booking page. Refreshed on
  // every sweep, so new notes show up on app open.
  bookingNotes?: string;
  // The note text as of the last time the user viewed it on the full card.
  // Badge shows while bookingNotes !== notesSeen — i.e. first-ever note, or
  // an edit since last viewing. Preserved across sweeps.
  notesSeen?: string;
};
export type BookingContactsCache = Record<string, BookingContacts>;

// ----- Friends (mutual-consent gig sharing; see main/friends.ts) -----

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
  // Set by web enroll when sign-on attached to an EXISTING account for this
  // email (multi-device sign-in). Shown to the user — if they never enrolled
  // anywhere before, an account existing already means someone else made it.
  linkedExisting?: { accountCreatedAt: string | null; firstVerified: boolean };
};

// ----- Expense reports (receipts → CT reimbursement form; see main/expenses.ts) -----

// The categories mirror the CT Expense Reimbursement Form's money columns
// exactly — a receipt's category decides which column its amount lands in.
// Mileage is deliberately absent: miles aren't a receipt, they come from
// timesheets (SswDay.miles) or hand-entry on the report row.
export type ExpenseCategory = 'lodging' | 'airfare' | 'parking' | 'carRental' | 'rideshare' | 'misc';

export type ExpenseReceipt = {
  id: string;
  addedAt: string;          // ISO timestamp
  file: string;             // absolute path of our stored copy in userData/receipts
  originalName: string;     // filename as dropped, for display
  kind: 'image' | 'pdf';
  merchant: string;         // OCR-parsed; user-editable
  date: string;             // ISO YYYY-MM-DD; '' = OCR couldn't find one
  amount: number;           // USD
  // User-authored line description — becomes the form row's
  // Description/Reason verbatim. Starts empty; never auto-filled.
  description: string;
  category: ExpenseCategory;
  bookingId: string;        // matched gig; '' = unassigned
  ocrText: string;          // raw extracted text, kept for debugging/re-parse
};

// One line on the form's expense table. Money fields map 1:1 onto columns;
// mileage dollars are computed at export time as miles × report.mileageRate.
export type ExpenseRow = {
  jobNumber: string;
  description: string;
  lodging: number;
  airfare: number;
  parking: number;
  carRental: number;
  miles: number;
  rideshare: number;
  misc: number;
  receiptIds: string[];     // receipts backing this row — attached to the exported PDF
};

export type ExpenseReport = {
  id: string;
  createdAt: string;        // ISO timestamp
  // The gig this report was built for — keeps the picker, receipts list and
  // sheet in agreement. '' on reports saved before this field existed.
  bookingId: string;
  date: string;             // form DATE field, MM/DD/YYYY
  name: string;
  employeeId: string;
  projectManager: string;
  laborCoordinator: string;
  stateWorkedIn: string;
  countryWorkedIn: string;
  mileageRate: number;      // $/mile — the 2025 form says 70¢; editable when IRS moves it
  comments: string;
  notes: string;
  rows: ExpenseRow[];
};

export type ExpensesCache = { receipts: ExpenseReceipt[]; reports: ExpenseReport[] };

// Result of a receipt-intake run. Files that were refused (a combined
// multi-receipt PDF, an unreadable file, an unknown format) come back with
// a human reason so the renderer can say WHY instead of silently dropping.
export type IngestOutcome = {
  cache: ExpensesCache;
  skipped: Array<{ name: string; reason: string }>;
};

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
    // Records the current bookingNotes text as viewed, clearing the
    // new-note badge until the note changes again.
    markNotesSeen: (bookingId: string) => Promise<void>;
  };
  ssw: {
    // Returns the last-known snapshot of a week from disk (sub-ms). Null if
    // we've never fetched this week yet.
    getCached: (weekStartDate: string) => Promise<SswWeek | null>;
    // Every cached week keyed by Monday ISO — feeds actual timesheet hours
    // into the paycheck estimator.
    getCachedWeeks: () => Promise<Record<string, SswWeek>>;
    // Who the user is — name + numeric CT id — independent of any week:
    // cached weeks first, else the newest timesheet record EVER via SSW's
    // grid. Cached permanently after the first answer. Null only when the
    // user has never had a timesheet at all.
    identity: () => Promise<{ name: string; userId: string } | null>;
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
  friends: {
    status: () => Promise<FriendsStatus>;
    // Registers with the friends service under the CARL email + given name,
    // and publishes the current schedule.
    enroll: (name: string) => Promise<FriendsStatus>;
    list: () => Promise<FriendsList>;
    request: (email: string) => Promise<void>;
    respond: (email: string, accept: boolean) => Promise<void>;
    remove: (email: string) => Promise<void>;
  };
  expenses: {
    getCached: () => Promise<ExpensesCache>;
    // Ingest receipt files (images or PDFs) by absolute path: copy into
    // userData, OCR/extract text, parse amount + category. assignTo pins
    // every dropped receipt to that booking (the gig selected in the UI);
    // without it, date-matching decides. Returns the updated cache.
    addFiles: (paths: string[], assignTo?: string) => Promise<IngestOutcome>;
    // Same pipeline behind a native open dialog. Null = user cancelled.
    pickFiles: (assignTo?: string) => Promise<IngestOutcome | null>;
    // Web only: ingest browser File objects (file input / drag-drop) — the
    // browser has no filesystem paths. Desktop leaves this undefined and the
    // renderer falls back to the path-based flow above.
    ingestFiles?: (files: File[], assignTo?: string) => Promise<IngestOutcome>;
    updateReceipt: (id: string, patch: Partial<ExpenseReceipt>) => Promise<ExpensesCache>;
    removeReceipt: (id: string) => Promise<ExpensesCache>;
    // Opens the stored receipt copy in the OS default viewer.
    openReceipt: (id: string) => Promise<void>;
    // Prefills a report from the chosen bookings: identity from SSW, PM/LC
    // from the bookings, per-category sums from assigned receipts, miles from
    // cached timesheets. Not persisted until saveReport/exportReport.
    buildDraft: (bookingIds: string[]) => Promise<ExpenseReport>;
    saveReport: (report: ExpenseReport) => Promise<ExpensesCache>;
    removeReport: (id: string) => Promise<ExpensesCache>;
    // Clean slate for a gig: deletes its receipts (files and all) plus its
    // report. The sheet rebuilds empty afterwards.
    resetGig: (bookingId: string, reportId?: string) => Promise<ExpensesCache>;
    // Folder picker → the filled CT form PDF plus every referenced receipt
    // as its own PDF (images converted), written into that folder, which is
    // then opened. Null = cancelled.
    exportReport: (report: ExpenseReport) => Promise<{ path: string } | null>;
    // Opens a Mail draft to the gig's PM, LC and payroll with the form PDF
    // attached first and every receipt PDF after it. Nothing auto-sends.
    mailReport: (report: ExpenseReport) => Promise<void>;
    // Electron ≥32 removed File.path — this wraps webUtils.getPathForFile so
    // drag-and-dropped receipts resolve to real filesystem paths.
    pathForFile: (file: File) => string;
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
