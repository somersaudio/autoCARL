import { chromium, type Browser, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CarlProfile, PulledShow, RefreshResult } from '../shared/types';
import { clearStorageState, loadStorageState, saveStorageState } from './session';

// Capture a screenshot + HTML of the current page to /tmp/autocarl-explore-ts/
// so we can diagnose what C.A.R.L. is rendering when scraping fails.
async function dumpDebug(page: Page, tag: string): Promise<string> {
  const dir = '/tmp/autocarl-explore-ts';
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(dir, `scrape-${tag}-${stamp}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const html = await page.content();
    await writeFile(`${base}.html`, html);
    return base;
  } catch {
    return '';
  }
}

export type ScrapeCarlInput = {
  username: string;
  password: string;
  headed?: boolean;
};

const CARL_BASE = 'https://carl.ctus.live';
const CARL_CALENDAR_URL = `${CARL_BASE}/crewcalendar`;

type RowWithId = PulledShow & { bookingId: string };

export async function scrapeCarl(input: ScrapeCarlInput): Promise<RefreshResult> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !input.headed });
    const storageState = await loadStorageState('carl');
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      ...(storageState ? { storageState } : {}),
    });
    const page = await ctx.newPage();

    let profile: CarlProfile | null = null;
    // Booking records keyed by their id (which is also the URL slug used in
    // /crewcalendar/booking-details-1/<id>). Each record carries the show
    // date fields (field_145, field_146, field_222).
    const bookingRecords = new Map<string, Record<string, unknown>>();
    page.on('response', async (res) => {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      const url = res.url();
      if (!url.includes('/webapi/')) return;
      try {
        const body = await res.text();
        const parsed = JSON.parse(body);
        const item = parsed?.item;
        if (item && typeof item === 'object' && item.email && item.name && item.field_191) {
          profile = {
            name: String(item.name),
            userId: String(item.field_191),
            phone: String(item.field_170 || ''),
            email: String(item.email),
          };
        }
        // Booking record: response has a `record` object whose `id` matches
        // a booking detail URL slug, with date fields field_145/146/222.
        const rec = parsed?.record;
        if (rec && typeof rec === 'object' && typeof rec.id === 'string' && (rec.field_145 || rec.field_146 || rec.field_222)) {
          bookingRecords.set(rec.id, rec as Record<string, unknown>);
        }
      } catch {
        /* ignore non-JSON */
      }
    });

    // Go straight to the calendar. If our session is still valid we stay
    // there; if it's expired, C.A.R.L.'s SPA bounces us to /login — but that
    // redirect runs client-side AFTER page.goto resolves, so we can't just
    // check page.url() synchronously here. Instead, wait for either the login
    // form or the bookings table to actually appear, then branch.
    const doLogin = async () => {
      await page.locator('input[name="username"]').fill(input.username);
      await page.locator('input[type="password"]').fill(input.password);
      await page.locator('button:has-text("Sign In")').first().click();
      try {
        await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 20000 });
      } catch (loginErr) {
        const base = await dumpDebug(page, 'login-failed');
        throw new Error(
          `C.A.R.L. login did not advance past /login within 20s — credentials may be wrong or the form changed. ` +
          `Debug dump at ${base}.png / ${base}.html. ` +
          `Original error: ${loginErr instanceof Error ? loginErr.message : String(loginErr)}`,
        );
      }
      await saveStorageState(ctx, 'carl');
    };

    // Initial nav can be slow on the first request of a day — CARL has cold-
    // start delays. Bump to 60s and retry once on timeout before giving up.
    const navigate = async (timeout: number) => {
      await page.goto(CARL_CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout });
    };
    try {
      await navigate(60000);
    } catch (firstErr) {
      console.log('[autocarl] CARL initial nav timed out, retrying:', firstErr instanceof Error ? firstErr.message : firstErr);
      await navigate(60000);
    }

    // Race: login form vs. bookings table. Whichever wins tells us what state
    // we're really in (SPA may still be deciding).
    const loginInput = page.locator('input[name="username"]').first();
    const tableProbe = page.locator(
      'th:has-text("Job Number"), th:has-text("Job #"), th:has-text("Job No."), th:has-text("Job No"), th:has-text("Job")',
    ).first();

    const arrived = await Promise.race([
      loginInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'login' as const).catch(() => null),
      tableProbe.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'table' as const).catch(() => null),
    ]);

    if (arrived === 'login' || page.url().includes('/login')) {
      await doLogin();
    } else if (arrived === null) {
      const base = await dumpDebug(page, 'unknown-state');
      throw new Error(
        `After loading C.A.R.L., neither the login form nor the bookings table appeared within 15s. ` +
        `URL=${page.url()}. Debug dump at ${base}.png / ${base}.html.`,
      );
    }

    // Make sure we're on "Current" tab, not "Archive" — do this BEFORE waiting
    // for the table headers, in case the table is only rendered after the tab
    // is activated.
    const currentBtn = page.locator('button:has-text("Current"), a:has-text("Current")').first();
    if (
      (await currentBtn.count()) &&
      !(await currentBtn.evaluate((el) => /\bactive\b/.test((el as HTMLElement).className)).catch(() => true))
    ) {
      await currentBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    // --- Wait for the bookings table to render (data is fetched async) ---
    // Try a few likely header variants in case C.A.R.L. renamed the column.
    const headerProbes = ['Job Number', 'Job #', 'Job No.', 'Job No', 'Job'];
    const tableHeader = page.locator(
      headerProbes.map((h) => `th:has-text("${h}")`).join(', '),
    ).first();
    try {
      await tableHeader.waitFor({ state: 'visible', timeout: 30000 });
    } catch (waitErr) {
      const base = await dumpDebug(page, 'no-job-header');
      const urlNow = page.url();
      const seenHeaders = await page
        .evaluate(() => Array.from(document.querySelectorAll('th')).map((h) => (h.textContent || '').trim()).filter(Boolean))
        .catch(() => [] as string[]);
      throw new Error(
        `Timed out waiting for the bookings table on C.A.R.L. ` +
        `URL=${urlNow}. Headers seen on page: [${seenHeaders.join(' | ') || '(none)'}]. ` +
        `Debug dump at ${base}.png / ${base}.html. ` +
        `Original error: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`,
      );
    }

    // --- Scrape rows including booking IDs (from detail page hrefs in each row) ---
    const rows: RowWithId[] = await page.evaluate(() => {
      const JOB_HEADER_VARIANTS = ['Job Number', 'Job #', 'Job No.', 'Job No', 'Job'];
      const tables = Array.from(document.querySelectorAll('table'));
      let target: HTMLTableElement | null = null;
      let jobHeader = '';
      for (const t of tables) {
        const headers = Array.from(t.querySelectorAll('th')).map((h) => (h.textContent || '').trim());
        const match = JOB_HEADER_VARIANTS.find((v) => headers.includes(v));
        if (match) {
          target = t as HTMLTableElement;
          jobHeader = match;
          break;
        }
      }
      if (!target) return [];
      const headerCells = Array.from(target.querySelectorAll('th')).map((h) => (h.textContent || '').trim());
      const get = (cells: string[], label: string) => {
        const i = headerCells.indexOf(label);
        return i >= 0 ? cells[i] || '' : '';
      };
      const out: RowWithId[] = [];
      for (const r of Array.from(target.querySelectorAll('tbody tr'))) {
        const cells = Array.from(r.querySelectorAll('td')).map((c) => (c.textContent || '').trim());
        if (!cells.length) continue;
        const detailLink = r.querySelector('a[href*="booking-details-1/"]') as HTMLAnchorElement | null;
        const bookingId = detailLink ? (detailLink.getAttribute('href') || '').split('booking-details-1/')[1] || '' : '';
        const jobNumber = get(cells, jobHeader);
        if (!jobNumber) continue;
        out.push({
          jobNumber,
          task: get(cells, 'Task'),
          jobName: get(cells, 'Job Name'),
          status: get(cells, 'Status'),
          notes: get(cells, 'Notes'),
          dateRange: get(cells, 'Dates'),
          laborCoordinator: get(cells, 'Labor Coordinator'),
          projectManager: get(cells, 'Project Manager'),
          position: '',
          perDiem: null,
          perDiemIncluded: false,
          city: '',
          state: '',
          scheduledStart: null,
          scheduledEnd: null,
          bookingId,
        });
      }
      return out;
    });

    // --- For each show, visit its detail page and extract position (field_408) ---
    // Use polling waitForFunction with the booking ID baked into the check, so
    // we don't accept stale text left over from a prior detail-page render.
    for (const row of rows) {
      if (!row.bookingId) continue;
      try {
        await page.goto(`${CARL_BASE}/crewcalendar/booking-details-1/${row.bookingId}`, {
          waitUntil: 'domcontentloaded',
        });

        // Poll until: (a) we're on this booking's URL, (b) field_408 has text.
        const positionText = (await page
          .waitForFunction(
            (bookingId) => {
              if (!location.pathname.endsWith('/' + bookingId)) return null;
              const el = document.querySelector('af-data-table-field[column*="field_408"] span');
              const t = el?.textContent?.trim();
              return t ? t : null;
            },
            row.bookingId,
            { timeout: 25000, polling: 400 },
          )
          .then((h) => h.jsonValue())
          .catch(() => null)) as string | null;

        if (positionText) {
          // "05 - Outdoor Audio Engineer" → "Outdoor Audio Engineer"
          row.position = positionText.replace(/^[A-Za-z0-9]+\s*-\s*/, '');
        }

        // Per-diem amount: find a leaf element with text "$XX" whose preceding
        // sibling (within 5 ancestors) has text "Per diem rate". The DOM doesn't
        // render field_348 as a labeled <af-data-table-field column="…field_348">
        // — it renders as a generic table cell, so we anchor on the label text.
        try {
          await page.waitForTimeout(500);
          const amount = await page.evaluate(() => {
            const all = document.querySelectorAll('*');
            for (const el of Array.from(all)) {
              if (el.children.length > 0) continue;
              const t = (el.textContent || '').trim();
              const m = t.match(/^\$\s?(\d+(?:\.\d+)?)$/);
              if (!m) continue;
              let walker: Element | null = el;
              for (let i = 0; i < 5 && walker; i++) {
                const prev = walker.previousElementSibling;
                if (prev && /per\s*diem\s*rate/i.test((prev.textContent || ''))) {
                  return parseFloat(m[1]);
                }
                walker = walker.parentElement;
              }
            }
            return null;
          });
          if (amount != null && amount > 0) row.perDiem = amount;
        } catch { /* leave null */ }

        // --- Scheduled dates: field_145 (show start) → field_222 (travel return) ---
        // The detail page's API response landed in bookingRecords as a side
        // effect of the navigation; look it up by the booking id slug.
        const rec = bookingRecords.get(row.bookingId);
        if (rec) {
          const start = typeof rec.field_145 === 'string' ? rec.field_145 : null;
          // Prefer travel-return day; fall back to show-end if travel isn't set.
          const end = typeof rec.field_222 === 'string' && rec.field_222
            ? rec.field_222
            : typeof rec.field_146 === 'string' ? rec.field_146 : null;
          row.scheduledStart = start;
          row.scheduledEnd = end;
        }

        // --- City/state from header + "Per Diem" indicator from travel requirements ---
        // Header pattern: "<jobNumber> - <City>, <ST>" appears as text somewhere
        // near the top of the detail page.
        try {
          const extracted = await page.evaluate((jobNumber: string) => {
            const bodyText = document.body.innerText || '';
            // Look for the exact "<jobNumber> - City, ST" pattern.
            const escaped = jobNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`${escaped}\\s*-\\s*([^,\\n]+?),\\s*([A-Z]{2})\\b`);
            const m = bodyText.match(re);
            const city = m ? m[1].trim() : '';
            const state = m ? m[2].trim() : '';
            // Per-diem inclusion: any text matching "Per Diem" inside a Travel-
            // or Requirements-labeled section. Fall back to whole-page text scan.
            const perDiemIncluded = /\bper\s*diem\b/i.test(bodyText);
            return { city, state, perDiemIncluded };
          }, row.jobNumber);
          row.city = extracted.city;
          row.state = extracted.state;
          row.perDiemIncluded = extracted.perDiemIncluded;
        } catch { /* leave defaults */ }

      } catch {
        /* leave row.position empty on error */
      }
    }

    // Give the profile XHR a moment if it hasn't landed yet
    if (!profile) await page.waitForTimeout(2000);
    if (!profile) {
      return { ok: false, error: 'Could not find profile data in C.A.R.L. API responses.' };
    }

    // Strip the bookingId before returning (internal-only)
    const shows: PulledShow[] = rows.map(({ bookingId: _ignored, ...rest }) => rest);
    return { ok: true, shows, profile };
  } catch (err) {
    // If the saved session was bad, wipe it so next run does a fresh login.
    await clearStorageState('carl').catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (browser) await browser.close();
  }
}
