// ----- Site identifiers (used as keytar service keys) -----
export type CredService = 'carl' | 'ssw';

// ----- Shows + profile pulled from C.A.R.L. -----
export type PulledShow = {
  jobNumber: string;        // e.g. "CTLA025403"
  jobName: string;          // e.g. "Google I/O '26 - Tracks Audio Labor"
  task: string;             // e.g. "3 Show"
  status: string;           // e.g. "Confirmed"
  notes: string;            // e.g. "" or "Dark Day 6.2.26"
  dateRange: string;        // raw text from C.A.R.L., e.g. "05/10/2026 to 05/23/2026"
  laborCoordinator: string; // e.g. "Leah Hall"
  projectManager: string;   // e.g. "Andrew Young"
  position: string;         // e.g. "Outdoor Audio Engineer" (from show detail page)
  perDiem: number | null;   // e.g. 92 (from CARL field_348). null if show has no per diem.
};

export type CarlProfile = {
  name: string;             // e.g. "John Somers"
  userId: string;           // SpreadsheetWeb User ID (e.g. "16065")
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
};

export type WeekEntry = {
  jobNumber: string;          // selected show
  weekOfMonday: string;       // ISO date "2026-05-18"
  includePerDiem: boolean;    // fill txtPD_N_1 on each day with show.perDiem (defaults true when show has per diem)
  days: [DayHours, DayHours, DayHours, DayHours, DayHours, DayHours, DayHours]; // Mon..Sun
};

// ----- Defaults for pre-fill -----
export type WeeklyDefaults = {
  startTime: string;        // default "07:00"
  endTime: string;          // default "19:00"
  workMonFri: boolean;      // default true: pre-check Mon-Fri, leave Sat/Sun unchecked
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
};

// ----- Persisted app state -----
export type AppConfig = {
  carlUsername: string;        // email
  sswUsername: string;         // e.g. "Jsomers"
  pulledShows: PulledShow[];   // last refresh result
  pulledShowsAt: string | null;// ISO timestamp of last refresh
  profile: CarlProfile | null;
  weeklyDefaults: WeeklyDefaults;
  savedWeeks: Record<string, SavedWeek>;
  // Cached after first successful SSW session so we can skip the
  // "Select an Application" step on subsequent ops.
  sswAppId: string | null;
  theme: Theme;
};

// ----- Automation result types -----
export type RefreshResult =
  | { ok: true; shows: PulledShow[]; profile: CarlProfile }
  | { ok: false; error: string };

export type SubmitResult =
  | { ok: true; confirmationId?: string; sswRecordId?: string | null }
  | { ok: false; error: string; screenshotPath?: string };

export type LoadExistingResult =
  | { ok: true; existing: { recordId: string; days: WeekEntry['days']; includePerDiem: boolean } | null }
  | { ok: false; error: string };

export type LoadMostRecentResult =
  | { ok: true; record: { jobNumber: string; weekOfMonday: string; recordId: string; days: WeekEntry['days']; includePerDiem: boolean } | null }
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
