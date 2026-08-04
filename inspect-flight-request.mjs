// One-off: find how an active "flight request" manifests on a CARL booking
// page — in the DOM, in the page-template HTML the app's scan fetches, and in
// the token-POST JSON responses. Compares a booking WITH a request (Klaviyo)
// against one without (Nvidia).
import { chromium } from 'playwright';
import keytar from 'keytar';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CARL = 'https://carl.ctus.live';
const WITH_REQUEST = '3GN69JmVrz';    // Klaviyo Boston — active flight request
const WITHOUT_REQUEST = 'b1rA8ZpDjK'; // Nvidia NVAQ — none
const CT_APP_KEY = 'PEryxM0jOn';
const PAGE_ID = '4PzQ4GgNJG';

const cfgPath = join(homedir(), 'Library/Application Support/autocarl/config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const email = cfg.carlEmail;
const password = await keytar.getPassword('AUTOcarl-carl-password', email);
if (!email || !password) { console.error('Missing CARL creds.'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

// Capture any network response whose body mentions flight request.
const hits = [];
page.on('response', async (res) => {
  try {
    const ct = res.headers()['content-type'] || '';
    if (!/json|html|javascript/.test(ct)) return;
    const body = await res.text();
    if (/flight.{0,3}request/i.test(body)) {
      const i = body.search(/flight.{0,3}request/i);
      hits.push({ url: res.url().slice(0, 140), snippet: body.slice(Math.max(0, i - 250), i + 250).replace(/\s+/g, ' ') });
    }
  } catch { /* body unavailable */ }
});

console.log(`→ login as ${email}`);
await page.goto(`${CARL}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.locator('button:has-text("Sign In")').first().click();
await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });

async function inspect(bookingId, label) {
  hits.length = 0;
  console.log(`\n########## ${label} (${bookingId}) ##########`);
  await page.goto(`${CARL}/crewcalendar/booking-details-1/${bookingId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // DOM: any element whose text mentions flight request.
  const dom = await page.evaluate(() => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll('button, a, [class*="btn"], [class*="button"]'))) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/flight.{0,3}request/i.test(t)) out.push(el.outerHTML.replace(/\s+/g, ' ').slice(0, 500));
    }
    const text = document.body.innerText || '';
    const i = text.search(/flight.{0,3}request/i);
    const ctxTxt = i >= 0 ? text.slice(Math.max(0, i - 150), i + 150).replace(/\s+/g, ' ') : '(not in page text)';
    return { out, ctxTxt };
  });
  console.log('--- DOM matches ---');
  dom.out.forEach((h) => console.log(' ', h));
  console.log('--- innerText context ---\n ', dom.ctxTxt);

  // The template HTML that fetchBookingDetails actually pulls.
  const tpl = await page.evaluate(async ({ url }) => {
    const r = await fetch(url, { credentials: 'include' });
    const t = await r.text();
    const i = t.search(/flight.{0,3}request/i);
    return { bytes: t.length, snippet: i >= 0 ? t.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, ' ') : '(no match in template)' };
  }, { url: `${CARL}/app/${CT_APP_KEY}/pages/${PAGE_ID}.html?_=${Date.now()}&recordId=${encodeURIComponent(bookingId)}` });
  console.log(`--- scan-path template HTML (${tpl.bytes} bytes) ---\n `, tpl.snippet);

  console.log('--- network responses mentioning it ---');
  if (!hits.length) console.log('  (none)');
  hits.forEach((h) => console.log(`  [${h.url}]\n    ${h.snippet}\n`));
}

await inspect(WITH_REQUEST, 'KLAVIYO — has active flight request');
await inspect(WITHOUT_REQUEST, 'NVIDIA — control, no request');

await browser.close();
