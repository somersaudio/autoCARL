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

    await page.goto(CARL_CALENDAR_URL, { waitUntil: 'domcontentloaded' });

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

        // Per diem (field_348). Only present if travelRequired includes "Per Diem".
        // Wait briefly — the field is conditionally rendered after the data load.
        try {
          await page.waitForTimeout(500);
          const perDiemText = await page
            .locator('af-data-table-field[column*="field_348"] span')
            .first()
            .textContent({ timeout: 3000 })
            .catch(() => '');
          if (perDiemText) {
            const num = parseFloat(perDiemText.replace(/[^0-9.]/g, ''));
            if (!isNaN(num) && num > 0) row.perDiem = num;
          }
        } catch { /* show has no per diem — leave null */ }
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
