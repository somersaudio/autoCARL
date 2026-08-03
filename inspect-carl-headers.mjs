// Captures the FULL request headers from a single /webapi/v1/app/g/ POST
// the SPA sends — so we can see which header authorizes the call.
//
// Usage:  node inspect-carl-headers.mjs

import { chromium } from 'playwright';
import keytar from 'keytar';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CARL = 'https://carl.ctus.live';
const bookingId = 'VXr7nR19jJ';

const cfgPath = join(homedir(), 'Library/Application Support/autocarl/autocarl2-config.json');
if (!existsSync(cfgPath)) { console.error('No v2 config'); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const email = cfg.carlEmail;
const password = await keytar.getPassword('AUTOcarl2-carl-password', email);

console.log(`→ logging in as ${email}`);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const captured = [];
page.on('request', (req) => {
  if (req.method() !== 'POST') return;
  const u = req.url();
  if (!u.includes('/webapi/v1/app/g/')) return;
  captured.push({
    url: u,
    headers: req.headers(),
    postData: req.postData(),
  });
});

await page.goto(`${CARL}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });

console.log(`→ visiting booking ${bookingId}`);
await page.goto(`${CARL}/crewcalendar/booking-details-1/${bookingId}`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(2500);

await browser.close();

console.log(`\n→ captured ${captured.length} /webapi/v1/app/g/ POSTs`);
if (captured.length === 0) {
  console.log('no POSTs captured. SPA may not have rendered.');
  process.exit(2);
}

// Dump the FIRST POST's headers and body — all we need.
const first = captured[0];
console.log('\n=== FIRST POST request ===');
console.log('URL:', first.url);
console.log('\nHeaders (sorted):');
const keys = Object.keys(first.headers).sort();
for (const k of keys) {
  let v = first.headers[k];
  if (k === 'cookie') v = `(${v.length} chars: ${v.slice(0, 80)}...)`;
  if (typeof v === 'string' && v.length > 200) v = v.slice(0, 200) + '...';
  console.log(`  ${k}: ${v}`);
}
console.log('\nBody:', first.postData ? first.postData.slice(0, 300) : '(none)');

writeFileSync('/tmp/carl-headers.json', JSON.stringify(captured.slice(0, 3), null, 2));
console.log('\n→ first 3 POSTs saved to /tmp/carl-headers.json');
