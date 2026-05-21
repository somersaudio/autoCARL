// ----- Site identifiers (used as keytar service keys) -----
export type CredService = 'carl' | 'ssw';

// ----- Shows + profile pulled from C.A.R.L. -----
export type PulledShow = {
  jobNumber: string;        // job/show number, e.g. "CTXX000000"
  jobName: string;          // show name, e.g. "Show Name - Department Labor"
  task: string;             // e.g. "3 Show"
  status: string;           // e.g. "Confirmed"
  notes: string;            // e.g. "" or "Dark Day"
  dateRange: string;        // raw text from C.A.R.L., e.g. "MM/DD/YYYY to MM/DD/YYYY"
  laborCoordinator: string; // labor coordinator name
  projectManager: string;   // project manager name
  position: string;         // e.g. "Audio Engineer" (from show detail page)
  perDiem: number | null;   // explicit dollar amount from CARL field_348. null if not set on the booking.
  perDiemIncluded: boolean; // true when the booking's travel requirements list "Per Diem".
  city: string;             // venue city extracted from the detail-page header
  state: string;            // 2-letter state code, e.g. "CA"
  // ISO dates pulled from the booking record (field_145 = show start,
  // field_222 = travel return). Used to auto-fill the timesheet form with
  // the days the user is actually on the show.
  scheduledStart: string | null; // "2026-05-10"
  scheduledEnd: string | null;   // "2026-05-23" (inclusive)
};

export type CarlProfile = {
  name: string;             // crew member's full name from C.A.R.L.
  userId: string;           // SpreadsheetWeb User ID (numeric string)
  phone: string;
  email: string;
};

// ----- Hours entry input -----
export type DayHours = {
  worked: boolean;
  startTime: string;        // "07:00"
  endTime: string;          // "19:00"
  mealStart?: string;       // optional split
  mealEnd?: string;
  // Per-diem dollar amount for this day. null/undefined = off (leave SSW
  // txtPD blank); a number = fill that dollar amount into txtPD_N_1.
  perDiem?: number | null;
  // The show (job number) this day is billed to, written to C.A.R.L.'s
  // per-day cmbJob_N select. Auto-filled from the schedule, user-overridable.
  // '' = no show assigned for this day.
  jobNumber?: string;
};

export type WeekEntry = {
  jobNumber: string;          // selected show
  weekOfMonday: string;       // ISO date "2026-05-18"
  includePerDiem: boolean;    // fill txtPD_N_1 on each day with show.perDiem (defaults true when show has per diem)
  days: [DayHours, DayHours, DayHours, DayHours, DayHours, DayHours, DayHours]; // Mon..Sun
};

// ----- Defaults for pre-fill -----
// Standard scheduled-day hours are hardcoded to 08:00–18:00 (see DEFAULT_START_TIME
// / DEFAULT_END_TIME constants in the renderer). Only dailyRate remains user-configurable.
export type WeeklyDefaults = {
  dailyRate: number | null; // user's daily rate; null = don't fill it on the form
};

export type Theme = 'dark' | 'light';

// Local cache of a week's entry, keyed by `${jobNumber}__${weekOfMonday}`.
// When the user returns to the same show + week, we load this and pre-fill
// the form. On Save, we update SSW's existing record (via sswRecordId)
// instead of creating a new one.
export type SavedWeek = {
  jobNumber: string;
  weekOfMonday: string;
  days: WeekEntry['days'];
  includePerDiem: boolean;
  lastSavedAt: string;          // ISO timestamp
  sswRecordId: string | null;   // SpreadsheetWeb RecordID, captured on first save
  // SSW workflow status of the record (e.g. "Complete", "Paid", "" for editable).
  // Used to show a lock banner when the timesheet is past the employee stage.
  sswStatus?: string;
};

// ----- Persisted app state -----
export type AppConfig = {
  carlUsername: string;        // C.A.R.L. login email
  sswUsername: string;         // SpreadsheetWeb username (not an email)
  pulledShows: PulledShow[];   // last refresh result
  pulledShowsAt: string | null;// ISO timestamp of last refresh
  profile: CarlProfile | null;
  weeklyDefaults: WeeklyDefaults;
  savedWeeks: Record<string, SavedWeek>;
  // Cached after first successful SSW session so we can skip the
  // "Select an Application" step on subsequent ops.
  sswAppId: string | null;
  theme: Theme;
  // When true, opening a new week auto-fills the days that fall within the
  // selected show's scheduled date range. Unscheduled days are left blank.
  autoApplySchedule: boolean;
  // When true, the per-day "Meal break (start/end)" column is hidden in the
  // Submit Hours table.
  hideMealBreak: boolean;
};

// ----- Automation result types -----
export type RefreshResult =
  | { ok: true; shows: PulledShow[]; profile: CarlProfile }
  | { ok: false; error: string };

export type SubmitResult =
  | { ok: true; confirmationId?: string; sswRecordId?: string | null }
  | { ok: false; error: string; screenshotPath?: string };

export type LoadExistingResult =
  | {
      ok: true;
      existing: { recordId: string; days: WeekEntry['days']; includePerDiem: boolean; status: string } | null;
      // Set when no record matches {week, this show} but a record exists for the
      // same week under a DIFFERENT show (one weekly timesheet can hold several).
      weekRecordOtherShow?: { jobNumber: string; status: string } | null;
    }
  | { ok: false; error: string };

export type LoadMostRecentResult =
  | { ok: true; record: { jobNumber: string; weekOfMonday: string; recordId: string; days: WeekEntry['days']; includePerDiem: boolean; status: string } | null }
  | { ok: false; error: string };

export function weekKey(jobNumber: string, weekOfMonday: string): string {
  return `${jobNumber}__${weekOfMonday}`;
}

export type ProgressOp = 'ssw-load' | 'ssw-load-most-recent' | 'ssw-fill' | 'carl-refresh';
export type ProgressEvent = {
  op: ProgressOp;
  percent: number;     // 0-100
  label: string;       // user-facing stage description, e.g. "Logging in"
  done: boolean;       // true on the final emission (success or error)
};

export type ProgressReporter = (percent: number, label: string) => void;

// ----- IPC bridge -----
export type Api = {
  config: {
    get: () => Promise<AppConfig>;
    update: (patch: Partial<AppConfig>) => Promise<AppConfig>;
  };
  credentials: {
    save: (service: CredService, username: string, password: string) => Promise<void>;
    has: (service: CredService, username: string) => Promise<boolean>;
    clear: (service: CredService, username: string) => Promise<void>;
  };
  carl: {
    refresh: () => Promise<RefreshResult>;
  };
  logo: {
    // Resolve a show's company logo (via logo.dev, server-side) to a data URI,
    // or null if none found. Cached per company for the session.
    forShow: (jobName: string) => Promise<string | null>;
  };
  timesheet: {
    // Fills the timesheet on SpreadsheetWeb headlessly, clicks Save (employee
    // stage — never the workflow-advance Submit). If a record already exists
    // for {jobNumber, weekOfMonday} on SSW, updates it instead of creating new.
    fill: (entry: WeekEntry) => Promise<SubmitResult>;
    // Looks for an existing record on SSW for {jobNumber, weekOfMonday} and
    // returns its contents so the UI can preload them. Null existing = no
    // record found.
    loadExisting: (jobNumber: string, weekOfMonday: string) => Promise<LoadExistingResult>;
    // Finds the most-recently-updated record on SSW (regardless of show/week)
    // and returns it, so the app can land the user on whatever they're
    // currently working on without needing cached show data.
    loadMostRecent: () => Promise<LoadMostRecentResult>;
  };
  progress: {
    // Subscribe to progress events emitted by SSW automation runs.
    // Returns an unsubscribe function.
    subscribe: (handler: (e: ProgressEvent) => void) => () => void;
  };
};

declare global {
  interface Window {
    api: Api;
  }
}
