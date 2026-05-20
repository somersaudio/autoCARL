import { useEffect, useMemo, useRef, useState } from 'react';
import { weekKey, type AppConfig, type DayHours, type PulledShow, type SubmitResult, type WeekEntry } from '../shared/types';
import WeekPicker from './WeekPicker';

type Props = {
  config: AppConfig;
  disabled: boolean;
  onChange: () => Promise<void>;
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

function makeDefaultDays(d: AppConfig['weeklyDefaults'], showPerDiem: number | null): WeekEntry['days'] {
  const mk = (worked: boolean): DayHours => ({
    worked,
    startTime: d.startTime,
    endTime: d.endTime,
    perDiem: showPerDiem,
  });
  return [
    mk(d.workMonFri),
    mk(d.workMonFri),
    mk(d.workMonFri),
    mk(d.workMonFri),
    mk(d.workMonFri),
    mk(false),
    mk(false),
  ];
}

export default function SubmitHours({ config, disabled, onChange }: Props) {
  // On first render, default to the currently active show (today is in its
  // date range) and the current calendar week's Monday.
  const initial = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const active = config.pulledShows.find((s) => {
      const m = s.dateRange.match(/(\d+)\/(\d+)\/(\d+)\s+to\s+(\d+)\/(\d+)\/(\d+)/);
      if (!m) return false;
      const start = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
      const end = new Date(Number(m[6]), Number(m[4]) - 1, Number(m[5]));
      return start <= today && today <= end;
    });
    return {
      jobNumber: active?.jobNumber || config.pulledShows[0]?.jobNumber || '',
      weekOfMonday: mondayOfWeek(new Date()),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [weekOfMonday, setWeekOfMonday] = useState(initial.weekOfMonday);
  const [jobNumber, setJobNumber] = useState(initial.jobNumber);
  const [days, setDays] = useState<WeekEntry['days']>(() => {
    const initialShow = config.pulledShows.find((s) => s.jobNumber === initial.jobNumber);
    return makeDefaultDays(config.weeklyDefaults, initialShow?.perDiem ?? null);
  });
  const [includePerDiem, setIncludePerDiem] = useState(true);
  const [loadedFromSave, setLoadedFromSave] = useState<{ at: string; recordId: string | null } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(false);
  // Key ({job, week}) for which SSW confirmed no existing record — used to
  // show a "new timesheet" banner so the user knows this is a fresh draft.
  const [newTimesheetKey, setNewTimesheetKey] = useState<string | null>(null);
  // Tracks which {job, week} key is currently being loaded from SSW, so a re-fire
  // of the load effect doesn't launch a duplicate headless browser.
  const inFlightLoadKey = useRef<string | null>(null);
  // Latest onChange ref so the load effect can call it without depending on it.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // If shows list changed (e.g. after refresh) and the selected jobNumber is gone, reset.
  useEffect(() => {
    if (jobNumber && !config.pulledShows.find((s) => s.jobNumber === jobNumber)) {
      setJobNumber(config.pulledShows[0]?.jobNumber || '');
    }
  }, [config.pulledShows, jobNumber]);

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
      // Migrate older SavedWeek shape: if days lack perDiem but the week-level
      // includePerDiem flag was set, populate each day from the show amount.
      const needsMigration = saved.days.some((d) => d.perDiem === undefined);
      const days = needsMigration
        ? (saved.days.map((d) => ({
            ...d,
            perDiem: d.perDiem !== undefined
              ? d.perDiem
              : (saved.includePerDiem && selectedShow?.perDiem != null ? selectedShow.perDiem : null),
          })) as unknown as WeekEntry['days'])
        : saved.days;
      setDays(days);
      setIncludePerDiem(saved.includePerDiem);
      setLoadedFromSave({ at: saved.lastSavedAt, recordId: saved.sswRecordId });
      setNewTimesheetKey(null);
      return;
    }

    // No local cache. Reset to defaults immediately, then ask SSW in the background.
    setDays(makeDefaultDays(config.weeklyDefaults, selectedShow?.perDiem ?? null));
    setIncludePerDiem(selectedShow?.perDiem != null);
    setLoadedFromSave(null);
    // Clear the "new timesheet" banner from a previous key; it'll be set again
    // below if SSW confirms no record for THIS key. Functional updater avoids
    // adding newTimesheetKey to the effect deps.
    setNewTimesheetKey((prev) => (prev === key ? prev : null));

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
          if (cancelled) return;
          if (r.ok && r.existing) {
            // Refresh config so the cached entry now flows through this same effect
            onChangeRef.current();
          } else if (r.ok && !r.existing) {
            setNewTimesheetKey(key);
          }
        })
        .finally(() => {
          if (inFlightLoadKey.current === key) inFlightLoadKey.current = null;
          if (!cancelled) setLoadingExisting(false);
        });
      return () => { cancelled = true; };
    }
  }, [jobNumber, weekOfMonday, config.savedWeeks, config.weeklyDefaults, config.pulledShows, disabled]);

  const updateDay = (i: number, patch: Partial<DayHours>) => {
    setDays((prev) => {
      const next = [...prev] as WeekEntry['days'];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const fill = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const entry: WeekEntry = { jobNumber, weekOfMonday, includePerDiem, days };
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
      if (!r.ok) {
        setResult({ ok: false, error: r.error });
      } else if (r.existing) {
        await onChange(); // brings the new cached data through the useEffect
      } else {
        setResult({ ok: false, error: 'No existing record found on SpreadsheetWeb for this show + week.' });
      }
    } finally {
      setLoadingExisting(false);
    }
  };

  const selectedShow = config.pulledShows.find((s) => s.jobNumber === jobNumber);
  const needsPosition = !!selectedShow && !selectedShow.position;

  // Saved drafts: every locally-cached week, sorted newest first. Filter out
  // the currently-selected one from the dropdown for clarity.
  const draftList = useMemo(() => {
    return Object.values(config.savedWeeks)
      .map((w) => ({
        ...w,
        show: config.pulledShows.find((s) => s.jobNumber === w.jobNumber),
      }))
      .sort((a, b) => new Date(b.lastSavedAt).getTime() - new Date(a.lastSavedAt).getTime());
  }, [config.savedWeeks, config.pulledShows]);

  const pickDraft = (key: string) => {
    if (!key) return;
    const [job, week] = key.split('__');
    setJobNumber(job);
    setWeekOfMonday(week);
  };
  const currentKey = `${jobNumber}__${weekOfMonday}`;

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
        <h2>Submit hours</h2>
        <p className="subtle">Defaults are pre-filled from your weekly defaults. Edit per day as needed.</p>

        {draftList.length > 1 && (
          <div className="field">
            <label>Saved drafts ({draftList.length})</label>
            <select
              value={currentKey}
              onChange={(e) => pickDraft(e.target.value)}
            >
              {draftList.map((d) => {
                const key = `${d.jobNumber}__${d.weekOfMonday}`;
                const label = `${d.weekOfMonday} — ${d.jobNumber}${d.show ? ` (${d.show.jobName.slice(0, 35)})` : ''} · saved ${new Date(d.lastSavedAt).toLocaleDateString()}`;
                return <option key={key} value={key}>{label}</option>;
              })}
            </select>
          </div>
        )}

        <div className="row">
          <div>
            <label>Week of (Monday)</label>
            <WeekPicker value={weekOfMonday} onChange={setWeekOfMonday} />
          </div>
          <div>
            <label>Show</label>
            <select value={jobNumber} onChange={(e) => setJobNumber(e.target.value)}>
              {config.pulledShows.length === 0 && <option value="">No shows pulled yet</option>}
              {config.pulledShows.map((s) => (
                <option key={s.jobNumber} value={s.jobNumber}>
                  {s.jobNumber} — {s.jobName}
                </option>
              ))}
            </select>
          </div>
        </div>

        {selectedShow && (
          <p className="subtle" style={{ marginBottom: 8 }}>
            PM: {selectedShow.projectManager || '—'} · LC: {selectedShow.laborCoordinator || '—'} ·{' '}
            Position: <strong style={{ color: 'var(--text)' }}>{selectedShow.position || '—'}</strong> ·{' '}
            {selectedShow.dateRange}
            {selectedShow.perDiem != null && <> · Per diem: <strong style={{ color: 'var(--text)' }}>${selectedShow.perDiem}</strong></>}
          </p>
        )}
        {needsPosition && (
          <div className="banner info">
            C.A.R.L. didn't return a Position for {selectedShow!.jobNumber}. Try Refresh below.
          </div>
        )}

        {loadingExisting && (
          <div className="banner info">Checking SpreadsheetWeb for an existing draft…</div>
        )}
        {loadedFromSave && !loadingExisting && (
          <div className="banner success">Current Week Loaded Successfully</div>
        )}
        {!loadedFromSave && !loadingExisting && newTimesheetKey === `${jobNumber}__${weekOfMonday}` && (
          <div className="banner info">New timesheet — no existing draft on SpreadsheetWeb for this week. Save will create one.</div>
        )}

        <table className="day-table">
          <thead>
            <tr>
              <th></th>
              <th>Work?</th>
              <th>Start</th>
              <th>End</th>
              <th>Meal break (start/end, optional)</th>
              {selectedShow?.perDiem != null && <th>Per diem</th>}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((label, i) => {
              const d = days[i];
              const pdOn = d.perDiem != null;
              return (
                <tr key={label}>
                  <td><strong>{label}</strong></td>
                  <td>
                    <input
                      type="checkbox"
                      checked={d.worked}
                      onChange={(e) => updateDay(i, { worked: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={d.startTime}
                      onChange={(e) => updateDay(i, { startTime: e.target.value })}
                      disabled={!d.worked}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={d.endTime}
                      onChange={(e) => updateDay(i, { endTime: e.target.value })}
                      disabled={!d.worked}
                    />
                  </td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="time"
                      value={d.mealStart || ''}
                      onChange={(e) => updateDay(i, { mealStart: e.target.value || undefined })}
                      disabled={!d.worked}
                    />
                    <input
                      type="time"
                      value={d.mealEnd || ''}
                      onChange={(e) => updateDay(i, { mealEnd: e.target.value || undefined })}
                      disabled={!d.worked}
                    />
                  </td>
                  {selectedShow?.perDiem != null && (
                    <td style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={pdOn}
                        onChange={(e) =>
                          updateDay(i, {
                            perDiem: e.target.checked ? (d.perDiem ?? selectedShow.perDiem) : null,
                          })
                        }
                      />
                      <span>$</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={pdOn ? String(d.perDiem) : ''}
                        disabled={!pdOn}
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
            disabled={disabled || submitting || loadingExisting || !jobNumber || needsPosition}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button
            className="secondary"
            onClick={reloadFromSsw}
            disabled={disabled || submitting || loadingExisting || !jobNumber}
            title="Re-read this week from SpreadsheetWeb, overwriting whatever's currently shown."
          >
            {loadingExisting ? 'Reloading…' : 'Reload from SpreadsheetWeb'}
          </button>
        </div>
        <p className="subtle" style={{ marginTop: 8 }}>
          Logs into SpreadsheetWeb in the background, fills the timesheet, and saves the record. Open the SpreadsheetWeb site to review and submit it for payroll.
        </p>
      </div>

      <div className="card">
        <h2 style={{ margin: 0 }}>Your shows</h2>
        <p className="subtle" style={{ margin: '8px 0 12px' }}>
          {config.pulledShowsAt
            ? `Last refreshed ${new Date(config.pulledShowsAt).toLocaleString()}`
            : 'Not yet pulled.'}
          {config.profile && ` · ${config.profile.name} (User ID ${config.profile.userId})`}
        </p>
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
  return (
    <div className="show-row" style={{ flexWrap: 'wrap', gap: 4 }}>
      <div style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, color: 'var(--text-subtle)', minWidth: 100 }}>
          {show.jobNumber}
        </div>
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
