// CARL XHR inspector — logs every request fired by a booking detail page so
// we can map the underlying API and skip the browser entirely (like we did
// for SSW).
//
// Usage:
//   node inspect-carl-xhr.mjs                # uses VXr7nR19jJ (McDonalds)
//   node inspect-carl-xhr.mjs <bookingId>
//
// Dumps:
//   /tmp/carl-xhr/post-NNN.json  — one per request (req body + resp headers)
//   /tmp/carl-xhr/summary.txt    — one-line summary per request

import { chromium } from 'playwright';
import keytar from 'keytar';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CARL = 'https://carl.ctus.live';
const bookingId = process.argv[2] || 'VXr7nR19jJ';
const OUT_DIR = '/tmp/carl-xhr';

try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* */ }
mkdirSync(OUT_DIR, { recursive: true });

const cfgPath = join(homedir(), 'Library/Application Support/autocarl/autocarl2-config.json');
if (!existsSync(cfgPath)) { console.error('No v2 config — run the app once first.'); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const email = cfg.carlEmail;
const password = await keytar.getPassword('AUTOcarl2-carl-password', email);
if (!email || !password) { console.error('Missing CARL creds.'); process.exit(1); }

console.log(`→ output dir: ${OUT_DIR}`);
console.log(`→ logging in as ${email}`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let idx = 0;
const summary = [];
// Map request → assigned index so the response handler can find the right
// file even after many other requests have fired.
const reqIndex = new Map();

page.on('request', (req) => {
  const url = req.url();
  const resourceType = req.resourceType();
  if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) return;
  if (!url.includes('carl.ctus.live') && !url.includes('ctus.com')) return;

  idx++;
  const i = String(idx).padStart(3, '0');
  reqIndex.set(req, i);

  const method = req.method();
  const headers = req.headers();
  const postData = req.postData();
  const buf = req.postDataBuffer();

  const entry = {
    idx, when: new Date().toISOString(),
    method, url, resourceType,
    headers,
    postData,
    postDataBytes: buf ? buf.length : 0,
  };
  writeFileSync(join(OUT_DIR, `post-${i}.json`), JSON.stringify(entry, null, 2));

  const tag = method === 'POST' ? '★POST' : method === 'GET' ? ' GET' : method;
  const u = url.replace(CARL, '').slice(0, 110);
  const line = `[${i}] ${tag} ${resourceType.padEnd(8)} ${u}`;
  summary.push(line);
  console.log(line);
});

page.on('response', async (res) => {
  const req = res.request();
  const i = reqIndex.get(req);
  if (!i) return;
  const fp = join(OUT_DIR, `post-${i}.json`);
  if (!existsSync(fp)) return;
  try {
    const e = JSON.parse(readFileSync(fp, 'utf8'));
    const headers = res.headers();
    const ct = (headers['content-type'] || '').toLowerCase();
    e.response = {
      status: res.status(),
      statusText: res.statusText(),
      headers,
      contentType: ct,
    };
    if (ct.includes('json') || ct.includes('text') || ct.includes('javascript') || ct.includes('xml')) {
      try {
        const body = await res.text();
        e.response.body = body.slice(0, 32_000);
        e.response.bodyBytes = body.length;
      } catch (err) {
        e.response.bodyError = err instanceof Error ? err.message : String(err);
      }
    }
    writeFileSync(fp, JSON.stringify(e, null, 2));
  } catch { /* */ }
});

console.log(`→ login`);
await page.goto(`${CARL}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });

console.log(`→ visiting booking ${bookingId} — capturing all requests`);
await page.goto(`${CARL}/crewcalendar/booking-details-1/${bookingId}`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(3000);

console.log(`\n→ captured ${idx} requests total. Files in ${OUT_DIR}/`);
console.log(`→ summary written to ${OUT_DIR}/summary.txt`);
writeFileSync(join(OUT_DIR, 'summary.txt'), summary.join('\n'));

console.log('\nBrowser stays open 30s — feel free to scroll/click around the booking to see if more XHRs fire.');
await page.waitForTimeout(30_000).catch(() => {});
await browser.close();
