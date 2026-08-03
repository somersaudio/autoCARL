// Captures every POST during an SSW session (across all tabs).
// Usage:
//   1. Complete v2 setup so SSW creds are in the keychain.
//   2. node inspect-ssw-save.mjs
//   3. Browser opens & logs in. Open a real timesheet, fill one hour value,
//      click Save. POSTs print live and are dumped to /tmp/ssw/post-NNN.json.
//   4. After clicking Save, hit Ctrl+C in this terminal.

import { chromium } from 'playwright';
import keytar from 'keytar';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SSW = 'https://ctts.ctus.com/SpreadsheetWeb';
const LOGIN = `${SSW}/Default.aspx`;
const OUT_DIR = '/tmp/ssw';

try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* */ }
mkdirSync(OUT_DIR, { recursive: true });

const cfgPath = join(homedir(), 'Library/Application Support/autocarl-v2/autocarl2-config.json');
if (!existsSync(cfgPath)) { console.error('Config not found at', cfgPath); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const email = cfg.sswEmail;
if (!email) { console.error('No SSW email in config.'); process.exit(1); }
const password = await keytar.getPassword('AUTOcarl2-ssw-password', email);
if (!password) { console.error('No SSW password in keychain for', email); process.exit(1); }

console.log(`→ SSW email: ${email}`);
console.log(`→ output dir: ${OUT_DIR}`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

let postIdx = 0;

async function onRequest(req, label) {
  if (req.method() !== 'POST') {
    const u = req.url();
    if (!u.includes('SpreadsheetWeb')) return;
    if (req.resourceType() === 'document') console.log(`[GET ${label}] ${u}`);
    return;
  }
  postIdx++;
  const idx = String(postIdx).padStart(3, '0');
  const url = req.url();
  const headers = req.headers();
  const postData = req.postData();
  const buf = req.postDataBuffer();

  const entry = {
    idx: postIdx,
    when: new Date().toISOString(),
    tab: label,
    method: req.method(),
    url,
    headers,
    postData,
    postDataBytes: buf ? buf.length : 0,
    postDataBufferB64: buf ? buf.toString('base64') : null,
  };
  writeFileSync(join(OUT_DIR, `post-${idx}.json`), JSON.stringify(entry, null, 2));

  // The actual save in SSW is just a Calculate POST with SaveInformation.Save=true.
  // Highlight that case loudly so the user knows the click landed.
  const hasSaveTrue = /"Save"\s*:\s*true/.test(postData || '');
  const isCalc = url.endsWith('/Page.aspx/Calculate');
  const tag = hasSaveTrue ? '★★★ SAVE TRUE ★★★' : (isCalc ? 'calc' : '-');

  console.log(`[${idx} ${label}] ${tag.padEnd(20)} ${(buf ? buf.length : 0).toString().padStart(7)}B  ${url}`);
  if (hasSaveTrue) console.log(`         ↳ written to /tmp/ssw/post-${idx}.json`);
}

async function onResponse(res) {
  if (res.request().method() !== 'POST') return;
  const url = res.url();
  if (postIdx === 0) return;
  const idx = String(postIdx).padStart(3, '0');
  const fp = join(OUT_DIR, `post-${idx}.json`);
  if (!existsSync(fp)) return;
  try {
    const entry = JSON.parse(readFileSync(fp, 'utf8'));
    if (entry.url !== url) return;
    entry.response = {
      status: res.status(),
      statusText: res.statusText(),
      headers: res.headers(),
    };
    try { entry.response.body = (await res.text()).slice(0, 8000); } catch { /* */ }
    writeFileSync(fp, JSON.stringify(entry, null, 2));
  } catch { /* */ }
}

function attachListeners(p, label) {
  p.on('request', (req) => onRequest(req, label));
  p.on('response', (res) => onResponse(res));
}

// Attach to any new tab/popup SSW opens.
ctx.on('page', (p) => {
  console.log(`[NEW TAB] ${p.url() || '(blank)'}`);
  attachListeners(p, `tab${ctx.pages().length}`);
});

const page = await ctx.newPage();
attachListeners(page, 'main');

console.log('→ login');
await page.goto(LOGIN, { waitUntil: 'domcontentloaded' });
await page.locator('#ucLogin1_txtUserName').fill(email);
await page.locator('#ucLogin1_txtPassword').fill(password);
await Promise.all([
  page.waitForLoadState('domcontentloaded'),
  page.locator('#ucLogin1_loginButton').click(),
]);
if (page.url().includes('Default.aspx')) {
  console.error('Login failed.');
  await browser.close();
  process.exit(2);
}
console.log('✔ logged in →', page.url());

console.log('\n=== INSTRUCTIONS ===');
console.log('1. Click a timesheet row in the Chromium window (the editor may open in a new tab).');
console.log('2. Fill one hour cell.');
console.log('3. Click Save.');
console.log('4. After POSTs stop streaming, hit Ctrl+C.');
console.log('\nPOSTs (and new-tab GETs) will print live. Files land in /tmp/ssw/.\n');

await new Promise(() => {});
