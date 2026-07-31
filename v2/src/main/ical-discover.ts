import { chromium, type Browser } from 'playwright';

// ONE-TIME flow: login to CARL with email + password, click "Calendar
// Instructions" in the top nav, and grab the personalised iCal URL.
// After this, the URL is cached in the keychain and CARL never sees a browser
// again (until creds change or the URL stops working).

const CARL_BASE = 'https://carl.ctus.live';

export async function discoverIcalUrl(email: string, password: string): Promise<string> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(`${CARL_BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="username"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button:has-text("Sign In")').first().click();
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 20000 });

    // The Calendar Instructions link sits in the top nav alongside Timesheets
    // and Crew. It opens a screen/modal with the personalised iCal subscription
    // URL. We grab any URL on the page that points at calendar.prod.carl.ctus.live.
    const link = page.locator('a:has-text("Calendar Instructions"), button:has-text("Calendar Instructions")').first();
    await link.waitFor({ state: 'visible', timeout: 15000 });
    await link.click();
    // Wait for either a same-page panel to render or a navigation to settle.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // The URL we want looks like: https://calendar.prod.carl.ctus.live/<token>
    // Pull it from any link/input/text-content on the page.
    const url = await page.evaluate(() => {
      const re = /https:\/\/calendar\.[a-z.]*carl\.ctus\.live\/[A-Za-z0-9_\-]+/;
      // Anchors first (most reliable).
      for (const a of Array.from(document.querySelectorAll('a'))) {
        const m = (a.getAttribute('href') || '').match(re);
        if (m) return m[0];
      }
      // Inputs (e.g. read-only text field with copy button).
      for (const i of Array.from(document.querySelectorAll('input, textarea'))) {
        const v = (i as HTMLInputElement).value || '';
        const m = v.match(re);
        if (m) return m[0];
      }
      // Fallback: full body text.
      const m = (document.body.innerText || '').match(re);
      return m ? m[0] : '';
    });

    if (!url) throw new Error('Could not find an iCal URL on the Calendar Instructions page.');
    return url;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
