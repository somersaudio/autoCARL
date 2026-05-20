// Network-sniffing exploration of C.A.R.L. — captures the JSON API the SPA
// uses to fetch show / crew data. Captures all responses, then writes the
// JSON-looking ones to disk for inspection.

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const USER = process.env.AUTOCARL_USER;
const PASS = process.env.AUTOCARL_PASS;
const OUT = '/tmp/autocarl-explore-carl';

if (!USER || !PASS) {
  console.error('Missing AUTOCARL_USER or AUTOCARL_PASS');
  process.exit(1);
}

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false, slowMo: 80 });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const responses = [];
page.on('response', async (res) => {
  try {
    const url = res.url();
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    if (url.includes('cloudfront') || url.includes('googleapis') || url.includes('cloudinary') || url.includes('leaflet')) return;
    const body = await res.text();
    responses.push({ url, status: res.status(), bodyPreview: body.slice(0, 600), bodyLength: body.length, body });
  } catch {}
});

console.log('→ login');
await page.goto('https://carl.ctus.live/login', { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(USER);
await page.locator('input[type="password"]').fill(PASS);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 20000 });

console.log('→ on', page.url(), '— letting SPA settle');
await page.waitForTimeout(8000);

// Take multiple screenshots over time to catch a rendered state
for (const t of [0, 2000, 5000]) {
  if (t > 0) await page.waitForTimeout(t);
  await page.screenshot({ path: join(OUT, `frame-${t}.png`), fullPage: false });
}

// Now write all captured JSON responses
console.log(`\n→ captured ${responses.length} JSON responses:`);
for (const r of responses) {
  console.log(`   ${r.status} ${r.url.replace('https://carl.ctus.live', '')} (${r.bodyLength}b)`);
}
await fs.writeFile(join(OUT, 'json-responses-summary.json'), JSON.stringify(
  responses.map(({ url, status, bodyPreview, bodyLength }) => ({ url, status, bodyLength, bodyPreview })),
  null, 2,
));
// Write each full response body, named by URL path
let i = 0;
for (const r of responses) {
  const safeName = `${String(i).padStart(2, '0')}-${r.url.replace(/https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.json`;
  await fs.writeFile(join(OUT, safeName), r.body);
  i++;
}

console.log('\nDone. Output in', OUT);
await browser.close();
