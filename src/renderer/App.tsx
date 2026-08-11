import { useEffect, useState } from 'react';
import type {
  Booking, BookingContactsCache, FlightsCache, RefreshResult, SetupStatus, SswWeek, UpdateProgress, UserSettings,
} from '../shared/types';
import { friendlyError } from '../shared/errors';
import Setup from './Setup';
import BookingsList from './BookingsList';
import TimesheetTab from './TimesheetTab';
import SettingsModal from './Settings';
import FriendsTab from './FriendsTab';
import ExpensesTab from './ExpensesTab';
import MatrixRain from './MatrixRain';
import Starfield from './Starfield';
import { applyTheme, findTheme } from './themes';
import logoCT from './assets/logoCT.png';

type Tab = 'bookings' | 'timesheet' | 'expenses' | 'friends';

function mondayOfDate(d: Date): string {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const out = new Date(d);
  out.setDate(d.getDate() + diff);
  return `${out.getFullYear()}-${String(out.getMonth() + 1).padStart(2, '0')}-${String(out.getDate()).padStart(2, '0')}`;
}

export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [tab, setTab] = useState<Tab>('bookings');
  const [version, setVersion] = useState<string>('');
  const [settings, setSettings] = useState<UserSettings>({
    defaultStartTime: '8:00 am', defaultEndTime: '6:00 pm', autofillPerDiem: true,
    defaultDailyRate: 0, timesheetEmail: '', theme: 'constellation',
    basePayDayRate: 0, subtractTaxes: false, retirementPct: 0,
    filingStatus: 'single', ytdWages: 0, ytdAsOf: '', expectedAnnualWages: 0, spouseAnnualWages: 0, stateTaxRatePct: 0, gigDayRates: {},
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

  // -------- auto-update progress overlay --------
  useEffect(() => window.api.updater.onProgress(setUpdateProgress), []);

  // -------- theme: apply CSS-var overrides whenever the selected theme changes
  const theme = findTheme(settings.theme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  const backdrop =
    theme.backdrop === 'rain' ? <MatrixRain />
    : theme.backdrop === 'stars' ? <Starfield />
    : null;

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

  // Set or clear a single gig's day-rate override. Passing null removes the
  // entry entirely rather than storing a zero, so `gigDayRates` only ever holds
  // real overrides and the fallback to base pay stays a simple absence check.
  const setGigDayRate = async (bookingId: string, rate: number | null) => {
    const next = { ...settings.gigDayRates };
    if (rate === null) delete next[bookingId];
    else next[bookingId] = rate;
    setSettings(await window.api.settings.update({ gigDayRates: next }));
  };

  const refreshBookings = async () => {
    setBookingsRefreshing(true);
    applyBookingsRefresh(await window.api.bookings.refresh());
    setBookingsRefreshing(false);
  };

  useEffect(() => {
    if (status?.stage !== 'ready') return;
    window.api.ssw.getCachedWeeks().then(setSswWeeks).catch(() => {});
  }, [status?.stage, sswWeek]);

  // -------- ssw week --------
  // Paint cached data immediately (sub-ms read from disk) then kick off a
  // live refresh in the background. No loading screen on app open as long as
  // the week has been fetched at least once before.
  useEffect(() => {
    if (status?.stage !== 'ready') return;
    let cancelled = false;
    setSswError(null);
    window.api.ssw.getCached(currentWeekMonday).then((cached) => {
      if (cancelled) return;
      setSswWeek(cached);
    });
    setSswLoading(true);
    window.api.ssw.fetchWeek(currentWeekMonday)
      .then((w) => { if (!cancelled && w) setSswWeek(w); })
      .catch((e) => { if (!cancelled) setSswError(friendlyError(e, !navigator.onLine)); })
      .finally(() => { if (!cancelled) setSswLoading(false); });
    return () => { cancelled = true; };
  }, [status?.stage, currentWeekMonday]);

  const reloadWeek = async () => {
    setSswLoading(true);
    setSswError(null);
    try {
      const w = await window.api.ssw.fetchWeek(currentWeekMonday);
      setSswWeek(w);
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
    <div className="app">
      <div className="app-header">
        <img src={logoCT} alt="Creative Technology" className="ct-logo" />
        <div className="app-subtitle">AUTOcarl</div>
        <div className="app-tabs">
          <button
            className={`tab ${tab === 'bookings' ? 'is-active' : ''}`}
            onClick={() => setTab('bookings')}
          >Bookings</button>
          <button
            className={`tab ${tab === 'timesheet' ? 'is-active' : ''}`}
            onClick={() => setTab('timesheet')}
          >Timesheet</button>
          <button
            className={`tab ${tab === 'expenses' ? 'is-active' : ''}`}
            onClick={() => setTab('expenses')}
          >Expense Reports</button>
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
          onRefresh={refreshBookings}
          onResetSetup={async () => { await window.api.setup.clear(); setStatus({ stage: 'needs-carl-credentials' }); }}
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

      {tab === 'timesheet' && (
        <TimesheetTab
          bookings={bookings}
          contacts={contacts}
          weekMonday={currentWeekMonday}
          onWeekChange={setCurrentWeekMonday}
          week={sswWeek}
          loading={sswLoading}
          error={sswError}
          onLocalEdit={setSswWeek}
          onReload={reloadWeek}
          defaultStartTime={settings.defaultStartTime}
          defaultEndTime={settings.defaultEndTime}
          autofillPerDiem={settings.autofillPerDiem}
          timesheetEmail={settings.timesheetEmail}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {version && <div className="app-version subtle">v{version}</div>}
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
