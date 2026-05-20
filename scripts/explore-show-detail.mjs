// Explore what happens when the user clicks into a show in C.A.R.L. — looking
// for the Position field (e.g. "05 - Outdoor Audio Engineer").

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const USER = process.env.AUTOCARL_USER;
const PASS = process.env.AUTOCARL_PASS;
const OUT = '/tmp/autocarl-explore-detail';

if (!USER || !PASS) {
  console.error('Missing AUTOCARL_USER or AUTOCARL_PASS');
  process.exit(1);
}

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const responses = [];
page.on('response', async (res) => {
  try {
    const url = res.url();
    if (!url.includes('/webapi/')) return;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    const body = await res.text();
    responses.push({ url, body });
  } catch {}
});

async function dump(name) {
  const html = await page.content();
  await fs.writeFile(join(OUT, `${name}.html`), html);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`[${name}] url=${page.url()}  title="${await page.title()}"`);
}

console.log('→ login');
await page.goto('https://carl.ctus.live/login', { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(USER);
await page.locator('input[type="password"]').fill(PASS);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 20000 });

console.log('→ waiting for Bookings table');
await page.locator('th:has-text("Job Number")').first().waitFor({ state: 'visible', timeout: 30000 });
await page.waitForTimeout(2000);
await dump('A-bookings-list');

// Record responses captured up to this point so we can compare before/after click.
const before = responses.length;
console.log(`   captured ${before} JSON responses so far`);

// Find the info ("i") button for the first row and click it
console.log('→ clicking the info icon on the first show row');
const infoBtn = page
  .locator('table:has(th:has-text("Job Number")) tbody tr')
  .first()
  .locator('button, a')
  .last(); // typically the rightmost cell button
if (await infoBtn.count()) {
  await infoBtn.click({ timeout: 10000 }).catch((e) => console.log('  click failed:', e.message));
  await page.waitForTimeout(4000);
  await dump('B-after-info-click');
} else {
  console.log('  no info button found on first row');
}

// Look for "Position" text on the resulting page/modal
const positionHit = await page.locator('text=Position').first().count();
console.log('   "Position" label present?', positionHit > 0);

// Also try clicking the job-name text or the row itself
console.log('→ also trying click on the job name cell');
const jobNameCell = page
  .locator('table:has(th:has-text("Job Number")) tbody tr td')
  .nth(2); // 0=Job Number, 1=Task, 2=Job Name
if (await jobNameCell.count()) {
  await jobNameCell.click().catch((e) => console.log('  click failed:', e.message));
  await page.waitForTimeout(3000);
  await dump('C-after-job-name-click');
}

// Dump new JSON responses (likely contain the detail data)
const newResponses = responses.slice(before);
console.log(`\n→ ${newResponses.length} new JSON responses since clicking:`);
let i = 0;
for (const r of newResponses) {
  const preview = r.body.slice(0, 300);
  console.log(`   [${i}] ${r.url.slice(-80)} | ${preview.slice(0, 200)}`);
  await fs.writeFile(join(OUT, `detail-${i}.json`), r.body);
  i++;
}

console.log('\nDone. Output in', OUT);
await browser.close();
