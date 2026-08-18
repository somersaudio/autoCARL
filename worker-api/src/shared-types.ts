// Local copy of the shared types the worker needs, copied verbatim from
// src/shared/types.ts (and CarlBookingDetails from src/main/carl-api.ts) so
// worker-api never imports across the repo boundary. Keep in sync by hand.

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

// Copied from src/main/carl-api.ts — the raw per-booking scrape result the
// carl port produces before it's distilled into BookingContacts.
export type CarlBookingDetails = {
  flights: Array<{
    pdfUrl: string;
    vendor?: string;
    confirmation?: string;
    bookedBy?: string;
    status?: string;
  }>;
  // CARL's API returns each contact (PM, LC, etc.) as a single-item XHR with
  // a `name` field. We collect them all here and let the caller disambiguate
  // by matching against booking.projectManager / booking.laborCoordinator.
  emailsByName: Record<string, string>;
  perDiem?: number;
  venue?: string;
  venueAddress?: string;
  venueZip?: string;
  // CARL's "laborTravel" status (field_254), e.g. "Flight Requests Open to
  // Crew" or "Travel Details Pending". Only present when the LC has set one —
  // the field definition ships as an object on every booking, but the VALUE is
  // a string only on bookings where it's populated, which is what asString
  // keys on.
  laborTravel?: string;
  // The "Booking Notes" text block from the booking page — LC instructions,
  // schedule details, etc. Plain text after entity decoding.
  bookingNotes?: string;
};
