import { useEffect, useMemo, useRef, useState } from 'react';
import type { Booking, BookingContactsCache, SswDay, SswWeek, UserSettings } from '../shared/types';
import { friendlyError } from '../shared/errors';
import { splitWeek } from '../shared/hours';
import type { HoursSplit } from '../shared/hours';
import { cleanTimesheetEmail, cleanTimesheetPhone } from '../shared/contact';
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
  // Base pay (the rate every save writes unless it's edited in that save) and
  // the email and phone overrides ('' = whatever SSW has stored), shown in the
  // identity panel so what you see is what saves.
  settings: Pick<UserSettings, 'basePayDayRate' | 'defaultDailyRate' | 'timesheetEmail' | 'timesheetPhone'>;
  // Sets or clears the email or phone override; resolves with the settings as
  // stored, so the panel can confirm the change took.
  onSetContact: (patch: Partial<Pick<UserSettings, 'timesheetEmail' | 'timesheetPhone'>>) => Promise<UserSettings>;
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
  // primary. SSW only stores one PM/LC/position per week, and a new week
  // inherits them from the previous timesheet, so without this sync the UI
  // shows last week's people even though this week is a different show.
  // The primary show is the first worked (past or today) day with a job. A
  // week created ahead of its gig has only upcoming days, so it falls back to
  // the first upcoming day's show; otherwise a brand-new week kept the old
  // PM and LC on screen until one of its days had passed.
  const primaryJob = days.find((d) => !!d.job && parseISO(d.date).getTime() <= today)?.job
    ?? days.find((d) => !!d.job)?.job;
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

function weekTotals(splits: HoursSplit[]) {
  return splits.reduce<HoursSplit & { total: number }>(
    (acc, s) => ({
      reg: acc.reg + s.reg,
      ot: acc.ot + s.ot,
      dt: acc.dt + s.dt,
      total: acc.total + s.reg + s.ot + s.dt,
    }),
    { reg: 0, ot: 0, dt: 0, total: 0 },
  );
}

// The phone and email a save copies onto a week SSW holds blank.
type RecentContact = { phone: string; email: string };

export default function TimesheetTab({
  bookings, contacts, weekMonday, onWeekChange, week, loading, error, onLocalEdit, onReload,
  defaultStartTime, defaultEndTime, autofillPerDiem, settings, onSetContact, onOpenSettings,
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
      // The save may have put a phone or email on a newer timesheet.
      forgetRecent();
      setSavedFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 3000);
      // Re-pull from server so we see SSW's recomputed totals.
      onReload();
    } else {
      setSaveError(friendlyError(result.error, !navigator.onLine));
    }
  };

  // Each day's reg/OT/DT as payroll splits the week, the same numbers a save
  // writes. A day's split depends on the days before it: once the week holds
  // 40 regular hours, the next day worked is all overtime.
  const daySplits = useMemo<HoursSplit[]>(
    () => (week ? splitWeek(week.days).map((d) => ({ reg: d.regHours, ot: d.otHours, dt: d.dtHours })) : []),
    [week],
  );
  const totals = useMemo(() => week ? weekTotals(daySplits) : null, [week, daySplits]);
  const isLocked = (week?.statusIndex ?? 0) > 0;
  // The rate a save writes unless it's edited in that save: base pay, with the
  // legacy General field winning if an old profile carries one (saveDailyRate).
  const configuredRate = settings.defaultDailyRate > 0 ? settings.defaultDailyRate : settings.basePayDayRate;

  // A week SSW holds with no phone or email, and no override to cover it, gets
  // them from the user's earlier timesheets on save. Look those up so the
  // panel can show what will go in. The lookup walks SSW records, so it runs
  // only when a week needs it and only once the live week has loaded: that
  // copy may already have both, and on desktop two requests meeting an
  // expired SSW session would each log in again. It lives with the tab, so
  // logging out drops it, and a save or a new week (either can change what
  // the newest timesheets hold) forgets it.
  const needsRecent = !!week && !isLocked && (
    (!settings.timesheetPhone && !(week.phone || '').trim())
    || (!settings.timesheetEmail && !(week.email || '').trim()));
  const [recent, setRecent] = useState<RecentContact | 'failed' | 'pending' | null>(null);
  const recentAsk = useRef(0);
  const forgetRecent = () => { recentAsk.current += 1; setRecent(null); };
  useEffect(() => {
    if (!needsRecent || loading || recent) return;
    const ask = ++recentAsk.current;
    setRecent('pending');
    window.api.ssw.recentContact()
      .then((r) => { if (ask === recentAsk.current) setRecent(r); })
      .catch(() => { if (ask === recentAsk.current) setRecent('failed'); });
  }, [needsRecent, loading, recent]);

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
          onCreated={() => { forgetRecent(); onReload(); }}
        />
      )}

      {week && (
        <div className="card">
          <div className="week-grid">
            {week.days.map((d, i) => (
              <DayRow
                key={d.date}
                day={d}
                hours={daySplits[i]}
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

          <IdentityPanel
            key={week.weekStartDate}
            week={week}
            locked={isLocked}
            configuredRate={configuredRate}
            overrides={{ phone: settings.timesheetPhone, email: settings.timesheetEmail }}
            recent={recent === 'pending' ? 'loading' : recent ?? (needsRecent ? 'loading' : null)}
            onRateChange={(rate) => { if (week) onLocalEdit({ ...week, dailyRate: rate, dailyRateEdited: true }); }}
            onSetContact={onSetContact}
          />
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
        we'll copy your name, position and group from your most recent timesheet, put on the
        email and phone from your settings (or else that timesheet's, or your newest one that
        has them), start the Daily Rate at your base pay (or that timesheet's rate if base pay
        isn't set), and the app will autofill the days from your CARL bookings.
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
  hours: HoursSplit;
  label: string;
  bookingsForDay: Booking[];
  recentPast: Booking[];
  upcoming: Booking[];
  locked: boolean;
  autofillPerDiem: boolean;
  getPerDiem: (jobNumber: string) => number;
  onChange: (patch: Partial<SswDay>) => void;
};

function DayRow({ day, hours, label, bookingsForDay, recentPast, upcoming, locked, autofillPerDiem, getPerDiem, onChange }: DayRowProps) {
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
        {hours.reg + hours.ot + hours.dt === 0
          ? <span style={{ opacity: 0.5 }}>—</span>
          : <>{hours.reg.toFixed(1)} reg · {hours.ot.toFixed(1)} OT · {hours.dt.toFixed(1)} DT</>}
      </div>
    </div>
  );
}

// Per-user identity fields AUTOcarl pulls from SSW and submits on every save,
// so the user can see exactly what's attached to their timesheet. Email, Phone
// and Daily Rate can be tapped and changed, and each shows what a save will
// write (a submitted week shows what was submitted):
//  - Email and Phone: the Settings override, else the week's own, else the
//    newest earlier timesheet's, which a save copies onto a blank week. A
//    change here sets the override, so every later save uses it.
//  - Daily Rate: an edit in progress, else base pay. An edit applies to that
//    save only. Each day's hourly is the rate / 11, the way SSW's Copy button
//    fans it out.
type RecentState = RecentContact | 'failed' | 'loading' | null;
type ContactKind = 'email' | 'phone';
type ContactOnSave = { value: string; source: 'override' | 'week' | 'earlier' | 'none'; stored: string };

const CONTACT_KINDS: ContactKind[] = ['email', 'phone'];
const CONTACT_LABEL: Record<ContactKind, string> = { email: 'Email', phone: 'Phone' };
const CONTACT_NOUN: Record<ContactKind, string> = { email: 'email', phone: 'phone number' };

function contactOnSave(
  kind: ContactKind, week: SswWeek, locked: boolean, override: string, recent: RecentState,
): ContactOnSave {
  const stored = String(week[kind] || '').trim();
  if (locked) return { value: stored, source: stored ? 'week' : 'none', stored };
  if (override) return { value: override, source: 'override', stored };
  if (stored) return { value: stored, source: 'week', stored };
  const earlier = recent && typeof recent === 'object' ? String(recent[kind] || '').trim() : '';
  return { value: earlier, source: earlier ? 'earlier' : 'none', stored };
}

function IdentityPanel({ week, locked, configuredRate, overrides, recent, onRateChange, onSetContact }: {
  week: SswWeek; locked: boolean; configuredRate: number;
  overrides: Record<ContactKind, string>;
  recent: RecentState;
  onRateChange: (rate: string) => void;
  onSetContact: (patch: Partial<Pick<UserSettings, 'timesheetEmail' | 'timesheetPhone'>>) => Promise<UserSettings>;
}) {
  // What the last Email or Phone change here did, for the line under the panel.
  // It shows only while that override still holds what was set here, so a
  // change made in Settings retires it.
  const [notice, setNotice] = useState<{ kind: ContactKind; value: string; what: 'set' | 'cleared' | 'kept' } | null>(null);
  const rows = (pairs: Array<[string, string]>) => pairs
    .filter(([, v]) => v && String(v).trim() !== '')
    .map(([k, v]) => (
      <div className="identity-row" key={k}>
        <span className="identity-key">{k}</span>
        <span className="identity-val">{v}</span>
      </div>
    ));
  const contact: Record<ContactKind, ContactOnSave> = {
    email: contactOnSave('email', week, locked, overrides.email, recent),
    phone: contactOnSave('phone', week, locked, overrides.phone, recent),
  };
  const lookingUp = recent === 'loading';
  const setContact = async (kind: ContactKind, value: string): Promise<boolean> => {
    // Clearing a value that isn't an override has nothing to remove, and a save
    // never blanks what SSW has: say so rather than quietly putting it back.
    if (!value && !overrides[kind]) {
      setNotice({ kind, value, what: 'kept' });
      return true;
    }
    try {
      const next = await onSetContact(kind === 'phone' ? { timesheetPhone: value } : { timesheetEmail: value });
      if ((kind === 'phone' ? next.timesheetPhone : next.timesheetEmail) !== value) return false;
      setNotice({ kind, value, what: value ? 'set' : 'cleared' });
      return true;
    } catch {
      return false;
    }
  };
  const shown = notice && overrides[notice.kind] === notice.value ? notice : null;
  const stored = parseFloat(week.dailyRate);
  const storedOk = Number.isFinite(stored) && stored > 0;
  const saveRate = locked ? (storedOk ? stored : 0)
    : week.dailyRateEdited && storedOk ? stored
      : configuredRate > 0 ? configuredRate
        : storedOk ? stored : 0;
  const hourly = saveRate > 0 ? saveRate / 11 : 0;
  const differs = !locked && !week.dailyRateEdited && storedOk && configuredRate > 0
    && Math.abs(stored - configuredRate) >= 0.005;
  // Where the email and phone come from, for a week that can still be saved.
  const overridden = locked ? [] : CONTACT_KINDS.filter((k) => contact[k].source === 'override'
    && contact[k].stored !== '' && contact[k].stored !== contact[k].value
    && !(shown && shown.what === 'set' && shown.kind === k));
  const fromEarlier = locked ? [] : CONTACT_KINDS.filter((k) => contact[k].source === 'earlier');
  const missing = locked || lookingUp ? [] : CONTACT_KINDS.filter((k) => contact[k].source === 'none');
  const nouns = (kinds: ContactKind[]) => kinds.map((k) => CONTACT_NOUN[k]).join(' or ');
  return (
    <div className="identity-panel subtle">
      <div className="identity-panel-title">Submitted with this timesheet</div>
      <div className="identity-panel-grid">
        {rows([['Name', week.name]])}
        {CONTACT_KINDS.map((k) => (
          <div className="identity-row" key={k}>
            <span className="identity-key">{CONTACT_LABEL[k]}</span>
            <span className="identity-val">
              <ContactField
                kind={k}
                value={contact[k].value}
                lookingUp={lookingUp && contact[k].source === 'none'}
                locked={locked}
                onCommit={(value) => setContact(k, value)}
              />
            </span>
          </div>
        ))}
        {rows([['Position', week.position]])}
        <div className="identity-row">
          <span className="identity-key">Daily Rate</span>
          <span className="identity-val"><RateField key={`${week.recordId}-${week.weekStartDate}`} rate={saveRate} locked={locked} onChange={onRateChange} /></span>
        </div>
        {rows([
          ['Project Manager', week.projectManager],
          ['Labor Coordinator', week.laborCoordinator],
          ['User ID', week.userId],
        ])}
      </div>
      {shown && (
        <div className="rate-hint">
          {shown.what === 'set'
            ? `Saved to your settings. Every timesheet you save from now on uses this ${CONTACT_NOUN[shown.kind]}.`
            : shown.what === 'cleared'
              ? `Took the ${CONTACT_NOUN[shown.kind]} out of your settings. Each save now uses the one SSW has on that week, or your newest timesheet that has one.`
              : `A save can't take the ${CONTACT_NOUN[shown.kind]} off your timesheet, so it stays. Type a different one to replace it.`}
        </div>
      )}
      {week.dailyRateEdited && hourly > 0 && (
        <div className="rate-hint">
          Tap Save to put ${saveRate.toFixed(2)} / day on this week (${hourly.toFixed(2)} an hour).
          It applies to this save only: saving the week again later puts your base pay back
          unless you change it again.
        </div>
      )}
      {differs && (
        <div className="rate-note">
          SSW has ${stored.toFixed(2)} on this week. Saving puts ${configuredRate.toFixed(2)}, your base pay.
          Tap the rate to save this week at a different rate.
        </div>
      )}
      {overridden.map((k) => (
        <div className="rate-note" key={`override-${k}`}>
          {`SSW has ${contact[k].stored} on this week. Saving puts ${contact[k].value}, the ${CONTACT_NOUN[k]} in your settings.`}
        </div>
      ))}
      {fromEarlier.length > 0 && (
        <div className="rate-note">
          {fromEarlier.length > 1
            ? `SSW has no ${nouns(fromEarlier)} on this week. Saving copies the ones shown from your newest timesheets that have them.`
            : `SSW has no ${nouns(fromEarlier)} on this week. Saving copies the one shown from your newest timesheet that has one.`}
        </div>
      )}
      {missing.length > 0 && (
        <div className="rate-note">
          {recent === 'failed'
            ? `SSW has no ${nouns(missing)} on this week, and your earlier timesheets couldn't be checked just now.`
            : `SSW has no ${nouns(missing)} on this week or your recent timesheets.`}
          {` Tap ${missing.map((k) => CONTACT_LABEL[k]).join(' or ')} to add ${missing.length > 1 ? 'them' : 'one'}.`}
        </div>
      )}
    </div>
  );
}

// Tap-to-edit day rate. Commits on Enter or leaving the field; Escape
// cancels. Submitted (locked) weeks show the rate but can't change it.
function RateField({ rate, locked, onChange }: {
  rate: number; locked: boolean; onChange: (rate: string) => void;
}) {
  const current = rate;
  const has = Number.isFinite(current) && current > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState(false);
  const start = () => {
    if (locked) return;
    setDraft(has ? current.toFixed(2) : '');
    setBad(false);
    setEditing(true);
  };
  const commit = () => {
    // The whole entry must be a plain amount: parseFloat alone would read
    // "65o" as 65 or ".5" as 50 cents, and send that to payroll.
    const cleaned = draft.replace(/[$,\s]/g, '');
    const n = /^\d{1,4}(\.\d{1,2})?$/.test(cleaned) ? parseFloat(cleaned) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > 5000) { setBad(true); return; }
    setEditing(false);
    const next = n.toFixed(2);
    if (!has || next !== current.toFixed(2)) onChange(next);
  };
  if (editing) {
    return (
      <span className="rate-edit">
        <span>$</span>
        <input
          className="rate-input"
          type="text"
          inputMode="decimal"
          autoFocus
          // Select the old rate so typing a new one replaces it instead of
          // appending ("650.00720").
          onFocus={(e) => e.currentTarget.select()}
          value={draft}
          aria-label="Daily rate"
          onChange={(e) => { setDraft(e.target.value); setBad(false); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setBad(false); setEditing(false); }
          }}
        />
        <span>/ day</span>
        {bad && <span className="rate-bad">Enter a day rate between $1 and $5,000.</span>}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`rate-value${locked ? ' is-locked' : ''}`}
      onClick={start}
      disabled={locked}
      title={locked ? 'This week is submitted' : 'Change this week’s daily rate'}
    >
      {has ? `$${current.toFixed(2)} / day` : 'Not set'}
      {!locked && <span className="rate-pencil" aria-hidden="true">✎</span>}
    </button>
  );
}

// Tap-to-edit email or phone. A change sets the Settings override, so every
// later save uses it; clearing the field removes the override. Commits on
// Enter or leaving the field; Escape cancels. Submitted weeks can't change.
function ContactField({ kind, value, lookingUp, locked, onCommit }: {
  kind: ContactKind; value: string; lookingUp: boolean; locked: boolean;
  onCommit: (value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState('');
  const [busy, setBusy] = useState(false);
  // Set when Escape or a finished commit closes the field, so the blur that
  // removing a focused input can fire doesn't commit the draft again.
  const closing = useRef(false);
  const start = () => {
    if (locked) return;
    closing.current = false;
    setDraft(value);
    setBad('');
    setEditing(true);
  };
  const close = () => {
    closing.current = true;
    setEditing(false);
  };
  const commit = async () => {
    if (busy || closing.current) return;
    const cleaned = kind === 'phone' ? cleanTimesheetPhone(draft) : cleanTimesheetEmail(draft);
    if (cleaned === null) {
      setBad(kind === 'phone'
        ? 'Enter a phone number with 10 to 15 digits.'
        : 'Enter an email address like name@example.com.');
      return;
    }
    if (cleaned === value) { close(); return; }
    setBusy(true);
    const ok = await onCommit(cleaned);
    setBusy(false);
    if (ok) close();
    else setBad(`That ${CONTACT_NOUN[kind]} didn't save. Try again.`);
  };
  if (editing) {
    return (
      <span className="contact-edit">
        <input
          className="contact-input"
          type={kind === 'phone' ? 'tel' : 'email'}
          inputMode={kind === 'phone' ? 'tel' : 'email'}
          autoComplete={kind === 'phone' ? 'tel' : 'email'}
          autoFocus
          // Select the current value so typing a new one replaces it.
          onFocus={(e) => e.currentTarget.select()}
          value={draft}
          readOnly={busy}
          aria-label={`${CONTACT_LABEL[kind]} on your timesheets`}
          onChange={(e) => { setDraft(e.target.value); setBad(''); }}
          onBlur={() => { void commit(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            if (e.key === 'Escape') { setBad(''); close(); }
          }}
        />
        {bad && <span className="contact-bad">{bad}</span>}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`rate-value contact-value${locked ? ' is-locked' : ''}`}
      onClick={start}
      disabled={locked}
      title={locked ? 'This week is submitted' : `Change the ${CONTACT_NOUN[kind]} on your timesheets`}
    >
      <span className={`contact-text${value ? '' : ' contact-empty'}`}>
        {value || (lookingUp ? 'Looking up…' : 'Not set')}
      </span>
      {!locked && <span className="rate-pencil" aria-hidden="true">✎</span>}
    </button>
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
