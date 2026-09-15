import type { SswDay, SswWeek } from './types';
import { parseTime } from './hours';
import { savedDaysOff } from './daysOff';

// Two copies of one SSW week, compared on what a save writes. Hours SSW works
// out (reg/OT/DT/total) and fields a save never sends are left out.
const DAY_FIELDS = ['job', 'startTime', 'endTime', 'lunchStart', 'lunchEnd', 'perDiem', 'miles'] as const;
const WEEK_FIELDS = ['dailyRate', 'phone', 'email', 'comments', 'position', 'projectManager', 'laborCoordinator', 'californiaCheck'] as const;

// A field changed by hand on this device, as opposed to one autofill filled:
// `2026-09-14:startTime` for a day's, `week:dailyRate` for the week's.
export const dayEditKey = (date: string, field: string) => `${date}:${field}`;
export const weekEditKey = (field: string) => `week:${field}`;

// The same value written two ways counts as the same: "8:00 AM" and "8:00 am",
// a rate of "650" and "650.00", a job typed in lower case.
function norm(field: string, v: unknown): string {
  switch (field) {
    case 'startTime': case 'endTime': case 'lunchStart': case 'lunchEnd': {
      const s = String(v ?? '').trim();
      if (!s) return '';
      const minutes = parseTime(s);
      return minutes === null ? s.toLowerCase() : String(minutes);
    }
    case 'perDiem': case 'miles': case 'dailyRate':
      return String(Number(v) || 0);
    case 'job':
      return String(v ?? '').trim().toUpperCase();
    case 'californiaCheck':
      return v ? 'true' : '';
    default:
      return String(v ?? '').trim();
  }
}

const same = (field: string, a: unknown, b: unknown) => norm(field, a) === norm(field, b);

// Two copies of a day holding the same thing, on the fields a save writes.
export const sameDay = (a: SswDay, b: SswDay) => DAY_FIELDS.every((f) => same(f, a[f], b[f]));

// Whether SSW's copy now differs from the copy this device loaded: someone
// saved the week from somewhere else in between.
export function weekChangedSince(loaded: SswWeek, now: SswWeek): boolean {
  if (WEEK_FIELDS.some((f) => !same(f, loaded[f], now[f]))) return true;
  const loadedDays = new Map(loaded.days.map((d) => [d.date, d]));
  return now.days.some((d) => {
    const before = loadedDays.get(d.date);
    return !before || DAY_FIELDS.some((f) => !same(f, before[f], d[f]));
  });
}

// Only what the other save changed to something this device's copy doesn't
// already hold is counted: a save elsewhere that wrote what autofill filled in
// here too changes nothing on screen.
export type WeekRebase = {
  week: SswWeek;
  changedDates: string[];     // days the other save changed to something else
  weekFieldsChanged: boolean; // the same for rate, phone, email, crew or comments
  conflictDates: string[];    // days where an edit made here kept over a different one made there
};

// SSW's copy as it is now (`theirs`), with this device's unsaved edits on top.
// `today` is the local date, YYYY-MM-DD.
//
// Days up to today go whole, job, times, lunch and per diem together, so a
// merge never pairs one device's show with the other's per diem or keeps an
// end time without its start. A day the other save changed since the copy here
// was loaded comes over from SSW, and so does one it left empty as a day off:
// emptied, it looks just like a day nobody filled, and keeping this device's
// autofilled hours would pay a day that wasn't worked. A day whose show or
// times were typed here keeps this device's version instead, and counts as a
// conflict when SSW's changed to something different. A lunch, per diem or
// mileage typed here rides on top of SSW's day when SSW holds the same show
// with hours — the day itself still comes from one device, so nothing is
// paired wrong, and hours nobody here typed aren't kept over hours saved
// elsewhere. Any other day keeps this device's version, autofill included.
//
// Days still ahead aren't saved, so this device's value (the preview of an
// upcoming show) stays field by field unless SSW's changed. The week's own
// fields work the same way; a rate edited by hand here keeps its edit marker.
export function rebaseWeek(
  base: SswWeek,
  mine: SswWeek,
  theirs: SswWeek,
  edits: ReadonlySet<string>,
  today: string,
): WeekRebase {
  const pick = (key: string, field: string, b: unknown, m: unknown, t: unknown) => {
    const changedThere = !same(field, t, b);
    const differs = changedThere && !same(field, t, m);
    if (edits.has(key)) return { value: m, changedThere: differs, conflict: differs };
    return { value: changedThere ? t : m, changedThere: differs, conflict: false };
  };

  const baseDays = new Map(base.days.map((d) => [d.date, d]));
  const mineDays = new Map(mine.days.map((d) => [d.date, d]));
  const offWhenLoaded = savedDaysOff(base.days, today);
  const offNow = savedDaysOff(theirs.days, today);
  const changedDates: string[] = [];
  const conflictDates: string[] = [];
  const days = theirs.days.map((t) => {
    const b = baseDays.get(t.date) ?? t;
    const m = mineDays.get(t.date) ?? t;
    if (t.date <= today) {
      const changedThere = !sameDay(t, b) || (offNow.has(t.date) && !offWhenLoaded.has(t.date));
      const differs = changedThere && !sameDay(t, m);
      if (differs) changedDates.push(t.date);
      const edited = DAY_FIELDS.filter((f) => edits.has(dayEditKey(t.date, f)));
      if (edited.length === 0) return changedThere ? { ...t } : { ...m };
      const ridesOnTop = changedThere
        && !edited.some((f) => f === 'job' || f === 'startTime' || f === 'endTime')
        && same('job', t.job, m.job)
        && !!(t.startTime || t.endTime);
      if (!ridesOnTop) {
        if (differs) conflictDates.push(t.date);
        return { ...m };
      }
      const kept = new Set<string>(edited);
      // A lunch goes in as a pair: half of one and half of the other is no lunch.
      if (kept.has('lunchStart') || kept.has('lunchEnd')) { kept.add('lunchStart'); kept.add('lunchEnd'); }
      const onTop = { ...t } as Record<string, unknown>;
      for (const f of kept) onTop[f] = (m as unknown as Record<string, unknown>)[f];
      return onTop as SswDay;
    }
    const day = { ...t };
    let changed = false;
    for (const f of DAY_FIELDS) {
      const r = pick(dayEditKey(t.date, f), f, b[f], m[f], t[f]);
      (day as Record<string, unknown>)[f] = r.value;
      changed ||= r.changedThere;
    }
    if (changed) changedDates.push(t.date);
    return day;
  });

  const week: SswWeek = { ...theirs, days, dailyRateEdited: undefined };
  let weekFieldsChanged = false;
  for (const f of WEEK_FIELDS) {
    const r = pick(weekEditKey(f), f, base[f], mine[f], theirs[f]);
    (week as Record<string, unknown>)[f] = r.value;
    weekFieldsChanged ||= r.changedThere;
  }
  // The edit marker goes with a rate edited here, which the save must still write.
  if (edits.has(weekEditKey('dailyRate')) && mine.dailyRateEdited) week.dailyRateEdited = true;
  return { week, changedDates, weekFieldsChanged, conflictDates };
}
