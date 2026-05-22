import { useEffect, useMemo, useRef, useState } from 'react';
import { weekKey, type AppConfig, type DayHours, type ProgressEvent, type PulledShow, type SubmitResult, type WeekEntry } from '../shared/types';
import WeekPicker from './WeekPicker';
import DayShowPicker from './DayShowPicker';
import ProgressDial from './ProgressDial';

type Props = {
  config: AppConfig;
  disabled: boolean;
  onChange: () => Promise<void>;
  progress: ProgressEvent | null;
  autoStatus: string | null;
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function mondayOfWeek(d: Date): string {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Standard scheduled-day hours for auto-fill. Not user-configurable per
// product decision (2026-05-20).
const DEFAULT_START_TIME = '08:00';
const DEFAULT_END_TIME = '18:00';

function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfToday(): Date {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

function dateForDayIndex(weekMonday: string, i: number): Date {
  const monday = parseISO(weekMonday);
  const date = new Date(monday);
  date.setDate(monday.getDate() + i);
  return date;
}

// A show's date range, preferring the precise scheduled dates from the booking
// record and falling back to parsing the "MM/DD/YYYY to MM/DD/YYYY" text.
function showRange(s: PulledShow): { start: Date; end: Date } | null {
  if (s.scheduledStart && s.scheduledEnd) {
    return { start: parseISO(s.scheduledStart), end: parseISO(s.scheduledEnd) };
  }
  const m = s.dateRange.match(/(\d+)\/(\d+)\/(\d+)\s+to\s+(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return {
    start: new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])),
    end: new Date(Number(m[6]), Number(m[4]) - 1, Number(m[5])),
  };
}

// The newest show whose scheduled range covers `date` (or null). Used to
// auto-assign each day's show in a multi-show week.
function showForDate(shows: PulledShow[], date: Date): PulledShow | null {
  return shows
    .map((s) => ({ s, range: showRange(s) }))
    .filter((x): x is { s: PulledShow; range: { start: Date; end: Date } } =>
      !!x.range && x.range.start <= date && date <= x.range.end)
    .sort((a, b) => b.range.start.getTime() - a.range.start.getTime())[0]?.s ?? null;
}

// The newest show overlapping ANY day of the given week — used as the
// timesheet's "primary" show (drives PM/LC/Position, which C.A.R.L. keeps
// one-per-timesheet, plus record matching).
function primaryShowForWeek(shows: PulledShow[], weekMonday: string): PulledShow | null {
  for (let i = 0; i < 7; i++) {
    const found = showForDate(shows, dateForDayIndex(weekMonday, i));
    if (found) return found;
  }
  return null;
}

// Default times to drop into a scheduled day. Past days get a full 8a–6p.
// TODAY gets an 8a start but a BLANK end — the user hasn't clocked out yet, so
// we don't want Save pushing an unverified end time; they fill it when done.
function defaultTimesFor(date: Date): { startTime: string; endTime: string } {
  const isToday = date.getTime() === startOfToday().getTime();
  return { startTime: DEFAULT_START_TIME, endTime: isToday ? '' : DEFAULT_END_TIME };
}

// Build the 7-day grid for a week. Each day is auto-assigned the show whose
// scheduled range covers it (newest if overlap); that show drives the day's
// per-diem. Past/today scheduled days are marked `worked: true`; future
// scheduled days are preview-only (greyed, excluded from submit).
function makeScheduledDays(
  weekMonday: string,
  shows: PulledShow[],
  autoApply: boolean,
): WeekEntry['days'] {
  const today = startOfToday();
  const days: DayHours[] = [];
  for (let i = 0; i < 7; i++) {
    const date = dateForDayIndex(weekMonday, i);
    const show = autoApply ? showForDate(shows, date) : null;
    const inRange = !!show;
    const isPastOrToday = date <= today;
    const t = defaultTimesFor(date);
    days.push({
      worked: inRange && isPastOrToday,
      startTime: inRange ? t.startTime : '',
      endTime: inRange ? t.endTime : '',
      perDiem: inRange ? (show?.perDiem ?? null) : null,
      jobNumber: show?.jobNumber ?? '',
    });
  }
  return days as unknown as WeekEntry['days'];
}

// Merge schedule defaults into a SAVED week. For scheduled days with no
// saved start/end time, fill in 8a–6p + per-diem + the day's show.
//   - Past/today: mark worked:true (the user has been on the show those days)
//   - Future:     leave worked:false (preview only; UI greys these out)
// Already-filled days (the user has saved data on them) are untouched, so
// if you uncheck a previously-filled day and save, it sticks.
function mergePreviewIntoSaved(
  saved: WeekEntry['days'],
  weekMonday: string,
  shows: PulledShow[],
  autoApply: boolean,
): WeekEntry['days'] {
  const today = startOfToday();
  return saved.map((d, i) => {
    const date = dateForDayIndex(weekMonday, i);
    const show = autoApply ? showForDate(shows, date) : null;
    const inRange = !!show;
    const isPastOrToday = date <= today;
    const isUnfilled = !d.startTime && !d.endTime;

    let next = d;

    // Backfill the show on any scheduled day missing one (e.g. saved data from
    // before per-day shows existed). For a worked day, also default its
    // per-diem to the show's amount when none is set yet.
    if (inRange && !next.jobNumber) {
      next = {
        ...next,
        jobNumber: show!.jobNumber,
        perDiem: next.perDiem != null ? next.perDiem : (next.worked ? (show!.perDiem ?? null) : next.perDiem),
      };
    }

    // Fill 8a–6p + per-diem on unfilled scheduled days (today/past worked,
    // future preview-only).
    if (inRange && isUnfilled) {
      const t = defaultTimesFor(date);
      next = {
        ...next,
        worked: isPastOrToday ? true : next.worked,
        startTime: t.startTime,
        endTime: t.endTime,
        perDiem: next.perDiem ?? show?.perDiem ?? null,
        jobNumber: next.jobNumber || show?.jobNumber || '',
      };
    }

    return next;
  }) as unknown as WeekEntry['days'];
}

export default function SubmitHours({ config, disabled, onChange, progress, autoStatus }: Props) {
  // On first render, default to the currently active show (today is in its
  // date range) and the current calendar week's Monday. When two shows overlap
  // on today, pick the newest (latest start date); the user can still switch
  // to the other via the Show dropdown.
  const initial = useMemo(() => {
    const today = startOfToday();
    const active = config.pulledShows
      .map((s) => ({ s, range: showRange(s) }))
      .filter((x) => x.range && x.range.start <= today && today <= x.range.end)
      .sort((a, b) => b.range!.start.getTime() - a.range!.start.getTime())[0]?.s;
    return {
      jobNumber: active?.jobNumber || config.pulledShows[0]?.jobNumber || '',
      weekOfMonday: mondayOfWeek(new Date()),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [weekOfMonday, setWeekOfMonday] = useState(initial.weekOfMonday);
  const [jobNumber, setJobNumber] = useState(initial.jobNumber);
  const [days, setDays] = useState<WeekEntry['days']>(() =>
    makeScheduledDays(initial.weekOfMonday, config.pulledShows, config.autoApplySchedule),
  );
  const [includePerDiem, setIncludePerDiem] = useState(true);
  const [loadedFromSave, setLoadedFromSave] = useState<{ at: string; recordId: string | null } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(false);
  // Key ({job, week}) for which SSW confirmed no existing record — used to
  // show a "new timesheet" banner so the user knows this is a fresh draft.
  const [newTimesheetKey, setNewTimesheetKey] = useState<string | null>(null);
  // When the week already has a record under a DIFFERENT show. Multi-show
  // weekly timesheets aren't supported for writing yet, so we warn + block Save
  // to avoid overwriting the other show's days.
  const [weekConflict, setWeekConflict] = useState<{ key: string; jobNumber: string } | null>(null);
  // Tracks which {job, week} key is currently being loaded from SSW, so a re-fire
  // of the load effect doesn't launch a duplicate headless browser.
  const inFlightLoadKey = useRef<string | null>(null);
  // Latest onChange ref so the load effect can call it without depending on it.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // In-session cache of {job, week} → days, keyed so returning to a show/week
  // already loaded (or edited) this session skips the slow C.A.R.L. lookup and
  // preserves in-progress edits. Not persisted — cleared on app restart. The
  // disk cache (config.savedWeeks) still takes precedence for saved records.
  const sessionCacheRef = useRef<Map<string, { days: WeekEntry['days']; includePerDiem: boolean; noRecord: boolean; otherShow: string | null }>>(new Map());

  // "Loaded successfully" message — only flashed after a FRESH C.A.R.L. fetch
  // (not on instant cache/disk restores, which would be misleading). Auto-
  // dismisses ~3s later.
  const [loadedBannerVisible, setLoadedBannerVisible] = useState(false);
  const loadedBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashLoaded = () => {
    if (loadedBannerTimer.current) clearTimeout(loadedBannerTimer.current);
    setLoadedBannerVisible(true);
    loadedBannerTimer.current = setTimeout(() => setLoadedBannerVisible(false), 3000);
  };

  // The week's "primary" show — the newest show overlapping any day of the
  // selected week. C.A.R.L. keeps PM/LC/Position one-per-timesheet, so this
  // drives the header + record matching. Derived from the schedule; there's no
  // manual week-level show picker anymore (each day picks its own show).
  useEffect(() => {
    const primary = primaryShowForWeek(config.pulledShows, weekOfMonday);
    const next = primary?.jobNumber || config.pulledShows[0]?.jobNumber || '';
    if (next !== jobNumber) setJobNumber(next);
  }, [config.pulledShows, weekOfMonday, jobNumber]);

  // Load saved entry for the current {jobNumber, week}. Order of preference:
  //  1. Local cache (instant) — from AppConfig.savedWeeks
  //  2. If no cache, ask SSW for an existing record (slow, ~20s) and import it
  //  3. If neither, reset to defaults
  // Step 2 is the "I have a draft already on SSW that I want to add days to" path.
  useEffect(() => {
    if (!jobNumber) return;
    const key = weekKey(jobNumber, weekOfMonday);
    const saved = config.savedWeeks[key];

    const selectedShow = config.pulledShows.find((s) => s.jobNumber === jobNumber);

    if (saved) {
      // Backfill per-diem amounts on saved weeks created before CARL was
      // returning a per-diem amount for this show. Trigger when no day has a
      // numeric perDiem AND the show now has one to default from. Once any day
      // has been explicitly set (or toggled off after being set), the saved
      // values win.
      const anyDayHasAmount = saved.days.some(
        (d) => typeof d.perDiem === 'number' && d.perDiem > 0,
      );
      const shouldBackfill = !anyDayHasAmount && selectedShow?.perDiem != null;
      const backfilled = shouldBackfill
        ? (saved.days.map((d) => ({ ...d, perDiem: selectedShow.perDiem })) as unknown as WeekEntry['days'])
        : saved.days;
      // Overlay schedule preview on top of saved data: future scheduled days
      // with no saved values get the 8a–6p + per-diem preview.
      const days = mergePreviewIntoSaved(backfilled, weekOfMonday, config.pulledShows, config.autoApplySchedule);
      setDays(days);
      setIncludePerDiem(saved.includePerDiem);
      setLoadedFromSave({ at: saved.lastSavedAt, recordId: saved.sswRecordId });
      setNewTimesheetKey(null);
      setWeekConflict(null);
      return;
    }

    // In-session cache: if we've already loaded/edited this {job, week} this
    // session, restore it instantly — no C.A.R.L. round-trip.
    const cached = sessionCacheRef.current.get(key);
    if (cached) {
      setDays(cached.days);
      setIncludePerDiem(cached.includePerDiem);
      setLoadedFromSave(null);
      setNewTimesheetKey(cached.noRecord && !cached.otherShow ? key : null);
      setWeekConflict(cached.otherShow ? { key, jobNumber: cached.otherShow } : null);
      return;
    }

    // No cache anywhere. Reset to defaults immediately, then ask C.A.R.L. in the background.
    setDays(makeScheduledDays(weekOfMonday, config.pulledShows, config.autoApplySchedule));
    setIncludePerDiem(selectedShow?.perDiem != null);
    setLoadedFromSave(null);
    // Clear the "new timesheet" banner from a previous key; it'll be set again
    // below if SSW confirms no record for THIS key. Functional updater avoids
    // adding newTimesheetKey to the effect deps.
    setNewTimesheetKey((prev) => (prev === key ? prev : null));
    setWeekConflict((prev) => (prev && prev.key === key ? prev : null));

    if (!disabled) {
      // Skip if we're already loading this exact key — App re-renders (e.g. from
      // progress events) re-fire this effect, and we must NOT launch a second
      // headless browser for the same {job, week}.
      if (inFlightLoadKey.current === key) return;
      let cancelled = false;
      inFlightLoadKey.current = key;
      setLoadingExisting(true);
      window.api.timesheet.loadExisting(jobNumber, weekOfMonday)
        .then((r) => {
          if (cancelled || !r.ok) return;
          if (r.existing) {
            // Fresh fetch found a record — flash the "loaded" message, then
            // refresh config so the cached entry flows through this same effect.
            flashLoaded();
            onChangeRef.current();
          } else if (r.weekRecordOtherShow) {
            // A record exists for this week under another show. Warn + block Save.
            setNewTimesheetKey(null);
            setWeekConflict({ key, jobNumber: r.weekRecordOtherShow.jobNumber });
            setDays((cur) => {
              sessionCacheRef.current.set(key, {
                days: cur,
                includePerDiem: selectedShow?.perDiem != null,
                noRecord: false,
                otherShow: r.weekRecordOtherShow!.jobNumber,
              });
              return cur;
            });
          } else {
            setNewTimesheetKey(key);
            // Cache the "no record yet" result so returning here this session
            // doesn't re-run the lookup.
            setDays((cur) => {
              sessionCacheRef.current.set(key, {
                days: cur,
                includePerDiem: selectedShow?.perDiem != null,
                noRecord: true,
                otherShow: null,
              });
              return cur;
            });
          }
        })
        .finally(() => {
          if (inFlightLoadKey.current === key) inFlightLoadKey.current = null;
          if (!cancelled) setLoadingExisting(false);
        });
      return () => { cancelled = true; };
    }
  }, [jobNumber, weekOfMonday, config.savedWeeks, config.weeklyDefaults, config.pulledShows, config.autoApplySchedule, disabled]);

  const updateDay = (i: number, patch: Partial<DayHours>) => {
    setDays((prev) => {
      const next = [...prev] as WeekEntry['days'];
      next[i] = { ...next[i], ...patch };
      // Write through to the session cache so edits survive navigating away
      // and back to this {job, week} within the session.
      const key = weekKey(jobNumber, weekOfMonday);
      const existing = sessionCacheRef.current.get(key);
      sessionCacheRef.current.set(key, {
        days: next,
        includePerDiem,
        noRecord: existing?.noRecord ?? false,
        otherShow: existing?.otherShow ?? null,
      });
      return next;
    });
  };

  const fill = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      // Safety: future days never get submitted, even if state has worked:true.
      // The UI disables them but we belt-and-suspenders at the boundary.
      const today = startOfToday();
      const safeDays = days.map((d, i) => {
        const date = dateForDayIndex(weekOfMonday, i);
        return date > today ? { ...d, worked: false } : d;
      }) as unknown as WeekEntry['days'];
      const entry: WeekEntry = { jobNumber, weekOfMonday, includePerDiem, days: safeDays };
      const r = await window.api.timesheet.fill(entry);
      setResult(r);
      if (r.ok) await onChange(); // refresh config so savedWeeks updates and loadedFromSave reflects
    } finally {
      setSubmitting(false);
    }
  };

  const reloadFromSsw = async () => {
    if (!jobNumber) return;
    setLoadingExisting(true);
    setResult(null);
    try {
      const r = await window.api.timesheet.loadExisting(jobNumber, weekOfMonday);
      const key = weekKey(jobNumber, weekOfMonday);
      if (!r.ok) {
        setResult({ ok: false, error: r.error });
      } else if (r.existing) {
        flashLoaded();
        await onChange(); // brings the new cached data through the useEffect
      } else if (r.weekRecordOtherShow) {
        setWeekConflict({ key, jobNumber: r.weekRecordOtherShow.jobNumber });
        setNewTimesheetKey(null);
      } else {
        setNewTimesheetKey(key);
        setWeekConflict(null);
        setResult({ ok: false, error: 'No existing record found on C.A.R.L. for this show + week.' });
      }
    } finally {
      setLoadingExisting(false);
    }
  };

  const selectedShow = config.pulledShows.find((s) => s.jobNumber === jobNumber);
  const needsPosition = !!selectedShow && !selectedShow.position;

  // Lock-state derived from the cached SSW status of this {job, week}.
  // "Complete" = employee-submitted, awaiting labor coordinator action.
  // "Paid" = sent to payroll. Both states forbid edits from the employee.
  const currentSavedWeek = config.savedWeeks[weekKey(jobNumber, weekOfMonday)];
  const sswStatus = (currentSavedWeek?.sswStatus || '').trim();
  const timesheetLocked = /^(complete|paid)$/i.test(sswStatus);
  const lockStatusLabel = sswStatus || 'submitted';

  // This week already has a record under another show. Multi-show write isn't
  // supported yet, so block Save to avoid clobbering the other show's days.
  const hasWeekConflict = !!weekConflict && weekConflict.key === weekKey(jobNumber, weekOfMonday);

  // Show the per-diem column if any pulled show carries a per-diem amount.
  const anyPerDiemShow = config.pulledShows.some((s) => s.perDiem != null);

  return (
    <>
      {result?.ok === true && (
        <div className="banner success">
          {result.confirmationId || 'Timesheet filled — review and Save in the browser window.'}
        </div>
      )}
      {result?.ok === false && (
        <div className="banner error">
          {result.error}
          {result.screenshotPath && <div className="subtle">Screenshot: {result.screenshotPath}</div>}
        </div>
      )}

      <div className="card">

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div>
            <label>Week</label>
            <WeekPicker value={weekOfMonday} onChange={setWeekOfMonday} />
          </div>
          <div className="week-status">
            {progress ? (
              <ProgressDial percent={progress.percent} label={progress.label} size={60} />
            ) : (
              <>
                {loadingExisting && <span className="week-status-msg">Checking C.A.R.L. for an existing draft…</span>}
                {loadedFromSave && !loadingExisting && !timesheetLocked && loadedBannerVisible && (
                  <span className="week-status-msg week-status-ok banner-fade">Current Week Loaded Successfully</span>
                )}
              </>
            )}
          </div>
        </div>

        {needsPosition && (
          <div className="banner info">
            C.A.R.L. didn't return a Position for {selectedShow!.jobNumber}. Reopen the app to pull it again.
          </div>
        )}

        {timesheetLocked && !loadingExisting && (
          <div className="banner error">
            This timesheet is <strong>{lockStatusLabel}</strong> and can't be edited.
            Contact your labor coordinator to unlock it before making changes.
          </div>
        )}
        {!loadedFromSave && !loadingExisting && !hasWeekConflict && newTimesheetKey === `${jobNumber}__${weekOfMonday}` && (
          <div className="banner info">New timesheet — no existing draft on C.A.R.L. for this week. Save will create one.</div>
        )}
        {hasWeekConflict && !loadingExisting && (
          <div className="banner error">
            A timesheet for this week already exists on C.A.R.L. under show <strong>{weekConflict!.jobNumber}</strong>.
            Adding a second show to an existing weekly timesheet isn't supported yet, so Save is disabled to avoid
            overwriting the other show's days. Open the C.A.R.L. site to add this show's hours manually.
          </div>
        )}

        <table className="day-table">
          <thead>
            <tr>
              <th></th>
              <th>Work?</th>
              <th>Show</th>
              <th>Start</th>
              <th>End</th>
              {!config.hideMealBreak && <th>Meal break (start/end, optional)</th>}
              {anyPerDiemShow && <th className="pd-col">Per diem</th>}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((label, i) => {
              const d = days[i];
              const pdOn = d.perDiem != null;
              const dayDate = dateForDayIndex(weekOfMonday, i);
              const isFuture = dayDate > startOfToday();
              const isToday = dayDate.getTime() === startOfToday().getTime();
              const hasPreview = !!(d.startTime || d.endTime || d.perDiem != null);
              const locked = isFuture;
              const dayShow = config.pulledShows.find((s) => s.jobNumber === d.jobNumber);
              return (
                <tr key={label} className={isFuture ? 'is-future' : ''}>
                  <td className="day-date-cell">
                    <span className="day-date-line">
                      {isToday && <span className="today-dot" title="Today" />}
                      <strong>{dayDate.getMonth() + 1}/{dayDate.getDate()}</strong>
                    </span>
                    <span className="day-date-dow">{label}</span>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={d.worked && !isFuture}
                      disabled={locked}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        // Manually enabling a previously-blank day fills the
                        // same defaults a scheduled day gets, plus that day's show.
                        if (checked && !d.startTime) {
                          const t = defaultTimesFor(dayDate);
                          const autoShow = showForDate(config.pulledShows, dayDate);
                          updateDay(i, {
                            worked: true,
                            startTime: t.startTime,
                            endTime: t.endTime,
                            perDiem: autoShow?.perDiem ?? null,
                            jobNumber: d.jobNumber || autoShow?.jobNumber || '',
                          });
                        } else {
                          updateDay(i, { worked: checked });
                        }
                      }}
                    />
                  </td>
                  <td>
                    <DayShowPicker
                      shows={config.pulledShows}
                      value={d.jobNumber || ''}
                      disabled={locked}
                      onChange={(job) => {
                        const sh = config.pulledShows.find((s) => s.jobNumber === job);
                        // Switching show updates this day's per-diem amount to
                        // the new show's, preserving the on/off state.
                        updateDay(i, {
                          jobNumber: job,
                          perDiem: d.perDiem != null ? (sh?.perDiem ?? null) : null,
                        });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={d.startTime}
                      onChange={(e) => updateDay(i, { startTime: e.target.value })}
                      disabled={locked || !d.worked}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={d.endTime}
                      onChange={(e) => updateDay(i, { endTime: e.target.value })}
                      disabled={locked || !d.worked}
                    />
                  </td>
                  {!config.hideMealBreak && (
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="time"
                          value={d.mealStart || ''}
                          onChange={(e) => updateDay(i, { mealStart: e.target.value || undefined })}
                          disabled={locked || !d.worked}
                        />
                        <input
                          type="time"
                          value={d.mealEnd || ''}
                          onChange={(e) => updateDay(i, { mealEnd: e.target.value || undefined })}
                          disabled={locked || !d.worked}
                        />
                      </div>
                    </td>
                  )}
                  {anyPerDiemShow && (
                    <td className="pd-col">
                      {(d.worked || (isFuture && hasPreview)) && dayShow?.perDiem != null && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={pdOn}
                          disabled={locked}
                          onChange={(e) =>
                            updateDay(i, {
                              perDiem: e.target.checked ? (d.perDiem ?? dayShow.perDiem) : null,
                            })
                          }
                        />
                        <span>$</span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={pdOn ? String(d.perDiem) : ''}
                          disabled={locked || !pdOn}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === '') {
                              updateDay(i, { perDiem: 0 });
                            } else {
                              const num = parseFloat(raw);
                              if (!isNaN(num)) updateDay(i, { perDiem: num });
                            }
                          }}
                          style={{ width: 70 }}
                        />
                      </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="primary"
            onClick={fill}
            disabled={disabled || submitting || loadingExisting || !jobNumber || needsPosition || timesheetLocked || hasWeekConflict}
            title={
              timesheetLocked ? `Timesheet is ${lockStatusLabel} — contact your labor coordinator to unlock.`
              : hasWeekConflict ? `This week already has a timesheet under ${weekConflict!.jobNumber}; multi-show weeks aren't supported yet.`
              : undefined
            }
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button
            className="secondary"
            onClick={reloadFromSsw}
            disabled={disabled || submitting || loadingExisting || !jobNumber}
            title="Re-read this week from C.A.R.L., overwriting whatever's currently shown."
          >
            {loadingExisting ? 'Reloading…' : 'Reload from C.A.R.L.'}
          </button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 12px', gap: 12 }}>
          <h2 style={{ margin: 0 }}>Your shows</h2>
          {autoStatus && autoStatus.toLowerCase().includes('shows') && (
            <span className="subtle" style={{ margin: 0 }}>{autoStatus}</span>
          )}
        </div>
        {config.pulledShows.length === 0 ? (
          <p className="subtle">No shows yet. Save your C.A.R.L. credentials in Settings, then restart the app.</p>
        ) : (
          config.pulledShows.map((s) => <ShowRow key={s.jobNumber} show={s} />)
        )}
      </div>
    </>
  );
}

function ShowRow({ show }: { show: PulledShow }) {
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.api.logo.forShow(show.jobName).then((uri) => { if (!cancelled) setLogo(uri); }).catch(() => {});
    return () => { cancelled = true; };
  }, [show.jobName]);
  return (
    <div className="show-row" style={{ flexWrap: 'wrap', gap: 4 }}>
      <div style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, color: 'var(--ct-gold)', fontWeight: 600, minWidth: 100 }}>
          {show.jobNumber}
        </div>
        {logo && <img src={logo} alt="" className="show-logo" />}
        <div style={{ flex: 1, fontWeight: 500 }}>{show.jobName}</div>
        <div className="subtle" style={{ minWidth: 100, textAlign: 'right', margin: 0 }}>{show.status}</div>
      </div>
      <div style={{ width: '100%', display: 'flex', gap: 12, fontSize: 13, color: 'var(--text-subtle)', flexWrap: 'wrap' }}>
        <div>{show.dateRange}</div>
        <div>Position: <strong style={{ color: 'var(--text)' }}>{show.position || '—'}</strong></div>
        <div>PM: {show.projectManager || '—'}</div>
        <div>LC: {show.laborCoordinator || '—'}</div>
      </div>
    </div>
  );
}
