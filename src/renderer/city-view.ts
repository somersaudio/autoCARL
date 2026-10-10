import type { Booking, CityPhoto } from '../shared/types';
import { CITY_VIEW_LAST_KEY } from '../shared/city-photo';

// Which city the City View theme shows, and the photo on screen.

// The gig whose city is on screen: the one in progress today (on a
// changeover day, the one wrapping up), else the next one coming up.
// Confirmed gigs win over pending requests; a request only counts when no
// confirmed gig is in progress or ahead.
export function cityViewGig(bookings: Booking[], todayIso: string): Booking | null {
  const isRequest = (b: Booking) => /\brequest/i.test(b.status || '');
  const ahead = bookings
    .filter((b) => b.endDate >= todayIso && (b.city || '').trim())
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));
  for (const pool of [ahead.filter((b) => !isRequest(b)), ahead.filter(isRequest)]) {
    const gig = pool.find((b) => b.startDate <= todayIso) || pool[0];
    if (gig) return gig;
  }
  return null;
}

// The photo on screen: which place it's for, and the exact image that was
// loaded, so the next launch paints that same file straight from the cache
// instead of waiting for the bookings. Settings credits it from here too.
// Remembered per device, so plain localStorage; losing it only costs that
// first moment.
export type ShownPhoto = { key: string; photo: CityPhoto; src: string };

export function placeKey(city: string, state: string): string {
  return `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
}

function readStored(): ShownPhoto | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CITY_VIEW_LAST_KEY) || 'null') as ShownPhoto | null;
    return raw && typeof raw.key === 'string' && typeof raw.src === 'string' && typeof raw.photo?.src === 'string'
      ? raw
      : null;
  } catch {
    return null;
  }
}

let shown: ShownPhoto | null = readStored();
const listeners = new Set<() => void>();

export function shownCityPhoto(): ShownPhoto | null {
  return shown;
}

export function onShownCityPhoto(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// null when the starfield is up instead: then there's nothing to credit, and
// the next launch shouldn't open on a city the user has left.
export function setShownCityPhoto(next: ShownPhoto | null): void {
  shown = next;
  try {
    if (next) localStorage.setItem(CITY_VIEW_LAST_KEY, JSON.stringify(next));
    else localStorage.removeItem(CITY_VIEW_LAST_KEY);
  } catch { /* the next launch just waits */ }
  for (const fn of listeners) fn();
}

// The photo's size to load: the ~3840px one when the screen draws the photo
// wider than ~2200 device pixels (a phone in portrait does, since the photo
// covers its height), else the ~1920px one.
export function photoSrc(photo: CityPhoto): string {
  const dpr = window.devicePixelRatio || 1;
  const aspect = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1.5;
  const drawnWidth = Math.max(window.innerWidth * dpr, window.innerHeight * dpr * aspect);
  return photo.srcLarge && drawnWidth > 2200 ? photo.srcLarge : photo.src;
}
