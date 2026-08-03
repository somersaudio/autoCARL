import { chromium, type Browser } from 'playwright';
import { app } from 'electron';
import { join } from 'node:path';
import type { PulledShow, ProgressReporter, SubmitResult, WeekEntry, CarlProfile } from '../shared/types';
import { clearStorageState, loadStorageState, saveStorageState } from './session';

const noopReport: ProgressReporter = () => {};

export type FillTimesheetInput = {
  sswUsername: string;
  sswPassword: string;
  show: PulledShow;
  profile: CarlProfile;
  entry: WeekEntry;
  dailyRate: number | null;
  // If set, skip the records-list lookup and go straight to Edit on this record.
  // If null, search the records list for {jobNumber, weekOfMonday}; if found use
  // Edit, else use Add New.
  existingRecordId: string | null;
  // Cached SSW Application ID. If set + session valid, we skip the
  // login → select-application step and navigate directly.
  sswAppId: string | null;
  // 'normal' (default): single-show week, use #btnCopyJob to assign the show
  // to all 7 days at once.
  // 'merge-into-existing': editing a weekly record that already has other
  // shows on other days. Skip #btnCopyJob (it would clobber those days) and
  // set cmbJob_N only on the worked days we're filling.
  mode?: 'normal' | 'merge-into-existing';
};

export type FillTimesheetResult = SubmitResult & { sswAppId?: string };

const SSW_BASE = 'https://ctts.ctus.com/SpreadsheetWeb';
const SSW_LOGIN_URL = `${SSW_BASE}/Default.aspx`;
const APP_NAME = 'Temp Tech Timesheet-App';

/**
 * Drives SpreadsheetWeb invisibly: logs in, opens the entry form, fills all
 * fields with C.A.R.L. data + the user's clock times, then clicks Save —
 * which creates a record at the employee-submitted stage. Labor Coordinator
 * review / approval / payroll happen on the website by humans afterward.
 */
export async function fillTimesheet(input: FillTimesheetInput, report: ProgressReporter = noopReport): Promise<FillTimesheetResult> {
  let browser: Browser | null = null;
  let page: import('playwright').Page | null = null;
  let appId: string | null = input.sswAppId;

  const screenshotOnError = async (name: string): Promise<string | undefined> => {
    if (!page) return undefined;
    try {
      const path = join(app.getPath('userData'), `ssw-${name}-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: true });
      return path;
    } catch {
      return undefined;
    }
  };

  try {
    report(5, 'Launching browser');
    browser = await chromium.launch({ headless: true });
    const storageState = await loadStorageState('ssw');
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      ...(storageState ? { storageState } : {}),
    });
    page = await ctx.newPage();
    const p = page;

    // Surface browser console messages + errors + dialogs + network activity.
    p.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('[autocarl]') || msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`   [page-${msg.type()}] ${t}`);
      }
    });
    p.on('pageerror', (err) => console.log('   [page-error]', err.message));
    p.on('dialog', async (dialog) => {
      console.log(`   [dialog ${dialog.type()}] ${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });
    // Track requests/responses that look save-related (POST/PUT, or to webapi).
    p.on('request', (req) => {
      const m = req.method();
      if (m === 'POST' || m === 'PUT') {
        console.log(`   [req ${m}] ${req.url().slice(-100)}`);
      }
    });
    p.on('response', async (res) => {
      const req = res.request();
      const m = req.method();
      if (m !== 'POST' && m !== 'PUT') return;
      console.log(`   [res ${res.status()} ${m}] ${res.url().slice(-100)}`);
      try {
        const body = (await res.text()).slice(0, 300);
        if (body) console.log(`     body: ${body}`);
      } catch { /* ignore */ }
    });

    // 1. Get to the records list. If session is valid + we have the app ID,
    //    one direct navigation lands us there. Else we log in + select app.
    report(15, 'Connecting to SpreadsheetWeb');
    if (appId) {
      await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx?ApplicationID=${appId}`, { waitUntil: 'domcontentloaded' });
    } else {
      await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx`, { waitUntil: 'domcontentloaded' });
    }

    // Bounced to login? Do the full login + select app dance, then cache appId.
    if (p.url().includes('Default.aspx')) {
      await p.goto(SSW_LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await p.locator('#ucLogin1_txtUserName').fill(input.sswUsername);
      await p.locator('#ucLogin1_txtPassword').fill(input.sswPassword);
      await Promise.all([
        p.waitForLoadState('domcontentloaded'),
        p.locator('#ucLogin1_loginButton').click(),
      ]);
      if (p.url().includes('Default.aspx')) {
        const screenshotPath = await screenshotOnError('login-failed');
        await browser.close();
        return { ok: false, error: 'SpreadsheetWeb login failed', screenshotPath };
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
    await p.waitForTimeout(1500);

    // 3. Decide: edit existing record or create new?
    // Look up by {jobNumber, weekOfMonday} in the records list unless caller
    // already gave us the recordId.
    let recordId: string | null = input.existingRecordId;
    if (!recordId) {
      // Set "Show entries" dropdown to All (-1) so all rows are present
      await p.locator('select[name="dataGrid_length"]').selectOption('-1').catch(() => {});
      await p.waitForTimeout(1500);

      const [, mm, dd] = input.entry.weekOfMonday.split('-').map(Number);
      const [year] = input.entry.weekOfMonday.split('-').map(Number);
      const usDateNoPad = `${mm}/${dd}/${year}`;
      recordId = await p.evaluate(
        ({ date, job }) => {
          const rows = document.querySelectorAll('#dataGrid tbody tr');
          for (const row of Array.from(rows)) {
            const cells = Array.from(row.querySelectorAll('td')).map((c) => (c.textContent || '').trim());
            // Headers we saw: Name, Week of, Date Created, Last Update, Status, Actions, Job#, Labor Coord
            if ((cells[1] || '').startsWith(date) && (cells[6] || '') === job) {
              const editLink = row.querySelector('a[href*="RecordID="]') as HTMLAnchorElement | null;
              const href = editLink?.getAttribute('href') || '';
              const m = href.match(/RecordID=([^&]+)/);
              return m ? m[1] : null;
            }
          }
          return null;
        },
        { date: usDateNoPad, job: input.show.jobNumber },
      );
      console.log(`[autocarl] existing record lookup: ${recordId ? `found ${recordId}` : 'not found, will create new'}`);
    }

    // Navigate to entry form (Edit if we have a record, else Add New)
    report(40, recordId ? 'Opening existing record' : 'Creating new record');
    const effectiveAppId = appId || new URL(p.url()).searchParams.get('ApplicationID');
    if (recordId) {
      await p.goto(`${SSW_BASE}/Output.aspx?ApplicationID=${effectiveAppId}&RecordID=${recordId}&Act=Edit`, { waitUntil: 'domcontentloaded' });
    } else {
      await p.goto(`${SSW_BASE}/Output.aspx?ApplicationID=${effectiveAppId}`, { waitUntil: 'domcontentloaded' });
    }
    await p.waitForTimeout(5000); // entry form is JS-heavy; lets jQuery + Select2 finish init

    // Locked-record check: if the record has been submitted/paid, SSW serves
    // an "authorization" page instead of the editable form. Detect that and
    // bail with a friendly error before we try (and fail) to find #btnSave.
    const lockedDetected = await p.evaluate(() => {
      const text = (document.body.innerText || '').toLowerCase();
      return text.includes('not authorized to view this page')
        || text.includes('does not have the rights to create records')
        || text.includes('view and edit this specific record');
    });
    if (lockedDetected) {
      const screenshotPath = await screenshotOnError('locked-record');
      await browser.close();
      report(100, 'Locked on SpreadsheetWeb');
      return {
        ok: false,
        error:
          'This timesheet is locked on SpreadsheetWeb (already submitted or paid). ' +
          'Contact your labor coordinator to unlock it before making changes, then ' +
          'click "Reload from SpreadsheetWeb" to refresh its status.',
        screenshotPath,
      };
    }

    report(55, 'Filling timesheet fields');

    // 4. Fill the form

    // California rules — always on per company policy.
    await p.locator(`input[name="tsdMType"][value="California"]`).check().catch(() => {});

    // Text inputs: fill only if empty (form pre-fills some from account).
    const fillIfEmpty = async (label: string, value: string) => {
      if (!value) return;
      const input = p.locator(`xpath=//label[normalize-space()="${label}"]/following::input[1]`).first();
      if (await input.count()) {
        const existing = await input.inputValue();
        if (!existing) await input.fill(value);
      }
    };
    await fillIfEmpty('Position', input.show.position || '');
    await fillIfEmpty('Phone', input.profile.phone);
    await fillIfEmpty('E-Mail', input.profile.email);

    // PM + LC: native <select>s with "Last, First [M.]" options. C.A.R.L.
    // gives us "First Last". Fuzzy-match: every word from C.A.R.L. must appear
    // in the option text.
    const setNameSelect = async (selectId: string, carlName: string) => {
      if (!carlName) return;
      const sel = p.locator(`#${selectId}`);
      if (!(await sel.count())) return;
      const opts = await sel.locator('option').allTextContents();
      const words = carlName.split(/\s+/).filter((w) => w.length > 1);
      const lower = (s: string) => s.toLowerCase();
      const match = opts.find((o) => words.every((w) => lower(o).includes(lower(w))));
      if (match) await sel.selectOption({ label: match });
    };
    await setNameSelect('cmbProjectManager', input.show.projectManager);
    await setNameSelect('cmbLaborCoordinator', input.show.laborCoordinator);

    // Job # — Select2-wrapped select. Set via jQuery so Select2 updates UI.
    await p.evaluate((jobNumber: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const $ = (window as any).jQuery || (window as any).$;
      const el = document.querySelector('#cmbJobCopy') as HTMLSelectElement | null;
      if (!el) return;
      const opt = Array.from(el.options).find((o) => o.value === jobNumber || o.textContent?.trim() === jobNumber);
      if (!opt) return;
      if ($) {
        $('#cmbJobCopy').val(opt.value).trigger('change');
      } else {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, input.show.jobNumber);

    // From date — jQuery UI datepicker (readonly). setDate sets the value
    // but does NOT fire the picker's onSelect callback — and the form
    // registers its "compute To + render day rows" logic as onSelect, NOT as
    // a change handler. So we manually invoke onSelect after setDate.
    const fromCount = await p.locator('input[name="txtDFrom"]').count();
    if (fromCount > 0) {
      const dateMethod = await p.evaluate((iso: string) => {
        const [y, m, d] = iso.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        const el = document.querySelector('input[name="txtDFrom"]') as HTMLInputElement | null;
        if (!el) return 'no-element';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const $ = (window as any).jQuery || (window as any).$;
        if (!$) return 'no-jquery';

        try {
          const $inp = $('input[name="txtDFrom"]');
          $inp.datepicker('setDate', date);
          // Get the internal datepicker instance and manually invoke onSelect.
          // This is the documented workaround for setDate not firing the callback.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dp = ($ as any).datepicker;
          const inst = dp?._getInst?.(el);
          const onSelect = inst?.settings?.onSelect;
          if (onSelect) {
            onSelect.call(el, $inp.val(), inst);
          }
          $inp.trigger('change').trigger('blur');
          return `setDate+onSelect:${el.value} (onSelect=${!!onSelect})`;
        } catch (e) {
          return `error:${(e as Error).message}`;
        }
      }, input.entry.weekOfMonday);
      console.log('[autocarl] date fill:', dateMethod);

      // Wait for per-day rows to render
      const firstDayCell = p.locator('input[name="txtST_1_1"]');
      try {
        await firstDayCell.waitFor({ state: 'visible', timeout: 15000 });

        // Job# strategy depends on mode:
        //   • 'normal'             — fresh save / single-show week. Click
        //     #btnCopyJob to fan the primary show across all 7 days (one
        //     server-side action). Optionally override per-day for mixed weeks.
        //   • 'merge-into-existing' — we're editing a weekly record that
        //     already has other shows on other days. Clicking #btnCopyJob
        //     would clobber those days. So we set cmbJob_N ONLY on the worked
        //     days we're filling and leave the other days' show assignments
        //     untouched.
        const mergeMode = input.mode === 'merge-into-existing';
        if (!mergeMode) {
          const jobCopyResult = await p.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const $ = (window as any).jQuery || (window as any).$;
            if ($ && $('#btnCopyJob').length) { $('#btnCopyJob').trigger('click'); return 'jquery'; }
            const el = document.getElementById('btnCopyJob');
            if (el) { el.click(); return 'native'; }
            return 'not-found';
          });
          console.log('[autocarl] btnCopyJob click:', jobCopyResult);
          await p.waitForTimeout(400);
          report(60, 'Show set on each day');
        } else {
          console.log('[autocarl] merge-into-existing: skipping btnCopyJob to preserve other shows');
          report(60, 'Merging with existing weekly record');
        }

        // Set cmbJob_N per worked day:
        //   • merge mode: ALL worked days (the only days we touch).
        //   • normal mode: only days whose show differs from the primary
        //     (btnCopyJob already set the primary on every day).
        const primaryJob = input.show.jobNumber;
        const perDayJobs = input.entry.days.map((d) => {
          if (!d.worked) return null;
          const job = d.jobNumber || primaryJob;
          if (!mergeMode && job === primaryJob) return null; // btnCopyJob already handled it
          return job;
        });
        if (perDayJobs.some(Boolean)) {
          const setResult = await p.evaluate((jobs: (string | null)[]) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const $ = (window as any).jQuery || (window as any).$;
            const results: string[] = [];
            jobs.forEach((job, idx) => {
              if (!job) return;
              const N = idx + 1;
              const el = document.querySelector(`#cmbJob_${N}`) as HTMLSelectElement | null;
              if (!el) { results.push(`${N}:no-el`); return; }
              const opt = Array.from(el.options).find((o) => o.value === job || o.textContent?.trim() === job);
              if (!opt) { results.push(`${N}:no-opt(${job})`); return; }
              if ($) { $(`#cmbJob_${N}`).val(opt.value).trigger('change'); }
              else { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
              results.push(`${N}:${opt.value}`);
            });
            return results.join(', ');
          }, perDayJobs);
          console.log('[autocarl] per-day cmbJob set:', setResult);
          await p.waitForTimeout(500);
        }
      } catch {
        // Fallback: try the UI flow — click the calendar icon, navigate, click the day
        console.log('[autocarl] rows still hidden — trying calendar UI click');
        await p.locator('#basic-addon1, .fa-calendar').first().click().catch(() => {});
        await p.waitForTimeout(800);
        const pickerVisible = await p.locator('#ui-datepicker-div:visible').count();
        if (pickerVisible) {
          const [y, m, d] = input.entry.weekOfMonday.split('-').map(Number);
          const targetMonth = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' });
          for (let i = 0; i < 24; i++) {
            const curMonth = (await p.locator('.ui-datepicker-month').first().textContent())?.trim() || '';
            const curYear = (await p.locator('.ui-datepicker-year').first().textContent())?.trim() || '';
            if (curMonth === targetMonth && curYear === String(y)) break;
            const targetTs = new Date(y, m - 1, 1).getTime();
            const curTs = new Date(`${curMonth} 1, ${curYear}`).getTime();
            const dir = targetTs > curTs ? '.ui-datepicker-next' : '.ui-datepicker-prev';
            await p.locator(dir).first().click();
            await p.waitForTimeout(200);
          }
          await p
            .locator('.ui-datepicker-calendar td:not(.ui-datepicker-other-month) a.ui-state-default')
            .filter({ hasText: new RegExp(`^${d}$`) })
            .first()
            .click();
          await p.waitForTimeout(1000);
          await firstDayCell.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        }
        if (!(await firstDayCell.isVisible().catch(() => false))) {
          const screenshotPath = await screenshotOnError('date-no-rows');
          await browser.close();
          return {
            ok: false,
            error: `Date filled (${dateMethod}) but per-day rows did not render after onSelect + UI fallback.`,
            screenshotPath,
          };
        }
      }
    }

    report(65, 'Filling per-day hours');

    // Per-day fields. Column mapping (confirmed from form HTML):
    //   txtST_N_1 = IN          (column 1)
    //   txtST_N_2 = Lunch out   (column 2)
    //   txtET_N_1 = Lunch in    (column 3)
    //   txtET_N_2 = OUT         (column 4)
    //   txtPD_N_1 = Per Diem    (top box in Per Diem column)
    //
    // BATCHED FILL: one JS evaluate that uses jQuery to set + change-event
    // every cell synchronously. Playwright's `.fill()` is correctness-first
    // (focus/select/type/blur per call, ~200ms each) and awaits each — that
    // serializes SSW's Calculate (~500ms server round-trip per change) and
    // makes a full-week save take 10–15s on its own. Doing the changes in one
    // synchronous burst lets SSW's own debouncer collapse the cascade.
    const perDayFills = input.entry.days.map((d, i) => {
      if (!d.worked) return null;
      return {
        N: i + 1,
        st1: d.startTime,
        et2: d.endTime,
        st2: d.mealStart || '',
        et1: d.mealEnd || '',
        pd: d.perDiem != null && d.perDiem > 0 ? String(d.perDiem) : '',
        hasLunch: !!(d.mealStart || d.mealEnd),
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);

    const batchResult = await p.evaluate((fills) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const $ = (window as any).jQuery || (window as any).$;
      const touched: string[] = [];
      // SILENT set — no change event, so SSW's Calculate isn't fired per-cell.
      const setSilent = (name: string, val: string) => {
        const el = document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
        if (!el) return;
        if ($) $(el).val(val);
        else el.value = val;
        touched.push(name);
      };
      for (const f of fills) {
        setSilent(`txtST_${f.N}_1`, f.st1);
        setSilent(`txtET_${f.N}_2`, f.et2);
        if (f.hasLunch) {
          setSilent(`txtST_${f.N}_2`, f.st2);
          setSilent(`txtET_${f.N}_1`, f.et1);
        }
        setSilent(`txtPD_${f.N}_1`, f.pd);
      }
      // Fire change ONCE on the last cell we set — SSW's Calculate reads all
      // DOM values, so a single round-trip covers all 15 fields.
      if (fills.length) {
        const last = fills[fills.length - 1];
        const lastSel = `input[name="txtPD_${last.N}_1"]`;
        const el = document.querySelector(lastSel) as HTMLInputElement | null;
        if (el) {
          if ($) $(el).trigger('change');
          else el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      return touched.length;
    }, perDayFills);
    console.log('[autocarl] batched per-day fills (one Calculate):', batchResult, 'cells');

    // Let SSW's Calculate cascade finish before we move on (debounced/queued).
    await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    report(72, 'Setting daily rate');

    // Daily Rate — fill the top input, then fire the Copy button via jQuery
    // (same as Job # Copy and Save — native click doesn't reach the handler).
    console.log('[autocarl] dailyRate input value:', input.dailyRate);
    if (input.dailyRate != null && input.dailyRate > 0) {
      const drResult = await p.evaluate((rate: number) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const $ = (window as any).jQuery || (window as any).$;
        const inp = document.getElementById('txtDailyRateCopy') as HTMLInputElement | null;
        const btn = document.getElementById('btnDailyRate');
        if (!inp) return 'no-input';
        if ($) {
          $('#txtDailyRateCopy').val(String(rate)).trigger('change').trigger('blur');
        } else {
          inp.value = String(rate);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        if (!btn) return `set-only:${inp.value}`;
        if ($ && $('#btnDailyRate').length) { $('#btnDailyRate').trigger('click'); return `jquery-click:${inp.value}`; }
        btn.click();
        return `native-click:${inp.value}`;
      }, input.dailyRate);
      console.log('[autocarl] btnDailyRate:', drResult);
      await p.waitForTimeout(500);
    }

    await p.waitForTimeout(500); // settle onChange handlers
    report(78, 'Ready to save');

    // 5. Reveal the buttons row if still hidden, take a BEFORE screenshot,
    // then click Save. Inspect the result heavily.
    await p.evaluate(() => {
      const buttons = document.getElementById('dvButtons');
      if (buttons) buttons.style.display = '';
    });

    report(80, 'Saving on SpreadsheetWeb');
    const beforeShot = await screenshotOnError('before-save');
    console.log('[autocarl] before-save screenshot:', beforeShot);

    const saveBtn = p.locator('#btnSave');
    const saveBtnCount = await saveBtn.count();
    const saveBtnVisible = saveBtnCount ? await saveBtn.isVisible().catch(() => false) : false;
    const saveBtnEnabled = saveBtnCount ? await saveBtn.isEnabled().catch(() => false) : false;
    console.log(`[autocarl] #btnSave: count=${saveBtnCount} visible=${saveBtnVisible} enabled=${saveBtnEnabled}`);

    if (!saveBtnCount) {
      const screenshotPath = await screenshotOnError('no-save-btn');
      await browser.close();
      return { ok: false, error: 'Save button (#btnSave) not found on the form', screenshotPath };
    }

    // Scroll into view first (button might be off-screen) and click via jQuery
    // — the Pagos SSW engine binds click handlers via jQuery, so jQuery's
    // .click() fires those handlers reliably where a native click might not.
    await saveBtn.scrollIntoViewIfNeeded().catch(() => {});

    const clickResult = await p.evaluate(() => {
      const el = document.getElementById('btnSave');
      if (!el) return 'no-element';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const $ = (window as any).jQuery || (window as any).$;
      console.log('[autocarl] firing click via jQuery');
      if ($) {
        const $b = $('#btnSave');
        const handlerCount = (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const events = ($ as any)._data?.($b[0], 'events');
            return events?.click?.length || 0;
          } catch { return -1; }
        })();
        $b.trigger('click');
        return `jquery-click handlers=${handlerCount}`;
      }
      el.click();
      return 'native-click';
    });
    console.log('[autocarl] Save click:', clickResult);

    // Wait for save-related activity. Cast a wide net for the save URL since
    // we don't know the exact endpoint. Common patterns: SaveData, SaveRecord,
    // InsertRecord, /api/, .aspx/Save, etc.
    const saveResponse = await p.waitForResponse(
      (r) => {
        const req = r.request();
        if (req.method() !== 'POST' && req.method() !== 'PUT') return false;
        const u = r.url().toLowerCase();
        return /save|insert|update|submit|record/i.test(u) && !u.includes('userleaving') && !u.includes('calculate');
      },
      { timeout: 45000 },
    ).catch(() => null);
    if (saveResponse) {
      console.log(`[autocarl] save endpoint hit: ${saveResponse.status()} ${saveResponse.url()}`);
      const body = await saveResponse.text().catch(() => '');
      console.log(`     response body: ${body.slice(0, 500)}`);
    } else {
      console.log('[autocarl] NO save endpoint was hit within 45s after click');
    }

    report(90, 'Waiting for C.A.R.L. to confirm');
    await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(1000);

    // Check for a visible error message
    const errorText = await p.evaluate(() => {
      const candidates = [
        document.querySelector('#dvRecordError'),
        document.querySelector('.alert-danger'),
        document.querySelector('.alert.alert-warning'),
      ];
      for (const c of candidates) {
        if (c && (c as HTMLElement).offsetParent !== null) {
          return (c.textContent || '').trim().slice(0, 300);
        }
      }
      return '';
    });
    if (errorText) console.log('[autocarl] visible error on page:', errorText);

    const savedScreenshot = await screenshotOnError('saved');
    console.log('[autocarl] after-save screenshot:', savedScreenshot);
    console.log('[autocarl] final URL:', p.url());

    if (errorText) {
      await browser.close();
      return {
        ok: false,
        error: `Save was clicked but the form returned an error: ${errorText}`,
        screenshotPath: savedScreenshot,
      };
    }

    // Capture the recordId for next time. Try URL first, then scrape the
    // records list for the matching row.
    let savedRecordId: string | null = recordId;
    const finalUrlMatch = p.url().match(/RecordID=([^&]+)/);
    if (finalUrlMatch) savedRecordId = finalUrlMatch[1];

    if (!savedRecordId) {
      // Navigate back to records list, set page size to all, find our row
      try {
        const listAppId = appId || new URL(p.url()).searchParams.get('ApplicationID');
        await p.goto(`${SSW_BASE}/UI/Pages/Data.aspx?ApplicationID=${listAppId}`, { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(2000);
        await p.locator('select[name="dataGrid_length"]').selectOption('-1').catch(() => {});
        await p.waitForTimeout(1500);
        const [year, mm, dd] = input.entry.weekOfMonday.split('-').map(Number);
        const usDateNoPad = `${mm}/${dd}/${year}`;
        savedRecordId = await p.evaluate(
          ({ date, job }) => {
            const rows = document.querySelectorAll('#dataGrid tbody tr');
            for (const row of Array.from(rows)) {
              const cells = Array.from(row.querySelectorAll('td')).map((c) => (c.textContent || '').trim());
              if ((cells[1] || '').startsWith(date) && (cells[6] || '') === job) {
                const editLink = row.querySelector('a[href*="RecordID="]') as HTMLAnchorElement | null;
                const href = editLink?.getAttribute('href') || '';
                const m = href.match(/RecordID=([^&]+)/);
                return m ? m[1] : null;
              }
            }
            return null;
          },
          { date: usDateNoPad, job: input.show.jobNumber },
        );
        console.log(`[autocarl] recordId after save: ${savedRecordId || 'still unknown'}`);
      } catch (e) {
        console.log('[autocarl] failed to look up recordId after save:', (e as Error).message);
      }
    }

    await browser.close();

    report(100, 'Saved');
    return {
      ok: true,
      confirmationId: recordId
        ? `Updated existing record (${savedRecordId || 'id unknown'}).`
        : `New record saved${savedRecordId ? ` (${savedRecordId})` : ''}.`,
      sswRecordId: savedRecordId,
      sswAppId: appId || undefined,
    };
  } catch (err) {
    const screenshotPath = await screenshotOnError('error');
    await clearStorageState('ssw').catch(() => {});
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    report(100, 'Error');
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
    };
  }
}
