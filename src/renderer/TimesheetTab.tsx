import { useEffect, useMemo, useRef, useState } from 'react';
import type { Booking, BookingContactsCache, SswDay, SswWeek } from '../shared/types';
import { friendlyError } from '../shared/errors';
import WeekPicker from './WeekPicker';

type Props = {
  bookings: Booking[];
  contacts: BookingContactsCache;
  weekMonday: string;
  onWeekChange: (mondayISO: string) => void;
  week: SswWeek | null;
  loading: boolean;
  error: string | null;
  onLocalEdit: (next: SswWeek) => void;
  onReload: () => void | Promise<void>;
  defaultStartTime: string;
  defaultEndTime: string;
  autofillPerDiem: boolean;
  // Settings override for the address submitted on the sheet; '' = whatever
  // SSW has stored. Shown in the identity panel so what you see is what saves.
  timesheetEmail: string;
  onOpenSettings: () => void;
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// Default times are user-configurable via the Settings modal. The component
// receives current values as props (`defaultStartTime` / `defaultEndTime`).

// Resolve a job number to a *suggested* per-diem rate, in order of preference:
//   1. GSA federal M&IE rate (looked up by venue zip during the CARL sweep)
//   2. CARL's stored per-diem (field_348 on the booking)
//   3. 0 — unknown. The UI shows an empty editable input; user types.
function perDiemForJob(
  jobNumber: string,
  bookings: Booking[],
  contacts: BookingContactsCache,
): number {
  if (!jobNumber) return 0;
  const matches = bookings.filter((b) => b.jobNumber === jobNumber);
  for (const b of matches) {
    const c = contacts[b.bookingId];
    if (typeof c?.gsaPerDiem === 'number' && c.gsaPerDiem > 0) return c.gsaPerDiem;
  }
  for (const b of matches) {
    const c = contacts[b.bookingId];
    if (typeof c?.perDiem === 'number' && c.perDiem > 0) return c.perDiem;
  }
  return 0;
}

function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfToday(): Date {
  const t = new Date(); t.setHours(0, 0, 0, 0); return t;
}

function isPastOrToday(iso: string): boolean {
  return parseISO(iso) <= startOfToday();
}

function isToday(iso: string): boolean {
  return parseISO(iso).getTime() === startOfToday().getTime();
}

function bookingsCoveringDate(bookings: Booking[], iso: string): Booking[] {
  const t = parseISO(iso).getTime();
  return bookings.filter((b) =>
    parseISO(b.startDate).getTime() <= t && t <= parseISO(b.endDate).getTime(),
  );
}

// v1-style autofill: when a day has no times set yet AND a booking covers it,
// drop in 8a–6p (blank end if today), per-diem, and the booking's job.
// Days that already have ANY time data are left untouched — the user's edits
// always win.
function applyAutofill(
  week: SswWeek,
  bookings: Booking[],
  contacts: BookingContactsCache,
  defaultStart: string,
  defaultEnd: string,
  autofillPerDiem: boolean,
): SswWeek {
  let anyChanged = false;
  const today = startOfToday().getTime();
  const days = week.days.map((d) => {
    // Future days: show the scheduled show number in the dropdown so the user
    // can see what's coming up, but leave times/per-diem blank. The save path
    // (buildInputs in ssw.ts) still blanks these days entirely — the show
    // number is purely a UI preview of the upcoming schedule.
    if (parseISO(d.date).getTime() > today) {
      if (!d.job) {
        const covering = bookingsCoveringDate(bookings, d.date);
        if (covering.length > 0) {
          const booking = covering.sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
          anyChanged = true;
          return { ...d, job: booking.jobNumber };
        }
      }
      return d;
    }
    let next = d;
    // Phase 1: fill the day's times + job from a covering booking when the
    // user hasn't touched it yet.
    const hasTimes = !!(next.startTime || next.endTime);
    if (!hasTimes) {
      const covering = bookingsCoveringDate(bookings, next.date);
      if (covering.length > 0) {
        const booking = covering.sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
        next = {
          ...next,
          job: next.job || booking.jobNumber,
          startTime: defaultStart,
          endTime: isToday(next.date) ? '' : defaultEnd,
        };
      }
    }
    // Phase 2: fill the per-diem amount whenever a job is set and the field
    // is still empty. Runs even on days the user has worked, so swapping the
    // show on a saved day still picks up the new rate. User-typed amounts
    // (any non-zero value) are preserved. Skipped entirely when the user has
    // disabled GSA autofill in Settings.
    if (autofillPerDiem && next.job && !next.perDiem) {
      const suggested = perDiemForJob(next.job, bookings, contacts);
      if (suggested > 0) next = { ...next, perDiem: suggested };
    }
    if (next !== d) anyChanged = true;
    return next;
  });
  // Sync the week-level identity (position, PM, LC) to whichever show is
  // primary — i.e. the first past/today day with a job set. SSW only stores
  // one PM/LC/position per week, and they're inherited from the prior saved
  // week by default, so without this sync the UI shows stale fields from
  // last week's show even after the user has switched to a new one.
  const primaryJob = days.find((d) => !!d.job && parseISO(d.date).getTime() <= today)?.job;
  let position = week.position;
  let projectManager = week.projectManager;
  let laborCoordinator = week.laborCoordinator;
  if (primaryJob) {
    const b = bookings.find((bk) => bk.jobNumber === primaryJob);
    if (b) {
      if (b.position && b.position !== position) { position = b.position; anyChanged = true; }
      if (b.projectManager && b.projectManager !== projectManager) { projectManager = b.projectManager; anyChanged = true; }
      if (b.laborCoordinator && b.laborCoordinator !== laborCoordinator) { laborCoordinator = b.laborCoordinator; anyChanged = true; }
    }
  }
  // Return the SAME reference when nothing changed — that lets the calling
  // effect skip the update without needing a separate dedup key (which got
  // stale when navigating between weeks).
  return anyChanged ? { ...week, position, projectManager, laborCoordinator, days } : week;
}

// Normalize loose user input ("6", "6:30", "18", "6p") into the canonical
// "h:mm am/pm" shape that SSW expects. `defaultMeridiem` decides am/pm when
// the user types just a bare number — 'am' for start, 'pm' for end/lunch.
// Returns the raw string untouched when the input doesn't look like a time,
// so the user sees their typo instead of silent corruption.
function normalizeTime(raw: string, defaultMeridiem: 'am' | 'pm'): string {
  const t = raw.trim().toLowerCase();
  if (!t) return '';
  const m = t.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm|a|p)?$/);
  if (!m) return raw;
  let h = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  let mer: 'am' | 'pm' = m[3] ? (m[3][0] === 'a' ? 'am' : 'pm') : defaultMeridiem;
  if (mins > 59) return raw;
  // 24-hour input: "18" → 6 pm. "00" → 12 am.
  if (h >= 13 && h <= 23) { h -= 12; mer = 'pm'; }
  else if (h === 0) { h = 12; mer = 'am'; }
  else if (h > 23) return raw;
  return `${h}:${String(mins).padStart(2, '0')} ${mer}`;
}

// "8:00 am" / "12:30 pm" → minutes from midnight, or null if unparseable.
function parseTime(t: string): number | null {
  const m = t.match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

// Worked hours = end - start - lunch. Returns 0 when start or end is blank.
function workedHours(d: SswDay): number {
  const start = parseTime(d.startTime);
  const end = parseTime(d.endTime);
  if (start == null || end == null) return 0;
  let mins = end - start;
  if (mins < 0) mins += 24 * 60; // crossed midnight
  const lunchStart = parseTime(d.lunchStart);
  const lunchEnd = parseTime(d.lunchEnd);
  if (lunchStart != null && lunchEnd != null) {
    mins -= Math.max(0, lunchEnd - lunchStart);
  }
  return Math.max(0, mins / 60);
}

// CT business rule: worked days are paid at a 10-hour minimum (8 reg + 2 OT),
// OT continues up to 12, anything over 12 is double time. Non-worked days
// stay at zero.
function ctSplit(d: SswDay): { reg: number; ot: number; dt: number; total: number } {
  const raw = workedHours(d);
  if (raw === 0) return { reg: 0, ot: 0, dt: 0, total: 0 };
  const paid = Math.max(10, raw);
  const reg = Math.min(8, paid);
  const ot = Math.min(4, Math.max(0, paid - 8));
  const dt = Math.max(0, paid - 12);
  return { reg, ot, dt, total: reg + ot + dt };
}

function weekTotals(days: SswDay[]) {
  return days.reduce(
    (acc, d) => {
      const s = ctSplit(d);
      return {
        reg: acc.reg + s.reg,
        ot: acc.ot + s.ot,
        dt: acc.dt + s.dt,
        total: acc.total + s.total,
      };
    },
    { reg: 0, ot: 0, dt: 0, total: 0 },
  );
}

export default function TimesheetTab({
  bookings, contacts, weekMonday, onWeekChange, week, loading, error, onLocalEdit, onReload,
  defaultStartTime, defaultEndTime, autofillPerDiem, timesheetEmail, onOpenSettings,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run autofill whenever the week or its data sources change. applyAutofill
  // returns the SAME reference when nothing needs filling, so onLocalEdit is
  // only triggered when there's actual new data to apply — no infinite loop
  // and no stale dedup-key bug when navigating between weeks.
  useEffect(() => {
    if (!week) return;
    const filled = applyAutofill(week, bookings, contacts, defaultStartTime, defaultEndTime, autofillPerDiem);
    if (filled !== week) onLocalEdit(filled);
  }, [week, bookings, contacts, defaultStartTime, defaultEndTime, autofillPerDiem, onLocalEdit]);

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const updateDay = (idx: number, patch: Partial<SswDay>) => {
    if (!week) return;
    const days = [...week.days];
    days[idx] = { ...days[idx], ...patch };
    onLocalEdit({ ...week, days });
  };

  const handleSave = async () => {
    if (!week) return;
    setSaving(true);
    setSaveError(null);
    const result = await window.api.ssw.pushWeek(week);
    setSaving(false);
    if (result.ok) {
      setSavedFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 3000);
      // Re-pull from server so we see SSW's recomputed totals.
      onReload();
    } else {
      setSaveError(friendlyError(result.error, !navigator.onLine));
    }
  };

  const totals = useMemo(() => week ? weekTotals(week.days) : null, [week]);
  const isLocked = (week?.statusIndex ?? 0) > 0;

  // The 3 most recently-ended past bookings, so the user can charge time to a
  // show that wrapped a few days ago (cleanup, post-show paperwork, etc.).
  const recentPast = useMemo(() => {
    const today = startOfToday();
    return bookings
      .filter((b) => parseISO(b.endDate) < today)
      .sort((a, b) => b.endDate.localeCompare(a.endDate))
      .slice(0, 3);
  }, [bookings]);

  // All upcoming bookings (start date in the future) — prep, paperwork, and
  // travel days can be charged before the show technically begins.
  const upcoming = useMemo(() => {
    const today = startOfToday();
    return bookings
      .filter((b) => parseISO(b.startDate) > today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
  }, [bookings]);

  return (
    <>
      <div className="card">
        <div className="row-actions">
          <WeekPicker value={weekMonday} onChange={onWeekChange} />
          <button
            className="primary"
            onClick={handleSave}
            disabled={!week || saving || loading || isLocked}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedFlash && <span className="save-flash">Saved!</span>}
        </div>
        {isLocked && (
          <div className="banner" style={{ marginTop: 8 }}>
            This week has been submitted and editing is disabled. Contact your Labor Coordinator to unlock.
          </div>
        )}
        {(error || saveError) && (
          <div className="banner error" style={{ marginTop: 8 }}>{error || saveError}</div>
        )}
      </div>

      {loading && (
        <div className="card">
          <p className="subtle">Loading week from SSW…</p>
        </div>
      )}

      {!loading && !week && !error && (
        <CreateWeekCard
          weekMonday={weekMonday}
          bookings={bookings}
          onCreated={() => onReload()}
        />
      )}

      {week && (
        <div className="card">
          <div className="week-grid">
            {week.days.map((d, i) => (
              <DayRow
                key={d.date}
                day={d}
                label={DAY_LABELS[i]}
                bookingsForDay={bookingsCoveringDate(bookings, d.date)}
                recentPast={recentPast}
                upcoming={upcoming}
                locked={isLocked}
                autofillPerDiem={autofillPerDiem}
                getPerDiem={(job) => perDiemForJob(job, bookings, contacts)}
                onChange={(patch) => updateDay(i, patch)}
              />
            ))}
          </div>

          {totals && (
            <div className="week-totals">
              <span className="subtle">Week totals:</span>
              <span><b>{totals.reg.toFixed(2)}</b> reg</span>
              <span><b>{totals.ot.toFixed(2)}</b> OT</span>
              <span><b>{totals.dt.toFixed(2)}</b> DT</span>
              <span><b>{totals.total.toFixed(2)}</b> total</span>
            </div>
          )}

          <IdentityPanel week={week} timesheetEmail={timesheetEmail} />
        </div>
      )}

      {week && (
        <>
          <p className="timesheet-note subtle">
            Future days aren't saved to C.A.R.L. Default daily hours (currently {defaultStartTime} – {defaultEndTime}) can be changed in{' '}
            <button className="link" onClick={onOpenSettings} style={{ padding: 0, fontSize: 'inherit' }}>settings</button>.
            {autofillPerDiem && <> Per diem defaulted to GSA rates.</>}
          </p>
          <p className="timesheet-note subtle">
            As a beta safety feature, AUTOcarl only saves your timesheet — you must still submit it on the SSW portal.
          </p>
        </>
      )}
    </>
  );
}

function CreateWeekCard({ weekMonday, bookings, onCreated }: {
  weekMonday: string; bookings: Booking[]; onCreated: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const friendlyDate = useMemo(() => {
    const d = parseISO(weekMonday);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  }, [weekMonday]);

  // A timesheet needs work to bill: without a single booking touching this
  // Mon–Sun, creating one is denied outright.
  const weekSunday = useMemo(() => {
    const d = parseISO(weekMonday);
    d.setDate(d.getDate() + 6);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [weekMonday]);
  const weekHasBookings = bookings.some((b) => b.startDate <= weekSunday && b.endDate >= weekMonday);

  const handleCreate = async () => {
    setCreating(true);
    setErr(null);
    try {
      const created = await window.api.ssw.createWeek(weekMonday);
      if (!created) throw new Error('SSW did not return a record for the new week.');
      onCreated();
    } catch (e) {
      setErr(friendlyError(e, !navigator.onLine));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="card">
      <h3>No timesheet for this week yet</h3>
      <p className="subtle" style={{ marginTop: 0 }}>
        SSW doesn't have a record for the week of <b>{friendlyDate}</b>. Create one now —
        we'll copy your identity info (name, email, position, rate, group) from your
        most recent timesheet, and the app will autofill the days from your CARL bookings.
      </p>
      {err && <div className="banner error" style={{ marginTop: 8 }}>{err}</div>}
      {weekHasBookings ? (
        <button
          className="primary"
          onClick={handleCreate}
          disabled={creating}
          style={{ marginTop: 10 }}
        >
          {creating ? 'Creating…' : 'Create timesheet for this week'}
        </button>
      ) : (
        <div className="banner error" style={{ marginTop: 10 }}>
          You have no Bookings for these days.
        </div>
      )}
    </div>
  );
}

type DayRowProps = {
  day: SswDay;
  label: string;
  bookingsForDay: Booking[];
  recentPast: Booking[];
  upcoming: Booking[];
  locked: boolean;
  autofillPerDiem: boolean;
  getPerDiem: (jobNumber: string) => number;
  onChange: (patch: Partial<SswDay>) => void;
};

function DayRow({ day, label, bookingsForDay, recentPast, upcoming, locked, autofillPerDiem, getPerDiem, onChange }: DayRowProps) {
  const past = isPastOrToday(day.date);
  const worked = !!(day.startTime || day.endTime);
  const today = parseISO(day.date).getTime() === startOfToday().getTime();

  // Options: shows covering this day first, then upcoming shows (prep time),
  // then the 3 most-recently-wrapped past shows (cleanup/paperwork), then the
  // currently-selected job if it isn't already in the list.
  const showOptions = useMemo(() => {
    const opts = new Map<string, string>();
    for (const b of bookingsForDay) opts.set(b.jobNumber, `${b.jobNumber} — ${b.jobName}`);
    for (const b of upcoming) {
      if (!opts.has(b.jobNumber)) opts.set(b.jobNumber, `${b.jobNumber} — ${b.jobName}`);
    }
    for (const b of recentPast) {
      if (!opts.has(b.jobNumber)) opts.set(b.jobNumber, `${b.jobNumber} — ${b.jobName}`);
    }
    if (day.job && !opts.has(day.job)) opts.set(day.job, day.job);
    return Array.from(opts.entries());
  }, [bookingsForDay, recentPast, upcoming, day.job]);

  return (
    <div className={`day-row ${past ? '' : 'day-row-future'} ${worked ? 'day-row-worked' : ''} ${today ? 'day-row-today' : ''}`}>
      <div className="day-label">
        <div className="day-name">{label}</div>
        <div className="day-date subtle">{day.date.slice(5).replace('-', '/')}</div>
      </div>

      <select
        className="day-show"
        value={day.job}
        onChange={(e) => {
          const job = e.target.value;
          // Switching shows also switches the per-diem rate — pull the new
          // job's suggested rate (GSA → CARL → 0) and replace whatever was
          // there. If the new job is unknown ('— no work —'), zero it out.
          // When the user has disabled GSA autofill, clear the per-diem so
          // they explicitly type the rate they want for the new show.
          const rate = autofillPerDiem && job ? getPerDiem(job) : 0;
          onChange({ job, perDiem: rate });
        }}
        disabled={locked}
      >
        <option value="">— no work —</option>
        {showOptions.map(([num, name]) => (
          <option key={num} value={num}>{name}</option>
        ))}
      </select>

      <TimeInput placeholder="start" value={day.startTime} defaultMeridiem="am" locked={locked}
                 onCommit={(v) => onChange({ startTime: v })} />
      <TimeInput placeholder="lunch in" value={day.lunchStart} defaultMeridiem="pm" locked={locked}
                 onCommit={(v) => onChange({ lunchStart: v })} />
      <TimeInput placeholder="lunch out" value={day.lunchEnd} defaultMeridiem="pm" locked={locked}
                 onCommit={(v) => onChange({ lunchEnd: v })} />
      <TimeInput placeholder="end" value={day.endTime} defaultMeridiem="pm" locked={locked}
                 onCommit={(v) => onChange({ endTime: v })} />

      <div className="day-perdiem">
        <span className="day-perdiem-label">P/D $</span>
        <input
          className="day-perdiem-input"
          type="number"
          inputMode="decimal"
          min="0"
          step="1"
          value={day.perDiem || ''}
          placeholder={(() => {
            if (!autofillPerDiem) return '';
            const s = getPerDiem(day.job);
            return s > 0 ? String(s) : '';
          })()}
          onChange={(e) => onChange({ perDiem: parseFloat(e.target.value) || 0 })}
          disabled={locked}
          title={(() => {
            if (!autofillPerDiem) return 'GSA autofill disabled — type to claim';
            const s = getPerDiem(day.job);
            return s > 0 ? `Suggested: $${s} (federal GSA rate)` : 'No suggested rate — type to claim';
          })()}
        />
      </div>

      <div className="day-hours subtle">
        {(() => {
          const s = ctSplit(day);
          if (s.total === 0) return <span style={{ opacity: 0.5 }}>—</span>;
          return <>{s.reg.toFixed(1)} reg · {s.ot.toFixed(1)} OT · {s.dt.toFixed(1)} DT</>;
        })()}
      </div>
    </div>
  );
}

// Read-only display of the per-user identity fields that AUTOcarl pulls from
// SSW and submits verbatim on every save. Surfaces these so the user can see
// exactly what's being attached to their timesheet (and notice if anything is
// stale on the server side).
function IdentityPanel({ week, timesheetEmail }: { week: SswWeek; timesheetEmail: string }) {
  const rateNum = parseFloat(week.dailyRate);
  const rateDisplay = Number.isFinite(rateNum) && rateNum > 0
    ? `$${rateNum.toFixed(2)} / day`
    : '';
  const rows: Array<[string, string]> = [
    ['Name', week.name],
    // The override wins on save, so show it here rather than SSW's stale copy.
    ['Email', timesheetEmail || week.email],
    ['Phone', week.phone],
    ['Position', week.position],
    ['Daily Rate', rateDisplay],
    ['Project Manager', week.projectManager],
    ['Labor Coordinator', week.laborCoordinator],
    ['User ID', week.userId],
  ].filter(([, v]) => v && String(v).trim() !== '') as Array<[string, string]>;
  if (rows.length === 0) return null;
  return (
    <div className="identity-panel subtle">
      <div className="identity-panel-title">Submitted with this timesheet</div>
      <div className="identity-panel-grid">
        {rows.map(([k, v]) => (
          <div className="identity-row" key={k}>
            <span className="identity-key">{k}</span>
            <span className="identity-val">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Time field that lets the user type loose input ("6", "6:30", "18p") and
// normalizes it to "h:mm am/pm" on blur or Enter. Holds a local draft string
// while the user is typing so the parent doesn't see in-flight characters.
function TimeInput({ value, placeholder, defaultMeridiem, locked, onCommit }: {
  value: string;
  placeholder: string;
  defaultMeridiem: 'am' | 'pm';
  locked: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => {
    const normalized = normalizeTime(draft, defaultMeridiem);
    if (normalized !== draft) setDraft(normalized);
    if (normalized !== value) onCommit(normalized);
  };
  return (
    <input
      className="day-time"
      type="text"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      disabled={locked}
    />
  );
}
