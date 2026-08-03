import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { DayHours, LoadExistingResult, LoadMostRecentResult, ProgressReporter, WeekEntry } from '../shared/types';
import { clearStorageState, loadStorageState, saveStorageState } from './session';

const noop: ProgressReporter = () => {};

/** Shared: get a logged-in page on the SSW records list. Returns the page +
 *  context + (possibly newly discovered) appId. */
async function ensureSswRecordsList(
  browser: Browser,
  input: { sswUsername: string; sswPassword: string; sswAppId: string | null },
): Promise<{ ctx: BrowserContext; page: Page; appId: string | null } | { error: string }> {
  const storageState = await loadStorageState('ssw');
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    ...(storageState ? { storageState } : {}),
  });
  const p = await ctx.newPage();
  let appId = input.sswAppId;

  if (appId) {
    await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx?ApplicationID=${appId}`, { waitUntil: 'domcontentloaded' });
  } else {
    await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx`, { waitUntil: 'domcontentloaded' });
  }

  if (p.url().includes('Default.aspx')) {
    await p.goto(SSW_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await p.locator('#ucLogin1_txtUserName').fill(input.sswUsername);
    await p.locator('#ucLogin1_txtPassword').fill(input.sswPassword);
    await Promise.all([
      p.waitForLoadState('domcontentloaded'),
      p.locator('#ucLogin1_loginButton').click(),
    ]);
    if (p.url().includes('Default.aspx')) return { error: 'SpreadsheetWeb login failed' };
    await saveStorageState(ctx, 'ssw');

    if (!appId) {
      await p.waitForTimeout(1000);
      await p.locator('.select2-choice').first().click();
      await p.waitForTimeout(800);
      await p.locator('.select2-result-label, .select2-results li').filter({ hasText: APP_NAME }).first().click();
      await p.waitForLoadState('networkidle').catch(() => {});
      await p.waitForTimeout(1500);
      const urlAppId = new URL(p.url()).searchParams.get('ApplicationID');
      if (urlAppId) appId = urlAppId;
    } else {
      await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx?ApplicationID=${appId}`, { waitUntil: 'domcontentloaded' });
    }
  }
  await p.waitForTimeout(1500);
  return { ctx, page: p, appId };
}

export type LoadExistingInput = {
  sswUsername: string;
  sswPassword: string;
  jobNumber: string;
  weekOfMonday: string;
  sswAppId: string | null;
};

export type LoadMostRecentInput = {
  sswUsername: string;
  sswPassword: string;
  sswAppId: string | null;
};

export type LoadExistingFullResult = LoadExistingResult & { sswAppId?: string };
export type LoadMostRecentFullResult = LoadMostRecentResult & { sswAppId?: string };

const SSW_BASE = 'https://ctts.ctus.com/SpreadsheetWeb';
const SSW_LOGIN_URL = `${SSW_BASE}/Default.aspx`;
const APP_NAME = 'Temp Tech Timesheet-App';

// Read all 7 per-day cells from the currently-open Edit page (Start/End/Meal/
// Per-Diem inputs + the cmbJob_N show select for each row).
async function readRawDays(page: Page): Promise<Array<{ st1: string; st2: string; et1: string; et2: string; pd: string; job: string }>> {
  return page.evaluate(() => {
    const out: Array<{ st1: string; st2: string; et1: string; et2: string; pd: string; job: string }> = [];
    for (let n = 1; n <= 7; n++) {
      const v = (sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value || '';
      const job = (document.querySelector(`#cmbJob_${n}`) as HTMLSelectElement | null)?.value || '';
      out.push({
        st1: v(`input[name="txtST_${n}_1"]`),
        st2: v(`input[name="txtST_${n}_2"]`),
        et1: v(`input[name="txtET_${n}_1"]`),
        et2: v(`input[name="txtET_${n}_2"]`),
        pd: v(`input[name="txtPD_${n}_1"]`),
        job,
      });
    }
    return out;
  });
}

// Convert the raw per-day values to typed DayHours[]. Returns { days, includePerDiem }.
function parseRawDays(
  rawDays: Array<{ st1: string; st2: string; et1: string; et2: string; pd: string; job: string }>,
): { days: WeekEntry['days']; includePerDiem: boolean } {
  let includePerDiem = false;
  const days = rawDays.map((r) => {
    const startTime = parseTime(r.st1);
    const endTime = parseTime(r.et2);
    const mealStart = parseTime(r.st2);
    const mealEnd = parseTime(r.et1);
    const worked = !!(startTime || endTime || mealStart || mealEnd);
    const pdVal = parseFloat((r.pd || '').replace(/[^0-9.]/g, ''));
    const hasPd = !isNaN(pdVal) && pdVal > 0;
    if (hasPd) includePerDiem = true;
    const day: DayHours = {
      worked,
      startTime,
      endTime,
      perDiem: hasPd ? pdVal : null,
      jobNumber: r.job || '',
    };
    if (mealStart) day.mealStart = mealStart;
    if (mealEnd) day.mealEnd = mealEnd;
    return day;
  }) as unknown as WeekEntry['days'];
  return { days, includePerDiem };
}

/** "8:00 AM" -> "08:00", "5:00 PM" -> "17:00", "" -> "". */
function parseTime(s: string): string {
  const t = (s || '').trim();
  if (!t) return '';
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/**
 * Looks up an existing SpreadsheetWeb record for {jobNumber, weekOfMonday}
 * and reads its per-day clock times back into the app's DayHours format.
 * Returns existing=null if no record found.
 */
export async function loadExistingTimesheet(input: LoadExistingInput, report: ProgressReporter = noop): Promise<LoadExistingFullResult> {
  let browser: Browser | null = null;
  let appId: string | null = input.sswAppId;
  try {
    report(5, 'Launching browser');
    browser = await chromium.launch({ headless: true });
    const storageState = await loadStorageState('ssw');
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      ...(storageState ? { storageState } : {}),
    });
    const p = await ctx.newPage();

    // Fast path: direct nav to records list with cached app ID.
    report(15, 'Connecting to SpreadsheetWeb');
    if (appId) {
      await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx?ApplicationID=${appId}`, { waitUntil: 'domcontentloaded' });
    } else {
      await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx`, { waitUntil: 'domcontentloaded' });
    }

    if (p.url().includes('Default.aspx')) {
      report(25, 'Logging in');
      await p.goto(SSW_LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await p.locator('#ucLogin1_txtUserName').fill(input.sswUsername);
      await p.locator('#ucLogin1_txtPassword').fill(input.sswPassword);
      await Promise.all([
        p.waitForLoadState('domcontentloaded'),
        p.locator('#ucLogin1_loginButton').click(),
      ]);
      if (p.url().includes('Default.aspx')) {
        await browser.close();
        return { ok: false, error: 'SpreadsheetWeb login failed' };
      }
      await saveStorageState(ctx, 'ssw');

      if (!appId) {
        await p.waitForTimeout(1000);
        await p.locator('.select2-choice').first().click();
        await p.waitForTimeout(800);
        await p
          .locator('.select2-result-label, .select2-results li')
          .filter({ hasText: APP_NAME })
          .first()
          .click();
        await p.waitForLoadState('networkidle').catch(() => {});
        await p.waitForTimeout(1500);
        const urlAppId = new URL(p.url()).searchParams.get('ApplicationID');
        if (urlAppId) appId = urlAppId;
      } else {
        await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx?ApplicationID=${appId}`, { waitUntil: 'domcontentloaded' });
      }
    }
    await p.waitForTimeout(500);

    // Find record
    report(35, 'Loading your records list');
    // Set page size to "All" so we don't miss rows in pagination, then wait
    // for the grid to settle. Cap the settle wait — selectOption is best-effort.
    await p.locator('select[name="dataGrid_length"]').selectOption('-1').catch(() => {});
    await p.waitForTimeout(800);
    report(45, 'Searching for this week');

    const [year, mm, dd] = input.weekOfMonday.split('-').map(Number);
    const usDateNoPad = `${mm}/${dd}/${year}`;
    // Scan all rows for this WEEK. Find the exact {week, job} match if present;
    // also note any record for the same week under a DIFFERENT show, since one
    // weekly timesheet on C.A.R.L. can hold multiple shows.
    const found = await p.evaluate(
      ({ date, job }) => {
        const rows = document.querySelectorAll('#dataGrid tbody tr');
        let exact: { recordId: string | null; status: string } | null = null;
        let otherShow: { jobNumber: string; status: string; recordId: string } | null = null;
        for (const row of Array.from(rows)) {
          const cells = Array.from(row.querySelectorAll('td')).map((c) => (c.textContent || '').trim());
          if (!(cells[1] || '').startsWith(date)) continue; // not this week
          const editLink = row.querySelector('a[href*="RecordID="]') as HTMLAnchorElement | null;
          const href = editLink?.getAttribute('href') || '';
          const m = href.match(/RecordID=([^&]+)/);
          const rowJob = cells[6] || '';
          const status = cells[4] || '';
          if (rowJob === job) {
            exact = { recordId: m ? m[1] : null, status };
          } else if (!otherShow && rowJob && m) {
            otherShow = { jobNumber: rowJob, status, recordId: m[1] };
          }
        }
        return { exact, otherShow };
      },
      { date: usDateNoPad, job: input.jobNumber },
    );
    const recordId = found.exact?.recordId || null;
    const status = found.exact?.status || '';

    if (!recordId) {
      if (found.otherShow) {
        // Open the other show's record and read its per-day data so the UI
        // can show the locked days with the right show + times.
        report(70, "Reading other show's days");
        const effAppIdForOther = appId || new URL(p.url()).searchParams.get('ApplicationID');
        await p.goto(`${SSW_BASE}/Output.aspx?ApplicationID=${effAppIdForOther}&RecordID=${found.otherShow.recordId}&Act=Edit`, { waitUntil: 'domcontentloaded' });
        // Mirror the main path: blind 5s wait so SSW's JS-heavy form finishes
        // rendering, then attempt the read. readRawDays just queries the DOM
        // and returns empty strings if the form isn't there, so this is safe
        // for the locked-record case too.
        await p.waitForTimeout(5000);
        const authWall = await p.evaluate(() => /not authorized to view this page/i.test(document.body.innerText || '')).catch(() => false);
        let otherDays: WeekEntry['days'] | null = null;
        if (authWall) {
          console.log('[autocarl-load] other-show record is locked (auth wall) — UI will show all 7 days under that show #');
        } else {
          report(85, "Reading other show's hours");
          try {
            const otherRaw = await readRawDays(p);
            const parsed = parseRawDays(otherRaw);
            // Only trust the read if SOMETHING came through (times or a
            // job# on at least one row). All-empty means the form wasn't
            // actually rendered and we should fall back.
            const hasAnyData = parsed.days.some(
              (d) => d.startTime || d.endTime || (d.jobNumber && d.jobNumber !== ''),
            );
            if (hasAnyData) {
              otherDays = parsed.days;
            } else {
              // Debug: dump a screenshot so we can see what SSW actually served
              // for this record (auth wall variant? slow render? unknown).
              const ts = new Date().toISOString().replace(/[:.]/g, '-');
              const shotPath = `/tmp/autocarl-other-show-empty-${ts}.png`;
              await p.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
              console.log('[autocarl-load] other-show form returned all-empty values; screenshot:', shotPath);
            }
          } catch (e) {
            console.log('[autocarl-load] failed to read other-show days:', e instanceof Error ? e.message : e);
          }
        }
        await browser.close();
        report(100, 'Week record exists for another show');
        // Fallback when we can't read the form: blank days but stamp
        // jobNumber on each so the renderer treats them as "owned by other
        // show" and locks/greys the whole row instead of leaving it editable.
        const lockedBlank: DayHours = {
          worked: false,
          startTime: '',
          endTime: '',
          jobNumber: found.otherShow.jobNumber,
        };
        return {
          ok: true,
          existing: null,
          weekRecordOtherShow: {
            ...found.otherShow,
            days: otherDays ?? ([
              lockedBlank, lockedBlank, lockedBlank, lockedBlank, lockedBlank, lockedBlank, lockedBlank,
            ] as unknown as WeekEntry['days']),
          },
          sswAppId: appId || undefined,
        };
      }
      await browser.close();
      report(100, 'No matching record found');
      return { ok: true, existing: null, sswAppId: appId || undefined };
    }

    // Navigate to Edit URL and read field values
    report(60, 'Opening your timesheet');
    const effectiveAppId = appId || new URL(p.url()).searchParams.get('ApplicationID');
    await p.goto(`${SSW_BASE}/Output.aspx?ApplicationID=${effectiveAppId}&RecordID=${recordId}&Act=Edit`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(5000); // form is JS-heavy
    report(85, 'Reading your hours');

    const rawDays = await readRawDays(p);
    console.log('[autocarl-load] raw SSW values per day (col1=IN/st1, col2=LunchOut/st2, col3=LunchIn/et1, col4=OUT/et2):');
    rawDays.forEach((r, i) => {
      const dayName = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i];
      console.log(`   ${dayName}: IN=${r.st1 || '-'} LunchOut=${r.st2 || '-'} LunchIn=${r.et1 || '-'} OUT=${r.et2 || '-'} PD=${r.pd || '-'}`);
    });

    await browser.close();

    const { days, includePerDiem } = parseRawDays(rawDays);

    report(100, 'Loaded');
    return { ok: true, existing: { recordId, days, includePerDiem, status }, sswAppId: appId || undefined };
  } catch (err) {
    await clearStorageState('ssw').catch(() => {});
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    report(100, 'Error');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reads the SSW records list, picks the row with the latest "Last Update",
 *  navigates to its Edit form, and reads the per-day fields back. Lets the
 *  app open on whatever the user was most recently working on without
 *  needing cached show data. */
export async function loadMostRecentTimesheet(input: LoadMostRecentInput, report: ProgressReporter = noop): Promise<LoadMostRecentFullResult> {
  let browser: Browser | null = null;
  try {
    report(5, 'Launching browser');
    browser = await chromium.launch({ headless: true });
    report(15, 'Connecting to SpreadsheetWeb');
    const session = await ensureSswRecordsList(browser, input);
    if ('error' in session) {
      await browser.close();
      report(100, 'Error');
      return { ok: false, error: session.error };
    }
    const { page: p, appId } = session;

    // Set page size to All so we don't miss any rows in pagination.
    report(40, 'Searching your records');
    await p.locator('select[name="dataGrid_length"]').selectOption('-1').catch(() => {});
    await p.waitForTimeout(1500);

    // Sort rows by "Last Update" (column index 3) descending. Date format in
    // those cells is "M/D/YYYY HH:MM:SS AM/PM".
    const top = await p.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#dataGrid tbody tr'));
      const parsed = rows.map((row) => {
        const cells = Array.from(row.querySelectorAll('td')).map((c) => (c.textContent || '').trim());
        const editLink = row.querySelector('a[href*="RecordID="]') as HTMLAnchorElement | null;
        const href = editLink?.getAttribute('href') || '';
        const m = href.match(/RecordID=([^&]+)/);
        return {
          weekOf: cells[1] || '',      // "5/18/2026 12:00:00 AM"
          lastUpdate: cells[3] || '',  // "5/20/2026 11:30:00 AM"
          status: cells[4] || '',      // "Complete" / "Paid" / "" (editable)
          jobNumber: cells[6] || '',
          recordId: m ? m[1] : '',
        };
      }).filter((r) => r.recordId && r.jobNumber);
      parsed.sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());
      return parsed[0] || null;
    });

    if (!top) {
      await browser.close();
      report(100, 'No records found');
      return { ok: true, record: null, sswAppId: appId || undefined };
    }

    // Convert "5/18/2026 12:00:00 AM" → ISO "2026-05-18"
    const wkMatch = top.weekOf.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!wkMatch) {
      await browser.close();
      report(100, 'Error');
      return { ok: false, error: `Could not parse week date: ${top.weekOf}` };
    }
    const [_, mm, dd, yyyy] = wkMatch;
    const weekOfMonday = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

    // Navigate to Edit and read fields
    report(60, 'Opening your timesheet');
    await p.goto(`${SSW_BASE}/Output.aspx?ApplicationID=${appId}&RecordID=${top.recordId}&Act=Edit`, {
      waitUntil: 'domcontentloaded',
    });
    await p.waitForTimeout(5000);
    report(85, 'Reading your hours');

    const rawDays = await p.evaluate(() => {
      const out: Array<{ st1: string; st2: string; et1: string; et2: string; pd: string; job: string }> = [];
      for (let n = 1; n <= 7; n++) {
        const v = (sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value || '';
        const job = (document.querySelector(`#cmbJob_${n}`) as HTMLSelectElement | null)?.value || '';
        out.push({
          st1: v(`input[name="txtST_${n}_1"]`),
          st2: v(`input[name="txtST_${n}_2"]`),
          et1: v(`input[name="txtET_${n}_1"]`),
          et2: v(`input[name="txtET_${n}_2"]`),
          pd: v(`input[name="txtPD_${n}_1"]`),
          job,
        });
      }
      return out;
    });

    await browser.close();

    let includePerDiem = false;
    const days = rawDays.map((r) => {
      const startTime = parseTime(r.st1);
      const endTime = parseTime(r.et2);
      const mealStart = parseTime(r.st2);
      const mealEnd = parseTime(r.et1);
      const worked = !!(startTime || endTime || mealStart || mealEnd);
      const pdVal = parseFloat((r.pd || '').replace(/[^0-9.]/g, ''));
      const hasPd = !isNaN(pdVal) && pdVal > 0;
      if (hasPd) includePerDiem = true;
      const day: DayHours = {
        worked,
        // Mirror C.A.R.L. exactly — never fabricate a time it doesn't have.
        // A worked day with no OUT time (e.g. still on the clock) stays blank.
        startTime,
        endTime,
        perDiem: hasPd ? pdVal : null,
        jobNumber: r.job || '',
      };
      if (mealStart) day.mealStart = mealStart;
      if (mealEnd) day.mealEnd = mealEnd;
      return day;
    }) as unknown as WeekEntry['days'];

    report(100, 'Loaded');
    return {
      ok: true,
      record: { jobNumber: top.jobNumber, weekOfMonday, recordId: top.recordId, days, includePerDiem, status: top.status },
      sswAppId: appId || undefined,
    };
  } catch (err) {
    await clearStorageState('ssw').catch(() => {});
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    report(100, 'Error');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
