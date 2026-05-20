// Mirrors src/automation/scrapeCarl.ts with verbose logging so we can see
// where Position pulling breaks.
//
// Usage: AUTOCARL_USER=... AUTOCARL_PASS=... node scripts/debug-scrape.mjs

import { chromium } from 'playwright';

const USER = process.env.AUTOCARL_USER;
const PASS = process.env.AUTOCARL_PASS;
const CARL_BASE = 'https://carl.ctus.live';
if (!USER || !PASS) {
  console.error('Missing AUTOCARL_USER or AUTOCARL_PASS');
  process.exit(1);
}

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

console.log('→ login');
await page.goto(`${CARL_BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(USER);
await page.locator('input[type="password"]').fill(PASS);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 20000 });

console.log('→ waiting for bookings table');
await page.locator('th:has-text("Job Number")').first().waitFor({ state: 'visible', timeout: 30000 });

const rows = await page.evaluate(() => {
  const tables = Array.from(document.querySelectorAll('table'));
  let target = null;
  for (const t of tables) {
    const headers = Array.from(t.querySelectorAll('th')).map((h) => (h.textContent || '').trim());
    if (headers.includes('Job Number')) { target = t; break; }
  }
  if (!target) return [];
  const headerCells = Array.from(target.querySelectorAll('th')).map((h) => (h.textContent || '').trim());
  const get = (cells, label) => {
    const i = headerCells.indexOf(label);
    return i >= 0 ? cells[i] || '' : '';
  };
  const out = [];
  for (const r of Array.from(target.querySelectorAll('tbody tr'))) {
    const cells = Array.from(r.querySelectorAll('td')).map((c) => (c.textContent || '').trim());
    if (!cells.length) continue;
    const detailLink = r.querySelector('a[href*="booking-details-1/"]');
    const bookingId = detailLink ? (detailLink.getAttribute('href') || '').split('booking-details-1/')[1] || '' : '';
    out.push({
      jobNumber: get(cells, 'Job Number'),
      jobName: get(cells, 'Job Name'),
      bookingId,
    });
  }
  return out;
});

console.log('\n→ rows extracted:', JSON.stringify(rows, null, 2));

for (const row of rows) {
  if (!row.bookingId) {
    console.log(`\n[!] ${row.jobNumber}: NO bookingId — link not found in row`);
    continue;
  }
  const url = `${CARL_BASE}/crewcalendar/booking-details-1/${row.bookingId}`;
  console.log(`\n→ visiting ${row.jobNumber}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Show what selectors actually find
  console.log('   waiting 2s for SPA to settle…');
  await page.waitForTimeout(2000);

  const titleText = await page.title();
  console.log(`   page title: ${titleText}`);

  const positionSelector = 'af-data-table-field[column*="field_408"] span';
  const fieldCount = await page.locator(positionSelector).count();
  console.log(`   selector "${positionSelector}" matches: ${fieldCount} element(s)`);

  if (fieldCount > 0) {
    const allTexts = await page.locator(positionSelector).allTextContents();
    console.log(`   texts found:`, allTexts);
  }

  // Try the broader selector
  const broadCount = await page.locator('af-data-table-field').count();
  console.log(`   af-data-table-field total on page: ${broadCount}`);

  // Wait longer and retry
  console.log('   waiting another 5s and retrying…');
  await page.waitForTimeout(5000);
  const retryCount = await page.locator(positionSelector).count();
  console.log(`   selector matches after wait: ${retryCount}`);
  if (retryCount > 0) {
    const txt = await page.locator(positionSelector).first().textContent();
    console.log(`   first match text: ${JSON.stringify(txt)}`);
  }

  // Search for "Outdoor" or any code-prefixed position-like string in the body
  const bodyHasOutdoor = await page.evaluate(() => /Outdoor Audio Engineer|\b\d{1,3}\s*-\s*[A-Za-z]/.test(document.body.innerText));
  console.log(`   body text contains position-like pattern: ${bodyHasOutdoor}`);
}

console.log('\nDone. Leaving browser open for 30s so you can inspect.');
await page.waitForTimeout(30000);
await browser.close();
