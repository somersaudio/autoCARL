import { useEffect, useState } from 'react';
import type {
  Booking, BookingContactsCache, FlightsCache, RefreshResult, SetupStatus, SswWeek, UpdateProgress, UserSettings,
} from '../shared/types';
import { friendlyError } from '../shared/errors';
import Setup from './Setup';
import BookingsList from './BookingsList';
import TimesheetTab, { forgetClearedDays } from './TimesheetTab';
import SettingsModal from './Settings';
import FriendsTab from './FriendsTab';
import { estimatorKeepFrom, lastPayDateOf, timesheetDueDate } from '../shared/paychecks';
import ExpensesTab from './ExpensesTab';
import InstallBanner from './InstallBanner';
import MatrixRain from './MatrixRain';
import Starfield from './Starfield';
import CamoField from './CamoField';
import SunsetField from './SunsetField';
import { applyTheme, findTheme } from './themes';
import logoCT from './assets/logoCT.png';

type Tab = 'bookings' | 'timesheet' | 'expenses' | 'friends';

// True when running as the web build (src/web/api-shim.ts sets the flag).
// The tabs are the same on both surfaces; a few labels tighten up for
// phone-width tab rows.
const IS_WEB = Boolean((window as unknown as { __AUTOCARL_WEB__?: boolean }).__AUTOCARL_WEB__);

function mondayOfDate(d: Date): string {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const out = new Date(d);
  out.setDate(d.getDate() + diff);
  return `${out.getFullYear()}-${String(out.getMonth() + 1).padStart(2, '0')}-${String(out.getDate()).padStart(2, '0')}`;
}

// Today's local date as a key, for noticing that the day has changed.
function localDayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [tab, setTab] = useState<Tab>('bookings');
  const [version, setVersion] = useState<string>('');
  const [settings, setSettings] = useState<UserSettings>({
    defaultStartTime: '8:00 am', defaultEndTime: '6:00 pm', autofillPerDiem: true,
    defaultDailyRate: 0, timesheetEmail: '', timesheetPhone: '', theme: 'constellation',
    basePayDayRate: 0, subtractTaxes: false, perDiemInTotal: true, homeAirport: '', retirementPct: 0,
    filingStatus: 'single', ytdWages: 0, ytdAsOf: '', expectedAnnualWages: 0, spouseAnnualWages: 0, stateTaxRatePct: 0, gigDayRates: {}, slippedWeeks: [],
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);

  // Shared data — loaded once, refreshed on demand. Stays alive while the
  // user switches tabs so there's no reload when they bounce between them.
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [bookingsFetchedAt, setBookingsFetchedAt] = useState<string | null>(null);
  const [bookingsRefreshing, setBookingsRefreshing] = useState(false);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [flights, setFlights] = useState<FlightsCache>({});
  const [contacts, setContacts] = useState<BookingContactsCache>({});

  const [currentWeekMonday, setCurrentWeekMonday] = useState<string>(() => mondayOfDate(new Date()));
  const [sswWeek, setSswWeek] = useState<SswWeek | null>(null);
  // The same week as SSW last returned it, without the unsaved edits sswWeek
  // picks up; set together with sswWeek whenever a week comes from SSW. The
  // Timesheet tab reads a saved day off from it.
  const [sswSavedWeek, setSswSavedWeek] = useState<SswWeek | null>(null);
  // Every cached SSW week, for the paycheck estimator's actual-hours pricing.
  // Re-read whenever the active week changes — fetchWeek/pushWeek write the
  // cache, so this stays current after timesheet edits are saved.
  const [sswWeeks, setSswWeeks] = useState<Record<string, SswWeek>>({});
  const [sswLoading, setSswLoading] = useState(false);
  const [sswError, setSswError] = useState<string | null>(null);

  // -------- setup status --------
  useEffect(() => {
    window.api.setup.getStatus().then(setStatus);
    window.api.app.getVersion().then(setVersion).catch(() => {});
    window.api.settings.get().then(setSettings).catch(() => {});
  }, []);

  // Logging out clears the timesheet phone and email overrides, so read the
  // settings again each time the app is set up; otherwise the next person's
  // Timesheet tab would still show the last person's until a restart.
  useEffect(() => {
    if (status?.stage !== 'ready') return;
    window.api.settings.get().then(setSettings).catch(() => {});
  }, [status?.stage]);

  // -------- auto-update progress overlay --------
  useEffect(() => window.api.updater.onProgress(setUpdateProgress), []);

  // -------- visual-viewport glue --------
  // iOS anchors position:fixed to the LAYOUT viewport, which slides away
  // from the visible one while Safari's toolbar expands or the page
  // rubber-bands — the settings gear floated mid-screen on scroll-up.
  // Publish the live gap between the two viewport bottoms as a CSS var;
  // the gear's `bottom` adds it, staying glued to the visible corner.
  // Desktop and Android keep the gap at 0.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const gap = window.innerHeight - vv.height - vv.offsetTop;
      document.documentElement.style.setProperty('--vv-gap', `${Math.round(gap)}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // -------- theme: apply CSS-var overrides whenever the selected theme changes
  const theme = findTheme(settings.theme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  const backdrop =
    theme.backdrop === 'rain' ? <MatrixRain />
    : theme.backdrop === 'stars' ? <Starfield />
    : theme.backdrop === 'camo' ? <CamoField />
    : theme.backdrop === 'sunset' ? <SunsetField />
    : null;

  // "I don't submit timesheets through C.A.R.L." — hides the Timesheet tab
  // and every SSW touchpoint.
  const sswSkipped = status?.stage === 'ready' && !!status.sswSkipped;

  // -------- bookings --------
  useEffect(() => {
    if (status?.stage !== 'ready') return;
    window.api.bookings.getCached().then(({ bookings, fetchedAt }) => {
      setBookings(bookings);
      setBookingsFetchedAt(fetchedAt);
    });
    window.api.flights.getCached().then(setFlights);
    window.api.contacts.getCached().then(setContacts);
    setBookingsRefreshing(true);
    window.api.bookings.refresh().finally(() => setBookingsRefreshing(false));
    const unsubBookings = window.api.bookings.subscribe(applyBookingsRefresh);
    const unsubFlights = window.api.flights.subscribe(setFlights);
    const unsubContacts = window.api.contacts.subscribe(setContacts);
    return () => { unsubBookings(); unsubFlights(); unsubContacts(); };
  }, [status?.stage]);

  const applyBookingsRefresh = (r: RefreshResult) => {
    if (r.ok) {
      setBookings(r.bookings);
      setBookingsFetchedAt(r.fetchedAt);
      setBookingsError(null);
    } else {
      setBookingsError(friendlyError(r.error, !navigator.onLine));
    }
  };

  // Set or clear a gig's day-rate override — applied to EVERY booking that
  // shares the job number, because one job can span several bookings and
  // paychecks and they must all price (and underline) together. Passing null
  // removes the entries entirely rather than storing zeros, so `gigDayRates`
  // only ever holds real overrides and the fallback to base pay stays a
  // simple absence check.
  const setGigDayRate = async (bookingId: string, rate: number | null) => {
    const job = bookings.find((b) => b.bookingId === bookingId)?.jobNumber;
    const ids = job
      ? bookings.filter((b) => b.jobNumber === job).map((b) => b.bookingId)
      : [bookingId];
    const next = { ...settings.gigDayRates };
    for (const id of ids) {
      if (rate === null) delete next[id];
      else next[id] = rate;
    }
    setSettings(await window.api.settings.update({ gigDayRates: next }));
  };

  // Mark a timesheet week as not paid on the check it's on, so the estimator
  // moves its hours one check later, or step it back one check. slippedWeeks
  // lists a week once per check it moved (see paychecks.ts). Read the stored
  // list first, so two quick taps each count.
  const setWeekSlipped = async (monday: string, slippedNow: boolean) => {
    const stored = await window.api.settings.get();
    const weeks = [...(stored.slippedWeeks || [])];
    if (slippedNow) {
      weeks.push(monday);
    } else {
      const at = weeks.indexOf(monday);
      if (at >= 0) weeks.splice(at, 1);
    }
    setSettings(await window.api.settings.update({ slippedWeeks: weeks }));
  };

  // Tapping Email or Phone at the bottom of the Timesheet tab sets the same
  // override as the Settings fields. Resolves with the stored settings so the
  // tab can confirm the change took.
  const setTimesheetContact = async (patch: Partial<Pick<UserSettings, 'timesheetEmail' | 'timesheetPhone'>>) => {
    const next = await window.api.settings.update(patch);
    setSettings(next);
    return next;
  };

  const refreshBookings = async () => {
    setBookingsRefreshing(true);
    applyBookingsRefresh(await window.api.bookings.refresh());
    setBookingsRefreshing(false);
  };

  useEffect(() => {
    if (status?.stage !== 'ready' || sswSkipped) return;
    window.api.ssw.getCachedWeeks().then(setSswWeeks).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.stage, sswSkipped, sswWeek]);

  // The week loader below re-reads weeks cached as not turned in, but the
  // estimator's flag switches on by date. Run it again when the day changes,
  // and when the app comes back into view (at most every 30 minutes), so a
  // week turned in on the SSW site stops being flagged without hammering SSW.
  const [weekRefreshKey, setWeekRefreshKey] = useState(() => localDayKey());
  useEffect(() => {
    let day = localDayKey();
    let lastRun = Date.now();
    const maybeRun = (returning: boolean) => {
      const today = localDayKey();
      const now = Date.now();
      if (today === day && !(returning && now - lastRun >= 30 * 60_000)) return;
      day = today;
      lastRun = now;
      setWeekRefreshKey(`${today}#${now}`);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') maybeRun(true); };
    const onFocus = () => maybeRun(true);
    const timer = window.setInterval(() => maybeRun(false), 10 * 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  const slippedKey = (settings.slippedWeeks || []).join(',');

  // The estimator prices a day from saved timesheet hours when it has them,
  // but the app only ever LOADED the current week — so a gig that began in an
  // earlier week had those days priced at the flat day rate and any overtime
  // on them stayed invisible. (A home-screen app has its own storage, quite
  // separate from Safari's, so it can be missing weeks the browser already
  // holds.) Load the weeks that cover every gig still owed on a check that
  // hasn't paid, finished ones included, since those hours price that check.
  // Only weeks that have already begun: a week still ahead has no hours yet.
  useEffect(() => {
    if (status?.stage !== 'ready' || sswSkipped || bookings.length === 0) return;
    let cancelled = false;
    void (async () => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      // The estimator's own rule for which gigs are still owed (moved weeks and
      // the days a paid check stays up included), so every week it shows is
      // one this loader keeps fresh.
      const keepFrom = estimatorKeepFrom(todayIso);
      const slippedWeeks = settings.slippedWeeks || [];
      const wanted = new Set<string>();
      for (const b of bookings) {
        const end = new Date(`${b.endDate}T00:00:00`);
        if (lastPayDateOf(b, slippedWeeks) < keepFrom) continue;   // its last check has paid
        const last = end < today ? end : today;          // nothing logged past today
        const cursor = new Date(`${b.startDate}T00:00:00`);
        while (cursor <= last) {
          wanted.add(mondayOfDate(cursor));
          cursor.setDate(cursor.getDate() + 7);
        }
        wanted.add(mondayOfDate(last));
      }
      const cached = await window.api.ssw.getCachedWeeks().catch(() => ({} as Record<string, SswWeek>));
      // A week cached as not turned in is read again once its Monday deadline
      // has passed: it may have been submitted on the SSW site since, and the
      // estimator flags a week that still isn't (see PaychecksCard).
      const stale = (m: string) => cached[m]?.statusIndex === 0 && timesheetDueDate(m) < todayIso;
      // Cap the burst: each miss is a round trip to SSW.
      const missing = Array.from(wanted).filter((m) => !cached[m] || stale(m)).sort().slice(0, 6);
      for (const monday of missing) {
        if (cancelled) return;
        await window.api.ssw.fetchWeek(monday).catch(() => null);
      }
      if (!cancelled && missing.length > 0) {
        window.api.ssw.getCachedWeeks().then(setSswWeeks).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.stage, sswSkipped, bookings.length, slippedKey, weekRefreshKey]);

  // -------- ssw week --------
  // Paint cached data immediately (sub-ms read from disk) then kick off a
  // live refresh in the background. No loading screen on app open as long as
  // the week has been fetched at least once before.
  useEffect(() => {
    if (status?.stage !== 'ready' || sswSkipped) return;
    let cancelled = false;
    setSswError(null);
    window.api.ssw.getCached(currentWeekMonday).then((cached) => {
      if (cancelled) return;
      setSswWeek(cached);
      setSswSavedWeek(cached);
    });
    setSswLoading(true);
    window.api.ssw.fetchWeek(currentWeekMonday)
      .then((w) => { if (!cancelled && w) { setSswWeek(w); setSswSavedWeek(w); } })
      .catch((e) => { if (!cancelled) setSswError(friendlyError(e, !navigator.onLine)); })
      .finally(() => { if (!cancelled) setSswLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.stage, sswSkipped, currentWeekMonday]);

  const reloadWeek = async () => {
    setSswLoading(true);
    setSswError(null);
    try {
      const w = await window.api.ssw.fetchWeek(currentWeekMonday);
      setSswWeek(w);
      setSswSavedWeek(w);
    } catch (e) {
      setSswError(friendlyError(e, !navigator.onLine));
    } finally {
      setSswLoading(false);
    }
  };

  // -------- render --------
  if (!status) return (
    <>
      {backdrop}
      {updateProgress && <UpdateOverlay progress={updateProgress} />}
      <div className="app"><p className="subtle">Loading…</p></div>
    </>
  );

  if (status.stage !== 'ready') {
    return (
      <>
        {backdrop}
        {updateProgress && <UpdateOverlay progress={updateProgress} />}
        {IS_WEB && <InstallBanner />}
        <div className="app">
          <div className="app-header">
            <img src={logoCT} alt="Creative Technology" className="ct-logo" />
            <div className="app-subtitle">AUTOcarl</div>
          </div>
          <Setup status={status} onChange={setStatus} />
        </div>
      </>
    );
  }

  return (
    <>
    {backdrop}
    {updateProgress && <UpdateOverlay progress={updateProgress} />}
    {IS_WEB && <InstallBanner />}
    <div className="app">
      <div className="app-header">
        <img src={logoCT} alt="Creative Technology" className="ct-logo" />
        <div className="app-subtitle">AUTOcarl</div>
        <div className="app-tabs">
          <button
            className={`tab ${tab === 'bookings' ? 'is-active' : ''}`}
            onClick={() => setTab('bookings')}
          >Bookings</button>
          {!sswSkipped && (
            <button
              className={`tab ${tab === 'timesheet' ? 'is-active' : ''}`}
              onClick={() => setTab('timesheet')}
            >Timesheet</button>
          )}
          <button
            className={`tab ${tab === 'expenses' ? 'is-active' : ''}`}
            onClick={() => setTab('expenses')}
          >{IS_WEB ? 'Expenses' : 'Expense Reports'}</button>
          <button
            className={`tab ${tab === 'friends' ? 'is-active' : ''}`}
            onClick={() => setTab('friends')}
          >Friends</button>
        </div>
        {sswWeek && (
          <div className="app-user">
            <div className="app-user-name">{sswWeek.name}</div>
            <div className="app-user-id subtle">ID {sswWeek.userId}</div>
          </div>
        )}
      </div>

      {tab === 'bookings' && (
        <BookingsList
          bookings={bookings}
          fetchedAt={bookingsFetchedAt}
          refreshing={bookingsRefreshing}
          error={bookingsError}
          flights={flights}
          contacts={contacts}
          settings={settings}
          sswWeeks={sswWeeks}
          onSetDayRate={setGigDayRate}
          onSetWeekSlipped={setWeekSlipped}
          onRefresh={refreshBookings}
          onResetSetup={async () => { forgetClearedDays(); await window.api.setup.clear(); forgetClearedDays(); setStatus({ stage: 'needs-carl-credentials' }); }}
        />
      )}

      {tab === 'expenses' && (
        <ExpensesTab bookings={bookings} />
      )}

      {tab === 'friends' && (
        <FriendsTab
          bookings={bookings}
          suggestedName={sswWeek?.name || Object.values(sswWeeks)[0]?.name || ''}
        />
      )}

      {tab === 'timesheet' && !sswSkipped && (
        <TimesheetTab
          bookings={bookings}
          contacts={contacts}
          weekMonday={currentWeekMonday}
          onWeekChange={setCurrentWeekMonday}
          week={sswWeek}
          savedWeek={sswSavedWeek}
          loading={sswLoading}
          error={sswError}
          onLocalEdit={setSswWeek}
          onReload={reloadWeek}
          defaultStartTime={settings.defaultStartTime}
          defaultEndTime={settings.defaultEndTime}
          autofillPerDiem={settings.autofillPerDiem}
          settings={settings}
          onSetContact={setTimesheetContact}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {version && !IS_WEB && <div className="app-version subtle">v{version}</div>}
      <button
        className="settings-gear"
        title="Settings"
        aria-label="Settings"
        onClick={() => setSettingsOpen(true)}
      >
        ⚙
      </button>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={setSettings}
        sswSkipped={sswSkipped}
        onEnableSsw={async () => {
          setSettingsOpen(false);
          setStatus(await window.api.setup.setSswSkipped(false));
        }}
        onLogout={async () => {
          setSettingsOpen(false);
          forgetClearedDays();
          await window.api.setup.clear();
          // Again once the wait is over: the Timesheet tab stays up until the
          // status changes, and a day cleared meanwhile would outlive the logout.
          forgetClearedDays();
          setStatus({ stage: 'needs-carl-credentials' });
        }}
      />
    </div>
    </>
  );
}

// Full-screen overlay shown while a macOS auto-update downloads + installs.
// The app quits itself shortly after the 'installing' phase, so this is the
// last thing the user sees before the relaunch.
function UpdateOverlay({ progress }: { progress: UpdateProgress }) {
  const downloading = progress.phase === 'downloading';
  const pct = downloading ? progress.percent : 100;
  return (
    <div className="update-overlay">
      <div className="update-card">
        <div className="update-title">
          {downloading ? 'Downloading update…' : 'Installing — AUTOcarl will relaunch'}
        </div>
        <div className="update-bar">
          <div
            className={`update-bar-fill ${downloading ? '' : 'is-indeterminate'}`}
            style={downloading ? { width: `${pct}%` } : undefined}
          />
        </div>
        <div className="update-pct subtle">
          {downloading ? `${pct}%` : 'Almost done…'}
        </div>
      </div>
    </div>
  );
}
