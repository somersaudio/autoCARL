// Path A proof-of-concept: log in to SSW, find this week's timesheet record,
// load its current inputs, and (in write mode) bump Monday's hours by 1 minute
// and save via a direct POST to /Page.aspx/Calculate.
//
//   node ssw-poc.mjs read    # safe — just login + load + dump
//   node ssw-poc.mjs write   # CHANGES YOUR TIMESHEET — bumps Monday end-time by 1 minute
//
// On success the script prints the new RecordId returned by the save POST.

import keytar from 'keytar';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { createSecureContext } from 'node:tls';

// SSW's TLS stack uses a Diffie-Hellman key smaller than modern Node accepts.
// Drop the OpenSSL security level so the handshake completes.
const insecureCtx = createSecureContext({ ciphers: 'DEFAULT:@SECLEVEL=0' });

const SSW = 'https://ctts.ctus.com/SpreadsheetWeb';
const APP_ID = 'ca66110c-107a-47f5-9896-7a6b87fcd7a0';            // Temp Tech Timesheet
const APP_KEY = '6d15fd2e153e41818d683f18459d3306';               // app-scoped, stable

const mode = process.argv[2] || 'read';
if (!['read', 'write'].includes(mode)) {
  console.error('Usage: node ssw-poc.mjs [read|write]');
  process.exit(1);
}

// --- credentials -----------------------------------------------------------

const cfgPath = join(homedir(), 'Library/Application Support/autocarl-v2/autocarl2-config.json');
if (!existsSync(cfgPath)) { console.error('Config not found.'); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const email = cfg.sswEmail;
const password = await keytar.getPassword('AUTOcarl2-ssw-password', email);
if (!email || !password) { console.error('Missing SSW creds.'); process.exit(1); }

// --- cookie-aware fetch wrapper -------------------------------------------

const cookies = new Map(); // name → value

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeSetCookies(setCookieHeader) {
  // Headers#getSetCookie returns an array in modern Node; fall back to a split.
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
  for (const raw of arr) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

// Returns { status, headers, text() } shape so the rest of the script can stay close to fetch().
function sswFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      Referer: SSW + '/',
      Origin: SSW,
      'User-Agent': 'Mozilla/5.0 (AUTOcarl-v2 POC)',
      Accept: 'text/html,application/json,*/*;q=0.9',
      ...(opts.headers || {}),
    };
    if (cookies.size) headers['Cookie'] = cookieHeader();
    const req = httpsRequest({
      method: opts.method || 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
      secureContext: insecureCtx,
    }, (res) => {
      const setCookies = res.headers['set-cookie'] || [];
      storeSetCookies(setCookies);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: async () => buf.toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// --- step 1: login ---------------------------------------------------------

async function login() {
  console.log('→ GET /Default.aspx (priming __VIEWSTATE, __EVENTVALIDATION)');
  const res1 = await sswFetch(`${SSW}/Default.aspx`);
  const html1 = await res1.text();
  const viewState = extractInput(html1, '__VIEWSTATE');
  const viewStateGenerator = extractInput(html1, '__VIEWSTATEGENERATOR');
  const eventValidation = extractInput(html1, '__EVENTVALIDATION');
  if (!viewState) throw new Error('Could not find __VIEWSTATE on login page');

  console.log('→ POST /Default.aspx (login)');
  const form = new URLSearchParams({
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGenerator || '',
    __EVENTVALIDATION: eventValidation || '',
    'ucLogin1$txtUserName': email,
    'ucLogin1$txtPassword': password,
    'ucLogin1$loginButton': 'Login',
  });
  const res2 = await sswFetch(`${SSW}/Default.aspx`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  // ASP.NET login redirects with 302 to Data.aspx on success.
  if (res2.status !== 302 && res2.status !== 200) {
    throw new Error(`Login failed: HTTP ${res2.status}`);
  }
  if (res2.status === 200) {
    const body = await res2.text();
    if (/login failed|incorrect/i.test(body)) throw new Error('Login rejected by SSW.');
  }
  console.log('✔ logged in');
}

function extractInput(html, name) {
  const re = new RegExp(`<input[^>]*name="${name.replace('$', '\\$')}"[^>]*value="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

// --- step 2: find this week's record id ------------------------------------

function thisWeekMonday(today = new Date()) {
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  // Monday-as-week-start
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

function formatMDY(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

async function listRecords() {
  // First we need a session token from the Data.aspx page.
  console.log('→ GET /UI/Pages/Data.aspx (for token)');
  const res = await sswFetch(`${SSW}/UI/Pages/Data.aspx?ApplicationID=${APP_ID}`);
  const html = await res.text();
  writeFileSync('/tmp/ssw/poc-data-aspx.html', html);
  // The token is embedded in a hidden field or script. Try several patterns.
  const patterns = [
    /<input[^>]+name="Token"[^>]+value="([^"]+)"/i,
    /<input[^>]+id="Token"[^>]+value="([^"]+)"/i,
    /"token"\s*:\s*"([^"]+)"/,
  ];
  let token = null;
  for (const re of patterns) {
    const m = html.match(re);
    if (m) { token = m[1]; break; }
  }
  if (!token) {
    console.error(`  → HTML dumped to /tmp/ssw/poc-data-aspx.html (${html.length} bytes)`);
    console.error(`  → grep it for token-shaped strings`);
    throw new Error('Could not find session token on Data.aspx');
  }
  console.log(`  token: ${token.slice(0, 16)}…`);

  console.log('→ POST /Data.aspx/GetDataGrid');
  const mkCol = (data, name) => ({
    data, name,
    searchable: true, orderable: true,
    search: { value: '', regex: false },
  });
  const gridReq = {
    gridRequest: {
      draw: 1,
      columns: [
        mkCol(0, 'iName'),
        mkCol(1, 'iDate'),
        mkCol(2, 'EntryDate'),
        mkCol(3, 'LastUpdateDate'),
        mkCol(4, 'CurrentStatusIndex'),
        mkCol(5, 'Actions'),
        mkCol(6, 'iJob'),
        mkCol(7, 'iLaborCoordinator'),
      ],
      order: [{ column: 1, dir: 'desc' }],
      start: 0,
      length: 50,
      search: { value: '', regex: false },
      applicationId: APP_ID,
    },
    token,
  };
  const res2 = await sswFetch(`${SSW}/UI/Pages/Data.aspx/GetDataGrid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(gridReq),
  });
  const txt = await res2.text();
  writeFileSync('/tmp/ssw/poc-getgrid-response.txt', txt);
  console.log(`  HTTP ${res2.status}, ${txt.length} bytes (dumped to /tmp/ssw/poc-getgrid-response.txt)`);
  let outer;
  try { outer = JSON.parse(txt); }
  catch { throw new Error(`Non-JSON GetDataGrid response: ${txt.slice(0, 300)}`); }
  if (!outer || typeof outer.d === 'undefined') {
    throw new Error(`GetDataGrid response missing .d field: ${JSON.stringify(outer).slice(0, 300)}`);
  }
  const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
  return { token, grid: inner };
}

// --- step 3: load current inputs ------------------------------------------

async function loadRecord(recordId) {
  console.log(`→ POST /Page.aspx/GetRecordExtended (RecordId=${recordId})`);
  const editorUrl = `${SSW}/App/CTUS/Temp+Tech+Timesheet-App?ApplicationID=${APP_ID}&RecordID=${recordId}&CloneUpdate=1&Act=Edit`;
  const res = await sswFetch(`${SSW}/Page.aspx/GetRecordExtended`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      accept: 'application/json, text/javascript, */*; q=0.01',
      referer: editorUrl,
    },
    body: JSON.stringify({ request: { ApplicationKey: APP_KEY, RecordId: String(recordId), UserName: '' } }),
  });
  const txt = await res.text();
  writeFileSync('/tmp/ssw/poc-getrecord-response.txt', txt);
  console.log(`  HTTP ${res.status}, ${txt.length} bytes`);
  let outer;
  try { outer = JSON.parse(txt); }
  catch { throw new Error(`Non-JSON response: ${txt.slice(0, 300)}`); }
  if (!outer || typeof outer.d === 'undefined') {
    throw new Error(`GetRecordExtended missing .d: ${JSON.stringify(outer).slice(0, 300)}`);
  }
  const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
  return inner;
}

// --- step 4: save ----------------------------------------------------------

// We re-use the exact payload shape we captured. The cleanest POC: take the
// captured save payload, swap RecordId for ours, optionally tweak one input,
// and post.
async function saveFromCaptured({ recordId, bumpMondayMinute }) {
  const captured = JSON.parse(readFileSync('/tmp/ssw/post-023.json', 'utf8'));
  const body = JSON.parse(captured.postData);
  body.request.SaveInformation.RecordId = String(recordId);
  if (bumpMondayMinute) {
    // Find iEnd_Time_OUT_Monday and bump by 1 minute. Format is e.g. "7:00 pm".
    const inp = body.request.Inputs.find((i) => i.Ref === 'iEnd_Time_OUT_Monday');
    if (inp && inp.Value?.[0]?.[0]?.Value) {
      const orig = inp.Value[0][0].Value;
      // Naive +1 minute on h:mm am/pm — only works when minutes < 59.
      const m = orig.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
      if (m) {
        let [_, hh, mm, ap] = m;
        let min = parseInt(mm, 10) + 1;
        let hr = parseInt(hh, 10);
        if (min === 60) { min = 0; hr = (hr % 12) + 1; }
        const bumped = `${hr}:${String(min).padStart(2, '0')} ${ap.toLowerCase()}`;
        console.log(`  Monday end-time: ${orig} → ${bumped}`);
        inp.Value[0][0].Value = bumped;
        // Mirror to iEndTime_Monday which carries a leading apostrophe.
        const inp2 = body.request.Inputs.find((i) => i.Ref === 'iEndTime_Monday');
        if (inp2?.Value?.[0]?.[0]) inp2.Value[0][0].Value = `'${bumped}`;
      }
    }
  }

  console.log('→ POST /Page.aspx/Calculate (Save=true)');
  const res = await sswFetch(`${SSW}/Page.aspx/Calculate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = null; }
  return { status: res.status, body: parsed || txt };
}

// --- main ------------------------------------------------------------------

await login();
const { grid } = await listRecords();

// Print the columns + first few rows so we can see what fields are available.
writeFileSync('/tmp/ssw/poc-grid.json', JSON.stringify(grid, null, 2));
const cols = grid.Columns?.map((c) => c.title) || [];
console.log('\nGrid columns:', cols);
console.log(`Rows: ${grid.Data?.length || 0}`);
if (grid.Data?.length) {
  console.log('First row sample:');
  console.log(JSON.stringify(grid.Data[0], null, 2).slice(0, 1500));
}

// Pick this week's RecordId from the grid. Each row is an array; the RecordId
// is the last element (and we can also identify the row via the "Week of" date
// at index 1).
const wantWeek = formatMDY(thisWeekMonday()); // e.g. "5/18/2026"
let liveRecordId = null;
for (const row of grid.Data || []) {
  if (!Array.isArray(row)) continue;
  const weekCell = String(row[1] || '');
  if (weekCell.startsWith(wantWeek + ' ')) {
    liveRecordId = String(row[row.length - 1]);
    break;
  }
}
if (!liveRecordId) {
  console.error(`No record found for week ${wantWeek} — script needs a row in the grid.`);
  process.exit(1);
}
console.log(`\nLive RecordId for week ${wantWeek}: ${liveRecordId}`);

const rec = await loadRecord(liveRecordId);
writeFileSync('/tmp/ssw/poc-record.json', JSON.stringify(rec, null, 2));
console.log(`✔ GetRecordExtended OK — dumped to /tmp/ssw/poc-record.json`);
console.log(`  PrimaryTable iName: ${rec.PrimaryTable?.iName}`);
console.log(`  PrimaryTable iDate: ${rec.PrimaryTable?.iDate}`);

if (mode === 'write') {
  console.log('\n=== WRITE MODE — about to bump Monday end-time by 1 minute ===');
  const result = await saveFromCaptured({ recordId: liveRecordId, bumpMondayMinute: true });
  console.log(`Save response status: ${result.status}`);
  writeFileSync('/tmp/ssw/poc-save-response.json', JSON.stringify(result, null, 2));
  const outputs = result.body?.d ? JSON.parse(result.body.d).Outputs : null;
  const oRecordId = outputs?.find((o) => o.Ref === 'oRecordId')?.Value?.[0]?.[0]?.Value;
  console.log(`Returned oRecordId: ${oRecordId || '(not in outputs — check /tmp/ssw/poc-save-response.json)'}`);
  if (result.body?.d) {
    const inner = JSON.parse(result.body.d);
    if (inner.Success === false || inner.InvalidToken) {
      console.error(`❌ Save reported failure: Success=${inner.Success} InvalidToken=${inner.InvalidToken}`);
      if (inner.Messages?.length) console.error('Messages:', inner.Messages);
      process.exit(3);
    }
    console.log(`✔ Save reported Success=${inner.Success}`);
  }
} else {
  console.log('\n(read-only mode — to actually save, run: node ssw-poc.mjs write)');
}
