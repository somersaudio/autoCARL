# AUTOcarl

Desktop app for crew timecard entry. Reads your bookings from C.A.R.L. and
writes your timesheet to SSW, so neither has to be filled in by hand.

## Design goals

- **Open → bookings in under a second.** No CARL scrape on startup. Bookings
  come from the user's personal iCal feed (sub-second HTTPS fetch) plus a
  local cache that paints instantly while the refresh runs in the background.
- **CARL is touched exactly once at onboarding.** A headless Playwright session
  signs in, clicks "Calendar Instructions", extracts the iCal URL, and stores
  it in the OS keychain. After that, CARL is not opened again.
- **Optimistic UI for writes.** Saves to SSW are applied in the background —
  the UI reflects the intended state immediately and surfaces a toast + retry
  if a save fails.

## What it does

1. **Onboarding:** email + password → discover and store the iCal URL.
2. **Bookings:** cached-first list with background refresh, show logos, flight
   itineraries, venue and per-diem lookup.
3. **Timesheet:** week editor that reads and writes SSW, with GSA per-diem
   autofill.
4. **Earnings:** projects what an upcoming gig is worth — take-home and per
   diem — from your day rate and tax profile. Display only; never written back
   to SSW.

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

- **Keychain (keytar):** CARL password, SSW password, discovered iCal URL.
- **App data dir:** `config.json` (no secrets), plus `bookings.json`,
  `flights.json`, `ssw-weeks.json` and `contacts.json` caches.

## Tax tables

`src/shared/taxes.ts` carries the federal brackets, standard deductions,
Social Security wage base and additional-Medicare thresholds behind the
earnings estimates. The IRS publishes the next year's figures each autumn —
update that one file and bump `TAX_YEAR`. Nothing outside it needs to change,
and Settings displays the year in use so a stale table is visible.

## History

This is the iCal-first rewrite that replaced the original scrape-on-startup
app at v0.9.0. The predecessor's source is in git history up to `c958b85` if
anything needs referring back to.

On first launch the app migrates credentials and store files off their older
names automatically, so existing installs keep their logins, settings and
caches. That migration code — `migrateCredentials` in `src/main/credentials.ts`
and `migrateStoreFiles` in `src/main/store.ts` — can be deleted once every
install has been opened at least once.
