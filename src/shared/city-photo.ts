import type { CityPhoto } from './types';

// The worker's answer to GET /v1/city-photo, checked before the app keeps it:
// a photo with https links (or plain http from a worker running on this
// machine, for testing), else null.
export function cleanCityPhoto(raw: unknown): CityPhoto | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = (k: string) => (typeof r[k] === 'string' ? r[k] as string : '');
  const num = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? r[k] as number : 0);
  const https = (k: string) =>
    (/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(text(k)) ? text(k) : '');
  const src = https('src');
  if (!src) return null;
  return {
    place: text('place'),
    title: text('title'),
    artist: text('artist'),
    license: text('license'),
    licenseUrl: https('licenseUrl'),
    pageUrl: https('pageUrl'),
    width: num('width'),
    height: num('height'),
    focus: Math.min(100, Math.max(0, typeof r.focus === 'number' && Number.isFinite(r.focus) ? r.focus : 50)),
    src,
    srcLarge: https('srcLarge'),
  };
}

// How long the app keeps an answer before asking again: a photo for a week,
// "no photo" for a day.
export const CITY_PHOTO_KEEP_MS = 7 * 86_400_000;
export const CITY_PHOTO_MISS_KEEP_MS = 86_400_000;

export function cityPhotoKey(city: string, state: string): string {
  return `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
}

// Where the renderer remembers the photo on screen (see city-view.ts). The
// web app's log out drops it with the rest of the last person's gigs.
export const CITY_VIEW_LAST_KEY = 'autocarl.cityView.last';
