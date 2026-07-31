# AUTOcarl v2

Fresh rewrite. The v1 app at `../src/` stays in place for reference; v2 is a
self-contained Electron project under this directory.

## Design goals

- **Open → bookings in under a second.** No CARL scrape on startup. Bookings
  come from the user's personal iCal feed (sub-second HTTPS fetch) plus a
  local cache that paints instantly while the refresh runs in the background.
- **CARL is touched exactly once at onboarding.** A headless Playwright session
  signs in, clicks "Calendar Instructions", extracts the iCal URL, and stores
  it in the OS keychain. After that, CARL is not opened again.
- **Optimistic UI for writes (later slice).** Saves to SSW will be queued and
  applied by a persistent hidden window in the background — the UI reflects
  the intended state immediately and surfaces a toast + retry if a queued
  save fails.

## Current scope (read path only)

1. Onboarding: email + password → discover & store iCal URL.
2. Bookings list: cached-first, background refresh, logo per show.

The SSW write path, week editor, GSA per-diem lookup, and sync queue are
intentionally out of scope for this slice.

## Run

```
npm install
npm run dev
```

## Secrets

`src/main/secrets.ts` is gitignored. Populate it locally with logo.dev keys:

```ts
export const LOGODEV_SECRET = 'sk_...';
export const LOGODEV_PUBLISHABLE = 'pk_...';
```

## Storage

- **Keychain (keytar):** CARL password, discovered iCal URL.
- **App data dir:** `autocarl2-config.json` (no secrets) and
  `autocarl2-bookings.json` (cached read-only schedule).

v2 uses its own `AUTOcarl2-` keytar service prefix and its own JSON files so
it can coexist with v1 without touching its data.
