// What the Timesheet tab remembers about days on this device, filed under the
// week's SSW user: days emptied by hand, and days whose per diem was. Shared
// with the paycheck estimator, which prices a day without per diem as such.

// Days the user emptied by hand, as ISO dates, so autofill leaves them empty.
// A booked day with no times is otherwise filled with the default hours, which
// made a day off impossible to save: clear both times and 8:00 am – 6:00 pm
// came straight back, and a save wrote those hours to SSW. Kept in this
// device's storage, not only in the tab's state, because the tab unmounts on
// every tab switch and a save reloads the week with the day blank; either
// would have filled it again. Filed under the week's SSW user, so someone else
// signing in on this device doesn't inherit these days off, and forgotten on
// Log out and Reset. A date leaves the list once its day gets a time again.
// Other devices can't see this list; they read a saved day off from SSW itself
// (shared/daysOff.ts).
export const CLEARED_DAYS_KEY = 'autocarl.timesheetClearedDays';
// Days whose per diem the user emptied by hand, the same way: a worked day
// with a show and no per diem otherwise gets the GSA rate, so emptying the box
// put the rate straight back and a day with no per diem couldn't be saved. A
// date leaves the list once its day gets an amount again or a new show with a
// rate of its own.
export const NO_PER_DIEM_KEY = 'autocarl.timesheetNoPerDiem';
// The newest dates kept per user. Pruned by count, not age, so a day cleared on
// an old week that was never submitted still sticks.
const CLEARED_DAYS_MAX = 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// One user-filed list of dates in this device's storage.
function dateListStore(key: string) {
  // Changes this session couldn't write to storage, per user: date -> in the
  // list (true) or out of it (false). They're laid over whatever storage holds
  // until a write succeeds. Only the changes, never a whole list, so a copy
  // held here can't undo dates another window stored in the meantime.
  const pending = new Map<string, Map<string, boolean>>();

  // Every user's stored list, or null when storage can't be reached. A stored
  // value that isn't valid JSON reads as empty and is replaced on the next write.
  const readStore = (): Record<string, unknown> | null => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return null;
    }
    try {
      const stored: unknown = JSON.parse(raw || '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };

  const storedDates = (store: Record<string, unknown> | null, owner: string): Set<string> => {
    const stored = store?.[owner];
    return new Set(Array.isArray(stored)
      ? stored.filter((d): d is string => typeof d === 'string' && ISO_DATE.test(d))
      : []);
  };

  return {
    read(owner: string): Set<string> {
      const dates = storedDates(readStore(), owner);
      pending.get(owner)?.forEach((on, date) => {
        if (on) dates.add(date);
        else dates.delete(date);
      });
      return dates;
    },

    // Put one date in the list (true) or take it out (false).
    set(owner: string, date: string, on: boolean): void {
      const changes = new Map<string, boolean>(pending.get(owner) ?? []);
      changes.set(date, on);
      try {
        const store = readStore();
        if (!store) throw new Error('storage unavailable');
        const dates = storedDates(store, owner);
        changes.forEach((c, d) => {
          if (c) dates.add(d);
          else dates.delete(d);
        });
        const kept = Array.from(dates).sort().slice(-CLEARED_DAYS_MAX);
        if (kept.length > 0) store[owner] = kept;
        else delete store[owner];
        localStorage.setItem(key, JSON.stringify(store));
        pending.delete(owner);
      } catch {
        pending.set(owner, changes);
      }
    },

    forget(): void {
      pending.clear();
      try {
        localStorage.removeItem(key);
      } catch { /* nothing stored */ }
    },

    // Another window logged out or reset: changes this one never managed to
    // store go with that session.
    dropPending(): void {
      pending.clear();
    },
  };
}

export const clearedDaysStore = dateListStore(CLEARED_DAYS_KEY);
export const noPerDiemStore = dateListStore(NO_PER_DIEM_KEY);

// For Log out and Reset: whoever signs in next starts with no days off here,
// and no days without per diem.
export function forgetClearedDays(): void {
  clearedDaysStore.forget();
  noPerDiemStore.forget();
}

// Every date without per diem across the users whose weeks are cached here
// (in practice one), for the paycheck estimator.
export function noPerDiemDates(owners: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const owner of new Set(owners)) if (owner) noPerDiemStore.read(owner).forEach((d) => out.add(d));
  return out;
}
