// Read-only exploration of the SpreadsheetWeb timesheets system.
// Logs in, dumps landing + any timesheet/hours pages.
// Does NOT click any submit/save buttons.
//
// Usage:
//   AUTOCARL_TS_USER=... AUTOCARL_TS_PASS=... node scripts/explore-timesheets.mjs

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const USER = process.env.AUTOCARL_TS_USER;
const PASS = process.env.AUTOCARL_TS_PASS;
const SITE = process.env.AUTOCARL_TS_SITE || 'https://ctts.ctus.com/SpreadsheetWeb/Default.aspx';
const OUT = '/tmp/autocarl-explore-ts';

if (!USER || !PASS) {
  console.error('Missing AUTOCARL_TS_USER or AUTOCARL_TS_PASS env var.');
  process.exit(1);
}

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

async function dump(name) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);
  const html = await page.content();
  const url = page.url();
  const title = await page.title();
  await fs.writeFile(join(OUT, `${name}.html`), html);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  const fields = await page.$$eval(
    'input, select, textarea, button, a, [role="link"], [role="button"]',
    (els) =>
      els.map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        id: el.id || null,
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        href: el.getAttribute('href'),
        classes: (el.getAttribute('class') || '').slice(0, 100),
        text: (el.textContent || '').trim().slice(0, 80),
      })),
  );
  await fs.writeFile(join(OUT, `${name}.fields.json`), JSON.stringify(fields, null, 2));
  console.log(`[${name}] url=${url}  title="${title}"  elements=${fields.length}`);
  return { url, title, fields };
}

console.log('→ navigating to SpreadsheetWeb login');
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await dump('01-login');

console.log('→ filling credentials');
await page.locator('#ucLogin1_txtUserName').fill(USER);
await page.locator('#ucLogin1_txtPassword').fill(PASS);

console.log('→ clicking Login');
await Promise.all([
  page.waitForLoadState('domcontentloaded').catch(() => {}),
  page.locator('#ucLogin1_loginButton').click(),
]);
await page.waitForTimeout(2500);
await dump('02-after-login');

// Open the Select2 application dropdown to discover what timesheet applications exist
console.log('→ opening the application dropdown');
await page.locator('.select2-choice').first().click();
await page.waitForTimeout(1500);

// Capture the dropdown options (rendered in a portal at the body level when open)
const options = await page.$$eval('.select2-result-label, .select2-results li', (els) =>
  els.map((el) => (el.textContent || '').trim()).filter((t) => t && t.length < 200),
);
await fs.writeFile(join(OUT, '02-dropdown-options.json'), JSON.stringify(options, null, 2));
console.log(`   ${options.length} dropdown options:`);
options.slice(0, 30).forEach((o) => console.log('   -', JSON.stringify(o)));

await page.screenshot({ path: join(OUT, '02-dropdown-open.png'), fullPage: true });

// Pick the most timesheet-y option, preferring exact matches
const preference = [
  /timesheet/i,
  /time\s*sheet/i,
  /hours/i,
  /timecard/i,
  /time\s*card/i,
  /crew/i,
];
let pick = null;
for (const re of preference) {
  pick = options.find((o) => re.test(o));
  if (pick) break;
}
if (!pick && options.length > 0) pick = options[0];

if (pick) {
  console.log('→ selecting application:', JSON.stringify(pick));
  // Click the result row containing the picked text
  await page
    .locator('.select2-result-label, .select2-results li')
    .filter({ hasText: pick })
    .first()
    .click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
  await dump('03-timesheet-app');

  // Find Add New's href and navigate directly (click sometimes opens a popup Playwright misses)
  console.log('→ resolving Add New URL');
  const addNew = page.locator('a:has-text("Add New")').first();
  const href = await addNew.getAttribute('href').catch(() => null);
  if (href) {
    // href like "../../Output.aspx?ApplicationID=..." — resolve against current page
    const fullHref = new URL(href, page.url()).toString();
    console.log('   → navigating to:', fullHref);
    // Watch for popup just in case
    const popupPromise = page.context().waitForEvent('page', { timeout: 2000 }).catch(() => null);
    await page.goto(fullHref, { waitUntil: 'domcontentloaded' });
    const popup = await popupPromise;
    if (popup) {
      console.log('   (popup also opened; focusing main page)');
      await popup.close().catch(() => {});
    }
    await page.waitForTimeout(5000); // entry form is JS-heavy
    await dump('04-entry-form');

    // Try to extract structured field info: labels next to inputs
    console.log('→ extracting labeled fields from the entry form');
    const labeledFields = await page.$$eval('input, select, textarea', (els) => {
      function findLabel(el) {
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent?.trim().slice(0, 80) || null;
        }
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
          const lbl = p.querySelector(':scope > label, :scope > div > label, :scope > span');
          if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim().slice(0, 80);
          const txt = p.textContent?.trim();
          if (txt && txt.length < 80) return txt;
        }
        return null;
      }
      return els
        .filter((el) => el.type !== 'hidden')
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          id: el.id || null,
          placeholder: el.getAttribute('placeholder'),
          label: findLabel(el),
          value: el.value?.slice(0, 80),
        }));
    });
    await fs.writeFile(join(OUT, '04-entry-form.labeled-fields.json'), JSON.stringify(labeledFields, null, 2));
    console.log(`   ${labeledFields.length} non-hidden fields with labels:`);
    labeledFields.slice(0, 30).forEach((f) =>
      console.log(`   - ${f.tag}[${f.type || '-'}] name=${f.name || '?'} label=${JSON.stringify(f.label || '')}`),
    );
  } else {
    console.log('   "Add New" button not found — dumping current page anyway');
  }
}

console.log('\nDone. Output in', OUT);
await browser.close();
