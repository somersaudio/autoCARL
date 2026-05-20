// Read-only exploration of the C.A.R.L. crew site.
// Logs in, dumps HTML + screenshots + field metadata for each page visited.
// Does NOT click any submit/save buttons on hours pages.
//
// Usage:
//   AUTOCARL_USER=... AUTOCARL_PASS=... node scripts/explore.mjs

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const USER = process.env.AUTOCARL_USER;
const PASS = process.env.AUTOCARL_PASS;
const SITE = process.env.AUTOCARL_SITE || 'https://carl.ctus.live/login';
const OUT = '/tmp/autocarl-explore';

if (!USER || !PASS) {
  console.error('Missing AUTOCARL_USER or AUTOCARL_PASS env var.');
  process.exit(1);
}

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false, slowMo: 100 });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

async function dump(name) {
  // Quiet brief render flickers by waiting for the document to be stable.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);

  const html = await page.content();
  const url = page.url();
  const title = await page.title();
  await fs.writeFile(join(OUT, `${name}.html`), html);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  const fields = await page.$$eval('input, select, textarea, button, a, [role="link"], [role="button"]', (els) =>
    els.map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      href: el.getAttribute('href'),
      classes: (el.getAttribute('class') || '').slice(0, 100),
      text: (el.textContent || '').trim().slice(0, 80),
    })),
  );
  await fs.writeFile(join(OUT, `${name}.fields.json`), JSON.stringify(fields, null, 2));
  console.log(`[${name}] url=${url}  title="${title}"  elements=${fields.length}`);
  return { url, title, fields };
}

console.log('→ navigating to login');
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await dump('01-login');

console.log('→ filling credentials');
await page.locator('input[name="username"]').fill(USER);
await page.locator('input[type="password"]').fill(PASS);

console.log('→ clicking Sign In');
await page.locator('button:has-text("Sign In")').first().click();

console.log('→ waiting for navigation off /login (max 20s)');
try {
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 });
  console.log('   navigated to:', page.url());
} catch {
  console.log('   timeout — still on /login. Checking for error message…');
}

// Give the SPA time to render whatever route it landed on.
await page.waitForTimeout(2500);
await dump('02-after-login');

console.log('→ scanning the whole DOM for hours-related navigation');
const navCandidates = await page.$$eval('*', (els) => {
  const out = [];
  for (const el of els) {
    const text = (el.textContent || '').trim();
    if (text.length === 0 || text.length > 60) continue;
    if (!/^(hour|time|card|sheet|day|week|punch|enter|submit|payroll|timesheet)/i.test(text)) continue;
    // Only leaf-ish text containers — avoid grabbing huge wrappers
    if (el.children.length > 3) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 80),
      href: el.getAttribute('href'),
      role: el.getAttribute('role'),
      classes: (el.getAttribute('class') || '').slice(0, 80),
    });
  }
  return out;
});
await fs.writeFile(join(OUT, '02-after-login.candidate-nav.json'), JSON.stringify(navCandidates, null, 2));
console.log(`   ${navCandidates.length} candidate nav items found`);
navCandidates.slice(0, 15).forEach((c) => console.log('   -', c.tag, JSON.stringify(c.text), c.href || ''));

const linkWithHref = navCandidates.find((l) => l.href && l.href !== '#' && !l.href.startsWith('javascript:'));
if (linkWithHref) {
  const fullHref = linkWithHref.href.startsWith('http')
    ? linkWithHref.href
    : new URL(linkWithHref.href, page.url()).toString();
  console.log('→ following:', fullHref, `(text: "${linkWithHref.text}")`);
  await page.goto(fullHref, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('   nav failed:', e.message));
  await page.waitForTimeout(2500);
  await dump('03-hours-page');
} else if (navCandidates.length > 0) {
  console.log('→ no href, attempting click on first text match:', navCandidates[0].text);
  try {
    await page.getByText(navCandidates[0].text, { exact: true }).first().click({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await dump('03-hours-page');
  } catch (e) {
    console.log('   click failed:', e.message);
  }
}

console.log('\nDone. Output in', OUT);
await browser.close();
