import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Booking, BookingContactsCache, FlightsCache, RefreshResult, SetupStatus, SswDay, SswPushResult, SswWeek, UpdateProgress, UserSettings,
} from '../shared/types';
import { friendlyError } from '../shared/errors';
import { rebaseWeek, sameDay, weekChangedSince } from '../shared/weekMerge';
import type { WeekRebase } from '../shared/weekMerge';
import Setup from './Setup';
import BookingsList from './BookingsList';
import TimesheetTab, { forgetClearedDays } from './TimesheetTab';
import SettingsModal from './Settings';
import FriendsTab, { forgetFriendsSession } from './FriendsTab';
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

// Today's local date, YYYY-MM-DD.
function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// One SSW timesheet record, for telling whether two copies are the same week.
function weekIdOf(w: SswWeek): string {
  return `${w.recordId}|${w.weekStartDate}`;
}

// What the Timesheet tab says when a save found the week changed in SSW since
// it was read here, and merged the two on screen instead of saving.
function rebaseNotice(r: WeekRebase): string {
  const days = (dates: string[]) => r.week.days
    .filter((d) => dates.includes(d.date))
    .map((d) => d.weekday.slice(0, 3))
    .join(', ');
  const where = [
    r.changedDates.length > 0 ? days(r.changedDates) : '',
    r.weekFieldsChanged ? 'the week details' : '',
  ].filter(Boolean).join(' and ');
  let notice = `Not saved yet: this week was changed in SSW after it was opened here${where ? ` (${where})` : ''}. Those changes are in now, with your edits on top.`;
  if (r.conflictDates.length > 0) notice += ` Where you both changed the same thing (${days(r.conflictDates)}), yours is kept.`;
  return `${notice} Check it, then tap Save again.`;
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
  // Whether the open week on screen was read from SSW. A copy painted from the
  // cache while SSW can't be reached may be older than what SSW holds, and
  // saving it would write those older days back over newer ones, so the
  // Timesheet tab keeps Save off until a read comes back.
  const [sswLive, setSswLive] = useState(false);
  // A save of the open week is running. The Timesheet tab keeps the week locked
  // meanwhile, even after a switch of tabs: the save sends the copy from the
  // tap, so an edit typed during it would be lost or put back.
  const [sswSaving, setSswSaving] = useState(false);
  // Why the last save of the open week didn't happen, kept here so the tab
  // still says so after it unmounts and comes back.
  const [sswSaveNotice, setSswSaveNotice] = useState<string | null>(null);
  // Fields of the open week changed by hand here and not saved yet (see
  // weekMerge). Kept here because the Timesheet tab unmounts on another tab.
  const weekEdits = useRef<{ id: string; keys: Set<string> }>({ id: '', keys: new Set() });
  // Each of those days as it was before the first edit to it, so an edit that
  // puts the day back stops counting (see editOpenWeek).
  const weekEditBase = useRef<Map<string, SswDay>>(new Map());
  // Every read or save of the open week takes the next number; a read that
  // comes back after a newer one began is dropped.
  const weekLoad = useRef(0);
  const weekSaving = useRef(false);
  const lastWeekRead = useRef(0);
  // The open week as last set, for callbacks that land between renders.
  const openWeek = useRef({ week: sswWeek, saved: sswSavedWeek, live: sswLive, loading: sswLoading });
  openWeek.current = { week: sswWeek, saved: sswSavedWeek, live: sswLive, loading: sswLoading };
  // The week picked now. The Timesheet tab's reload after a save comes from the
  // render the tap happened in, so it reads this instead of that render's
  // Monday: a week picked while the save was out is the one to load.
  const openMonday = useRef(currentWeekMonday);
  openMonday.current = currentWeekMonday;

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

  // A copy of the open week read from SSW outside the week loader. When its
  // submitted status has changed since the week was opened (submitted on the
  // SSW site, or unlocked by the Labor Coordinator), show it as SSW holds it
  // now: a submitted week's unsaved edits couldn't be saved anyway, and a week
  // that was locked had none. Otherwise the open copy, edits and all, stays.
  const takeFreshOpenWeek = (fresh: SswWeek) => {
    const cur = openWeek.current.week;
    if (cur && cur.recordId === fresh.recordId && cur.statusIndex !== fresh.statusIndex) showSswWeek(fresh);
  };

  const forgetEdits = () => {
    weekEdits.current = { id: '', keys: new Set() };
    weekEditBase.current = new Map();
  };
  const editsOf = (w: SswWeek | null): ReadonlySet<string> =>
    (w && weekEdits.current.id === weekIdOf(w) ? weekEdits.current.keys : new Set<string>());

  // Show the open week as SSW holds it. Edits made here and not saved yet stay
  // on top (see rebaseWeek), unless the week is now submitted or is another
  // record, where they could never be saved.
  const showSswWeek = (fresh: SswWeek | null) => {
    const { week: mine, saved } = openWeek.current;
    const edits = editsOf(mine);
    let next = fresh;
    if (fresh && mine && edits.size > 0 && fresh.statusIndex === 0 && weekIdOf(mine) === weekIdOf(fresh)) {
      const base = saved && weekIdOf(saved) === weekIdOf(fresh) ? saved : fresh;
      const merged = rebaseWeek(base, mine, fresh, edits, isoToday());
      next = merged.week;
      // A read that put someone else's save under the edits here says so, just
      // as a save held back does. Otherwise the day this device keeps whole
      // goes over theirs on the next Save with nothing ever shown.
      if (merged.changedDates.length > 0 || merged.weekFieldsChanged) setSswSaveNotice(rebaseNotice(merged));
    } else {
      forgetEdits();
    }
    openWeek.current = { ...openWeek.current, week: next, saved: fresh, live: !!fresh };
    setSswWeek(next);
    setSswSavedWeek(fresh);
    setSswLive(!!fresh);
  };

  // Autofill's changes to the open week: shown, but not edits made here.
  const showAutofilledWeek = useCallback((next: SswWeek) => {
    openWeek.current = { ...openWeek.current, week: next };
    setSswWeek(next);
  }, []);

  // A change typed or picked on the Timesheet tab; `keys` name its fields.
  const editOpenWeek = useCallback((next: SswWeek, keys: string[]) => {
    const id = weekIdOf(next);
    if (weekEdits.current.id !== id) {
      weekEdits.current = { id, keys: new Set() };
      weekEditBase.current = new Map();
    }
    const before = openWeek.current.week;
    const dates = new Set<string>();
    for (const key of keys) {
      weekEdits.current.keys.add(key);
      const date = key.slice(0, key.indexOf(':'));
      if (date === 'week') continue;
      dates.add(date);
      const was = before?.days.find((d) => d.date === date);
      if (was && !weekEditBase.current.has(date)) weekEditBase.current.set(date, was);
    }
    // A day put back the way it was isn't an edit any more: passing through
    // "— no work —" on the way to another show and back changes every field of
    // the day and then changes them back, and that must not outrank hours saved
    // on another device.
    for (const date of dates) {
      const was = weekEditBase.current.get(date);
      const now = next.days.find((d) => d.date === date);
      if (!was || !now || !sameDay(was, now)) continue;
      weekEdits.current.keys.forEach((k) => { if (k.startsWith(`${date}:`)) weekEdits.current.keys.delete(k); });
      weekEditBase.current.delete(date);
    }
    openWeek.current = { ...openWeek.current, week: next };
    setSswWeek(next);
  }, []);

  // The same for the buddy list: a C.A.R.L. login for someone else makes the
  // name, icon and buddies on that tab the last person's, and they are held in
  // the tab's own state, so it is built again from nothing.
  const [friendsGen, setFriendsGen] = useState(0);
  const forgetFriends = () => {
    forgetFriendsSession();
    setFriendsGen((n) => n + 1);
  };

  // The shows, itineraries and venue contacts on screen came down the calendar
  // of the login stored a moment ago. What the app keeps for the new one is
  // read again here — empty until its own first fetch lands behind this.
  const reloadCarlCaches = () => {
    setBookingsError(null);
    window.api.bookings.getCached().then(({ bookings, fetchedAt }) => {
      setBookings(bookings);
      setBookingsFetchedAt(fetchedAt);
    }).catch(() => {});
    window.api.flights.getCached().then(setFlights).catch(() => {});
    window.api.contacts.getCached().then(setContacts).catch(() => {});
  };

  // Log out, Reset, or a login changed in Settings: nothing from the previous
  // account's timesheets stays on screen or in memory.
  const forgetSswWeeks = () => {
    weekLoad.current += 1;
    forgetEdits();
    openWeek.current = { week: null, saved: null, live: false, loading: false };
    setSswWeek(null);
    setSswSavedWeek(null);
    setSswLive(false);
    setSswLoading(false);
    setSswSaveNotice(null);
    setSswWeeks({});
  };

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
        const fresh = await window.api.ssw.fetchWeek(monday).catch(() => null);
        if (!cancelled && fresh) takeFreshOpenWeek(fresh);
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
  // the week has been fetched at least once before. The cached copy isn't
  // live, so Save stays off until SSW's own copy arrives.
  useEffect(() => {
    if (status?.stage !== 'ready' || sswSkipped) return;
    const load = ++weekLoad.current;
    lastWeekRead.current = Date.now();
    forgetEdits();
    setSswError(null);
    setSswSaveNotice(null);
    setSswLive(false);
    let fromSsw = false;
    window.api.ssw.getCached(currentWeekMonday).then((cached) => {
      if (load !== weekLoad.current || fromSsw) return;
      openWeek.current = { ...openWeek.current, week: cached, saved: cached, live: false };
      setSswWeek(cached);
      setSswSavedWeek(cached);
    });
    setSswLoading(true);
    window.api.ssw.fetchWeek(currentWeekMonday)
      .then((w) => { if (load === weekLoad.current && w) { fromSsw = true; showSswWeek(w); } })
      .catch((e) => { if (load === weekLoad.current) setSswError(friendlyError(e, !navigator.onLine)); })
      .finally(() => { if (load === weekLoad.current) setSswLoading(false); });
    return () => { weekLoad.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.stage, sswSkipped, currentWeekMonday]);

  const reloadWeek = async () => {
    const load = ++weekLoad.current;
    lastWeekRead.current = Date.now();
    setSswLoading(true);
    setSswError(null);
    try {
      const w = await window.api.ssw.fetchWeek(openMonday.current);
      if (load === weekLoad.current) showSswWeek(w);
    } catch (e) {
      if (load === weekLoad.current) setSswError(friendlyError(e, !navigator.onLine));
    } finally {
      if (load === weekLoad.current) setSswLoading(false);
    }
  };

  // Coming back to the app, read the open week again when nothing typed here
  // is waiting to be saved, so a save made on another device shows up; and
  // whenever the copy on screen isn't SSW's, so Save comes back once SSW can
  // be reached. At most once a minute. It gives way to any other read or save
  // that starts meanwhile.
  useEffect(() => {
    if (status?.stage !== 'ready' || sswSkipped) return;
    const refresh = () => {
      const { week, live, loading } = openWeek.current;
      if (document.visibilityState !== 'visible' || loading || weekSaving.current) return;
      if (live && editsOf(week).size > 0) return;
      if (Date.now() - lastWeekRead.current < 60_000) return;
      lastWeekRead.current = Date.now();
      const load = weekLoad.current;
      window.api.ssw.fetchWeek(currentWeekMonday)
        .then((w) => {
          if (load !== weekLoad.current || !w) return;
          // Not under someone typing: a time field keeps its draft until it's
          // left, and swapping the week in now would put the old value back.
          // The next return to the app reads again.
          const active = document.activeElement;
          if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) {
            lastWeekRead.current = 0;
            return;
          }
          showSswWeek(w);
          setSswError(null);
        })
        .catch(() => { /* the copy on screen stays; a save reads SSW again first */ });
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.stage, sswSkipped, currentWeekMonday]);

  // Save the open week, unless SSW's copy has changed since it was read here
  // (saved on another device, or on the SSW site): pushing this copy would
  // write its older days back over the newer ones. Then the two are merged on
  // screen for another look instead. A save landing elsewhere in the moment
  // between this read and the push can still be overwritten.
  const saveOpenWeek = async (week: SswWeek): Promise<SswPushResult> => {
    setSswSaving(true);
    setSswSaveNotice(null);
    try {
      const result = await checkAndPushOpenWeek(week);
      setSswSaveNotice(result.ok ? null : result.error);
      return result;
    } finally {
      setSswSaving(false);
    }
  };

  const checkAndPushOpenWeek = async (week: SswWeek): Promise<SswPushResult> => {
    const load = ++weekLoad.current;
    weekSaving.current = true;
    try {
      let fresh: SswWeek | null;
      try {
        fresh = await window.api.ssw.fetchWeek(week.weekStartDate);
      } catch (e) {
        return { ok: false, error: `Not saved: SSW couldn't be checked for changes made elsewhere. ${friendlyError(e, !navigator.onLine)}` };
      }
      if (load !== weekLoad.current) {
        return { ok: false, error: 'Not saved: the week on screen changed while SSW was being checked. Check it, then tap Save again.' };
      }
      if (!fresh || fresh.recordId !== week.recordId) {
        openWeek.current = { ...openWeek.current, live: false };
        setSswLive(false);
        return { ok: false, error: "Not saved: SSW doesn't hold this week the way it was opened here. Load it again from SSW." };
      }
      if (fresh.statusIndex > 0) {
        showSswWeek(fresh);
        return { ok: false, error: 'Not saved: this week has been submitted in SSW since it was opened here.' };
      }
      // A change there that only wrote what this copy already holds (autofill
      // filling the same days on both) is no reason to stop.
      const { saved } = openWeek.current;
      const merged = saved && weekIdOf(saved) === weekIdOf(fresh) && weekChangedSince(saved, fresh)
        ? rebaseWeek(saved, week, fresh, editsOf(week), isoToday())
        : null;
      if (merged && (merged.changedDates.length > 0 || merged.weekFieldsChanged)) {
        openWeek.current = { ...openWeek.current, week: merged.week, saved: fresh, live: true };
        setSswWeek(merged.week);
        setSswSavedWeek(fresh);
        setSswLive(true);
        return { ok: false, error: rebaseNotice(merged) };
      }
      const result = await window.api.ssw.pushWeek(week);
      // Unless another week was picked while the push was out: what's open now
      // is that week, with its own edits and its own read on the way.
      if (result.ok && openMonday.current === week.weekStartDate) {
        // Nothing typed here is waiting any more. Until the Timesheet tab's
        // read of the saved week lands, the copy on screen is this device's
        // rather than SSW's, so it isn't saved from again. What the push wrote
        // is SSW's copy as far as this device knows — days still ahead go in
        // blank, as the save left them — so that a later merge, after a read
        // that never landed, counts these days as this device's own and takes
        // anything newer from SSW.
        forgetEdits();
        const today = isoToday();
        const pushed: SswWeek = {
          ...week,
          dailyRateEdited: undefined,
          days: week.days.map((d) => (d.date > today
            ? { ...d, job: '', startTime: '', endTime: '', lunchStart: '', lunchEnd: '', perDiem: 0, miles: null }
            : d)),
        };
        openWeek.current = { ...openWeek.current, saved: pushed, live: false };
        setSswSavedWeek(pushed);
        setSswLive(false);
      }
      return result;
    } finally {
      weekSaving.current = false;
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
          onResetSetup={async () => { forgetClearedDays(); await window.api.setup.clear(); forgetClearedDays(); forgetSswWeeks(); forgetFriends(); setStatus({ stage: 'needs-carl-credentials' }); }}
        />
      )}

      {tab === 'expenses' && (
        <ExpensesTab bookings={bookings} />
      )}

      {tab === 'friends' && (
        <FriendsTab
          key={friendsGen}
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
          live={sswLive}
          saving={sswSaving}
          saveNotice={sswSaveNotice}
          onLocalEdit={showAutofilledWeek}
          onEdit={editOpenWeek}
          onSave={saveOpenWeek}
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
        onAccountChanged={(which) => {
          // The saved login may be another person's: drop what the old one
          // showed and read the open week again as the new login.
          forgetSswWeeks();
          if (which === 'carl') {
            forgetFriends();
            reloadCarlCaches();
          }
          if (status?.stage === 'ready' && !sswSkipped) void reloadWeek();
        }}
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
          forgetSswWeeks();
          forgetFriends();
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
