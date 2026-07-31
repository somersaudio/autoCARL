// Quick venue/address DOM inspector for one CARL booking.
// Usage:
//   node inspect-venue.mjs            # uses VXr7nR19jJ (McDonalds)
//   node inspect-venue.mjs <bookingId>

import { chromium } from 'playwright';
import keytar from 'keytar';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CARL = 'https://carl.ctus.live';
const bookingId = process.argv[2] || 'VXr7nR19jJ';

const cfgPath = join(homedir(), 'Library/Application Support/autocarl/autocarl2-config.json');
if (!existsSync(cfgPath)) { console.error('No v2 config — run the app once first.'); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const email = cfg.carlEmail;
const password = await keytar.getPassword('AUTOcarl2-carl-password', email);
if (!email || !password) { console.error('Missing CARL creds.'); process.exit(1); }

console.log(`→ logging in as ${email}`);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${CARL}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });

console.log(`→ visiting booking ${bookingId}`);
await page.goto(`${CARL}/crewcalendar/booking-details-1/${bookingId}`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(2000);

// Save the whole page HTML for diffing.
const html = await page.content();
writeFileSync('/tmp/booking-venue.html', html);

// Pull every zip-shaped string plus 200 chars of context before it, so we
// can see which one is the venue and what label sits above it.
const report = await page.evaluate(() => {
  const text = document.body.innerText || '';
  const out = [];
  const re = /\b\d{5}(?:-\d{4})?\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 220);
    const end = Math.min(text.length, m.index + m[0].length + 40);
    out.push(`...${text.slice(start, end).replace(/\s+/g, ' ').trim()}...`);
  }
  // Also: every label-shaped text node near a "venue" keyword (case-insensitive).
  const venueContexts = [];
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.children.length > 0) continue;
    const t = (el.textContent || '').trim();
    if (!/venue/i.test(t)) continue;
    let walker = el;
    let ctx = '';
    for (let i = 0; i < 4 && walker; i++) {
      ctx = (walker.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      walker = walker.parentElement;
    }
    venueContexts.push(`[${t}] → ${ctx}`);
  }
  return { zipContexts: out.slice(0, 20), venueContexts: venueContexts.slice(0, 10) };
});

console.log('\n=== zip-shaped strings on the page (with context) ===');
for (const c of report.zipContexts) console.log(c);
console.log('\n=== elements containing the word "venue" ===');
for (const c of report.venueContexts) console.log(c);
console.log('\n→ full HTML written to /tmp/booking-venue.html');

await browser.close();
