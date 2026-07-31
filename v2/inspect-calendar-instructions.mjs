// Captures what XHRs fire when CARL's "Calendar Instructions" page loads —
// so we can find the endpoint that serves the iCal URL and call it directly.
//
// Usage:  node inspect-calendar-instructions.mjs

import { chromium } from 'playwright';
import keytar from 'keytar';
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CARL = 'https://carl.ctus.live';
const OUT_DIR = '/tmp/carl-cal';

try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* */ }
mkdirSync(OUT_DIR, { recursive: true });

const cfgPath = join(homedir(), 'Library/Application Support/autocarl/autocarl2-config.json');
if (!existsSync(cfgPath)) { console.error('No v2 config'); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const email = cfg.carlEmail;
const password = await keytar.getPassword('AUTOcarl2-carl-password', email);
if (!email || !password) { console.error('Missing CARL creds'); process.exit(1); }

console.log(`→ logging in as ${email}`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let idx = 0;
const reqIndex = new Map();
const myIcal = 'MYTP-YZGR'; // John's prefix — we'll log when we see any string that looks like an iCal URL

function maybeLogIcalSighting(where, text) {
  const m = String(text || '').match(/https:\/\/calendar[^\s"'<>]+/g);
  if (m) {
    for (const url of m) {
      console.log(`  ★ ICAL URL SIGHTING in ${where}: ${url}`);
    }
  }
}

page.on('request', (req) => {
  const url = req.url();
  if (!url.includes('carl.ctus.live') && !url.includes('ctus.com')) return;
  if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) return;
  idx++;
  const i = String(idx).padStart(3, '0');
  reqIndex.set(req, i);
  const entry = {
    idx, when: new Date().toISOString(),
    method: req.method(),
    url,
    resourceType: req.resourceType(),
    headers: req.headers(),
    postData: req.postData(),
  };
  writeFileSync(join(OUT_DIR, `post-${i}.json`), JSON.stringify(entry, null, 2));
  console.log(`[${i}] ${req.method().padEnd(4)} ${req.resourceType().padEnd(8)} ${url.replace(CARL, '').slice(0, 110)}`);
});

page.on('response', async (res) => {
  const i = reqIndex.get(res.request());
  if (!i) return;
  const fp = join(OUT_DIR, `post-${i}.json`);
  if (!existsSync(fp)) return;
  try {
    const e = JSON.parse(readFileSync(fp, 'utf8'));
    const headers = res.headers();
    const ct = (headers['content-type'] || '').toLowerCase();
    e.response = { status: res.status(), headers, contentType: ct };
    if (ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('javascript')) {
      try {
        const body = await res.text();
        e.response.body = body.slice(0, 32_000);
        maybeLogIcalSighting(`response ${i}`, body);
      } catch { /* */ }
    }
    writeFileSync(fp, JSON.stringify(e, null, 2));
  } catch { /* */ }
});

await page.goto(`${CARL}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });
console.log(`✔ logged in → ${page.url()}`);

// Reset idx now so we cleanly separate "post-login traffic" from "click traffic"
console.log(`\n--- About to click "Calendar Instructions" ---\n`);

const link = page.locator('a:has-text("Calendar Instructions"), button:has-text("Calendar Instructions")').first();
await link.waitFor({ state: 'visible', timeout: 15_000 });
await link.click();
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(3000);

// Search the current page for any iCal URL.
const pageText = await page.evaluate(() => document.body.innerText || '');
maybeLogIcalSighting('rendered page text', pageText);
const html = await page.content();
writeFileSync(join(OUT_DIR, 'final-page.html'), html);

console.log(`\n→ ${idx} requests total. Files in ${OUT_DIR}/`);
console.log(`→ final rendered HTML: ${OUT_DIR}/final-page.html`);
console.log('\nBrowser stays open 30s for inspection…');
await page.waitForTimeout(30_000).catch(() => {});
await browser.close();
