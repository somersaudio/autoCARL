import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, ProgressEvent } from '../shared/types';
import Settings from './Settings';
import SubmitHours from './SubmitHours';
import ProgressDial from './ProgressDial';

type Tab = 'hours' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('hours');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);

  // Subscribe to progress events from any SSW automation run (load / fill).
  // Guarded so HMR doesn't crash when the renderer reloads ahead of preload.
  useEffect(() => {
    if (!window.api.progress?.subscribe) {
      console.warn('[autocarl] window.api.progress not available — restart `npm run dev` to refresh the preload bundle');
      return;
    }
    const unsub = window.api.progress.subscribe((e) => {
      setProgress(e);
      if (e.done) setTimeout(() => setProgress((cur) => (cur && cur.done ? null : cur)), 2000);
    });
    return unsub;
  }, []);

  // On app open:
  //  1. Load config + apply theme
  //  2. Refresh shows from C.A.R.L. (latest shows + profile)
  //  3. Re-pull the most-recently-saved week from SpreadsheetWeb so the
  //     user sees current site state, not stale local cache.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await window.api.config.get();
      if (cancelled) return;
      setConfig(cfg);
      if (!cfg.carlUsername) return;
      const hasCarlPass = await window.api.credentials.has('carl', cfg.carlUsername);
      if (!hasCarlPass || cancelled) return;

      // Phase 1: load the most-recently-updated record from SpreadsheetWeb.
      // SSW itself is the source of truth for "what timesheet am I currently
      // working on" — no cached show data needed.
      if (cfg.sswUsername) {
        const hasSswPass = await window.api.credentials.has('ssw', cfg.sswUsername);
        if (hasSswPass && !cancelled) {
          setAutoStatus('Loading your most recent timesheet from SpreadsheetWeb…');
          console.log('[autocarl] PHASE 1: SSW load-most-recent starting');
          try {
            const r = await window.api.timesheet.loadMostRecent();
            console.log('[autocarl] PHASE 1: SSW load-most-recent done',
              r.ok ? (r.record ? `record ${r.record.jobNumber}/${r.record.weekOfMonday}` : 'no record found') : `error: ${r.error}`);
          } catch (e) {
            console.log('[autocarl] PHASE 1 error:', e);
          }
          if (cancelled) return;
          setConfig(await window.api.config.get());
        }
      } else {
        console.log('[autocarl] PHASE 1 skipped — no SSW creds');
      }

      // Phase 2: refresh shows from C.A.R.L. last (background).
      console.log('[autocarl] PHASE 2: CARL refresh starting');
      setAutoStatus('Refreshing your shows from C.A.R.L.…');
      try {
        const r = await window.api.carl.refresh();
        console.log('[autocarl] PHASE 2: CARL refresh result', r);
        if (!r.ok && !cancelled) {
          setStartupError(`Couldn't refresh shows from C.A.R.L.: ${r.error}. Showing previously-pulled shows.`);
        }
      } catch (e) {
        console.log('[autocarl] PHASE 2 error:', e);
        if (!cancelled) {
          setStartupError(`Couldn't refresh shows from C.A.R.L.: ${e instanceof Error ? e.message : String(e)}. Showing previously-pulled shows.`);
        }
      }
      console.log('[autocarl] PHASE 2: CARL refresh done');

      if (!cancelled) {
        setConfig(await window.api.config.get());
        setAutoStatus(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (config) document.documentElement.setAttribute('data-theme', config.theme);
  }, [config?.theme]);

  const refresh = useCallback(async () => {
    setConfig(await window.api.config.get());
  }, []);

  if (!config) {
    return <div className="app"><p>Loading…</p></div>;
  }

  const setupComplete =
    config.carlUsername && config.sswUsername && config.pulledShows.length > 0;

  return (
    <div className="app">
      <h1>AUTOcarl</h1>
      <p className="subtle">Hours and expenses, the easy way.</p>

      <div className="tabs">
        <button className={`tab ${tab === 'hours' ? 'active' : ''}`} onClick={() => setTab('hours')}>
          Submit Hours
        </button>
        <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          Settings
        </button>
      </div>

      {progress && !progress.done && (
        <div className="banner info" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ProgressDial percent={progress.percent} label={progress.label} size={60} />
        </div>
      )}

      {autoStatus && !progress && (
        <div className="banner info">{autoStatus}</div>
      )}

      {startupError && !autoStatus && (
        <div className="banner error" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>{startupError}</span>
          <button className="secondary" onClick={() => setStartupError(null)}>Dismiss</button>
        </div>
      )}

      {!setupComplete && tab === 'hours' && !autoStatus && !progress && (
        <div className="banner info">
          Finish setup in <strong>Settings</strong> first — save both logins, then click Refresh below.
        </div>
      )}

      {tab === 'hours' ? (
        <SubmitHours config={config} disabled={!setupComplete} onChange={refresh} />
      ) : (
        <Settings config={config} onChange={refresh} />
      )}
    </div>
  );
}
