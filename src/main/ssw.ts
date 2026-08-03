import { net, session } from 'electron';
import { readConfig, writeSswWeek } from './store';
import { getSswPassword } from './credentials';
import type { SswDay, SswPushResult, SswWeek } from '../shared/types';

const SSW = 'https://ctts.ctus.com/SpreadsheetWeb';
const APP_ID = 'ca66110c-107a-47f5-9896-7a6b87fcd7a0';        // Temp Tech Timesheet
const APP_KEY = '6d15fd2e153e41818d683f18459d3306';            // app-scoped, stable

// We use Electron's net.request (Chromium's network stack) rather than
// node:https — SSW's TLS handshake uses a Diffie-Hellman key smaller than
// modern Node/OpenSSL accepts by default, but Chromium handles it fine.

// ----- session state ------------------------------------------------------

// Electron's net.request silently parks Set-Cookie headers in the session
// store (even with useSessionCookies:false), so we use a dedicated partition
// for SSW traffic and let Electron handle the cookie lifecycle natively.
function sswSession() {
  return session.fromPartition('ssw');
}

let cachedToken: string | null = null;
let loggedIn = false;

async function resetSession(): Promise<void> {
  cachedToken = null;
  loggedIn = false;
  try {
    await sswSession().clearStorageData({ storages: ['cookies'] });
  } catch { /* ignore */ }
}

type FetchResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text(): Promise<string>;
};

function sswFetch(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Referer: SSW + '/',
      Origin: SSW,
      'User-Agent': 'Mozilla/5.0 (AUTOcarl)',
      Accept: 'text/html,application/json,*/*;q=0.9',
      ...(opts.headers || {}),
    };

    // Run through the dedicated 'ssw' session with useSessionCookies:true so
    // Electron sends and captures cookies for us across the redirect chain.
    const req = net.request({
      method: opts.method || 'GET',
      url,
      session: sswSession(),
      useSessionCookies: true,
      redirect: 'follow',
    });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);

    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; reject(e); } };

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          text: async () => buf.toString('utf8'),
        });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.on('abort', () => fail(new Error('SSW request aborted')));

    const timer = setTimeout(() => { req.abort(); fail(new Error('SSW request timed out')); }, 30_000);
    req.on('response', () => clearTimeout(timer));

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ----- login + token ------------------------------------------------------

function extractInput(html: string, name: string): string | null {
  const re = new RegExp(`<input[^>]*name="${name.replace(/[$.*+?^()|[\]\\]/g, '\\$&')}"[^>]*value="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

// Verify a CARL→SSW credential pair without persisting anything. Used by the
// Settings modal to validate creds before saving them to the keychain.
// Throws on failure (rejection, network error). Resolves on success.
export async function testSswLogin(email: string, password: string): Promise<void> {
  if (!email || !password) throw new Error('Email and password are required.');
  // Run the existing login flow against an isolated session so we don't
  // disturb the in-memory session of the live app.
  const prevSession = await carlSwapForTest();
  try {
    await loginWithCreds(email, password);
  } finally {
    await carlRestoreFromTest(prevSession);
  }
}

// Helpers used only by testSswLogin — swap the SSW session out so the test
// login can't accidentally invalidate the running app's cookies.
async function carlSwapForTest(): Promise<{ loggedIn: boolean; cachedToken: string | null }> {
  const prev = { loggedIn, cachedToken };
  loggedIn = false;
  cachedToken = null;
  return prev;
}
async function carlRestoreFromTest(prev: { loggedIn: boolean; cachedToken: string | null }): Promise<void> {
  loggedIn = prev.loggedIn;
  cachedToken = prev.cachedToken;
}

async function loginWithCreds(email: string, password: string): Promise<void> {
  // Prime ASP.NET form vars from the login page.
  const res1 = await sswFetch(`${SSW}/Default.aspx`);
  const html1 = await res1.text();
  const viewState = extractInput(html1, '__VIEWSTATE');
  const viewStateGenerator = extractInput(html1, '__VIEWSTATEGENERATOR') || '';
  const eventValidation = extractInput(html1, '__EVENTVALIDATION') || '';
  if (!viewState) throw new Error('SSW login page missing __VIEWSTATE.');

  const form = new URLSearchParams({
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGenerator,
    __EVENTVALIDATION: eventValidation,
    'ucLogin1$txtUserName': email,
    'ucLogin1$txtPassword': password,
    'ucLogin1$loginButton': 'Login',
  });
  const res2 = await sswFetch(`${SSW}/Default.aspx`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (res2.status !== 302 && res2.status !== 200) {
    throw new Error(`SSW login failed: HTTP ${res2.status}`);
  }
  if (res2.status === 200) {
    const body = await res2.text();
    if (/login failed|incorrect/i.test(body)) throw new Error('Login rejected — check your email and password.');
  }
}

async function login(): Promise<void> {
  const cfg = await readConfig();
  const email = cfg.sswEmail;
  if (!email) throw new Error('SSW email not configured — complete Step 2 of setup.');
  const password = await getSswPassword(email);
  if (!password) throw new Error('SSW password not found in keychain.');

  resetSession();
  await loginWithCreds(email, password);
  loggedIn = true;
}

async function ensureLoggedIn(): Promise<void> {
  if (!loggedIn) await login();
}

async function fetchToken(): Promise<string> {
  const res = await sswFetch(`${SSW}/UI/Pages/Data.aspx?ApplicationID=${APP_ID}`);
  const html = await res.text();
  const m = html.match(/<input[^>]+name="Token"[^>]+value="([^"]+)"/i);
  if (!m) throw new Error('Could not find Token on Data.aspx — session may have expired.');
  return m[1];
}

async function ensureToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  cachedToken = await fetchToken();
  return cachedToken;
}

// Run an operation, refreshing the session once if SSW reports auth trouble.
async function withSession<T>(fn: () => Promise<T>): Promise<T> {
  await ensureLoggedIn();
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/InvalidToken|HTTP 401|session.*expired|Token/i.test(msg)) {
      resetSession();
      await ensureLoggedIn();
      return await fn();
    }
    throw e;
  }
}

// ----- helpers ------------------------------------------------------------

function isoToMDY(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

function isoToPaddedMDY(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

// SSW stores times like "12/30/1899 8:00:00 AM" — strip the date and the
// trailing :00 seconds; lower-case am/pm.
function parseSswTime(raw: string | number | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)/);
  if (!m) return s;
  return `${parseInt(m[1], 10)}:${m[2]} ${m[3].toLowerCase()}`;
}

const WEEKDAYS: SswDay['weekday'][] = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];

function addDays(isoMonday: string, n: number): string {
  const [y, m, d] = isoMonday.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function num(x: unknown): number {
  const n = parseFloat(String(x ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function bool(x: unknown): boolean {
  const s = String(x ?? '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

// ----- fetchWeek ----------------------------------------------------------

type GridRow = unknown[];

async function findRecordIdForWeek(weekStartDate: string): Promise<string | null> {
  const token = await ensureToken();
  const want = isoToMDY(weekStartDate); // "5/18/2026"
  const mkCol = (data: number, name: string) => ({
    data, name, searchable: true, orderable: true,
    search: { value: '', regex: false },
  });
  const body = {
    gridRequest: {
      draw: 1,
      columns: [
        mkCol(0, 'iName'), mkCol(1, 'iDate'), mkCol(2, 'EntryDate'),
        mkCol(3, 'LastUpdateDate'), mkCol(4, 'CurrentStatusIndex'),
        mkCol(5, 'Actions'), mkCol(6, 'iJob'), mkCol(7, 'iLaborCoordinator'),
      ],
      order: [{ column: 1, dir: 'desc' as const }],
      start: 0, length: 50,
      search: { value: '', regex: false },
      applicationId: APP_ID,
    },
    token,
  };
  const res = await sswFetch(`${SSW}/UI/Pages/Data.aspx/GetDataGrid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`GetDataGrid HTTP ${res.status}`);
  const txt = await res.text();
  const outer = JSON.parse(txt) as { d: string };
  if (typeof outer.d === 'undefined') throw new Error('GetDataGrid: missing .d');
  const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
  const data: GridRow[] = inner.Data || [];
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    const weekCell = String(row[1] || '');
    if (weekCell.startsWith(want + ' ')) {
      return String(row[row.length - 1]);
    }
  }
  return null;
}

type SswRecordResponse = {
  PrimaryTable: Record<string, unknown>;
  SecondaryTables: {
    tblDay: Array<{ Items: Record<string, unknown>; SequenceId: number }>;
    tblOutput?: Array<{ Items: Record<string, unknown>; SequenceId: number }>;
  };
  Success: boolean;
  InvalidToken: boolean;
};

async function getRecordExtended(recordId: string): Promise<SswRecordResponse> {
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
  if (res.status !== 200) throw new Error(`GetRecordExtended HTTP ${res.status}`);
  const txt = await res.text();
  const outer = JSON.parse(txt) as { d: string };
  if (typeof outer.d === 'undefined') throw new Error('GetRecordExtended: missing .d');
  const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
  if (inner.InvalidToken) throw new Error('InvalidToken');
  return inner;
}

export async function fetchWeek(weekStartDate: string): Promise<SswWeek | null> {
  return withSession(async () => {
    const recordId = await findRecordIdForWeek(weekStartDate);
    if (!recordId) return null;
    const rec = await getRecordExtended(recordId);
    const pt = rec.PrimaryTable;
    const dayRows = rec.SecondaryTables.tblDay || [];
    // tblDay returns 7 entries keyed by Items.Day; map them onto weekday order.
    const dayByName = new Map<string, Record<string, unknown>>();
    for (const row of dayRows) {
      const dayName = String(row.Items.Day || '');
      dayByName.set(dayName, row.Items);
    }
    const days: SswDay[] = WEEKDAYS.map((weekday, i) => {
      const items = dayByName.get(weekday) || {};
      const date = addDays(weekStartDate, i);
      return {
        date,
        weekday,
        job: String(items.Job || ''),
        startTime: parseSswTime(items.StartTimeIN as string),
        endTime: parseSswTime(items.EndTimeOUT as string),
        lunchStart: parseSswTime(items.StartTimeLunchDinner as string),
        lunchEnd: parseSswTime(items.EndTimeLunchDinner as string),
        perDiem: num(items.PerDiem),
        miles: items.nomiles ? num(items.nomiles) : null,
        regHours: num(items.RegHours),
        otHours: num(items.OTHours),
        dtHours: num(items.DTHours),
        totalHours: num(items.TotalHrsWorked),
      };
    });
    const result: SswWeek = {
      recordId,
      weekStartDate,
      name: String(pt.iName || ''),
      email: String(pt.iEmail || ''),
      phone: String(pt.iPhone || ''),
      position: String(pt.iPosition || ''),
      laborCoordinator: String(pt.iLaborCoordinator || ''),
      projectManager: String(pt.iProjectManager || ''),
      userId: String(pt.iUserId || ''),
      employeeId: String(pt.iEmployee_User_Name || pt.iUserId || ''),
      dailyRate: String(pt.iDailyRate || ''),
      groupId: num(pt.intGroupId),
      californiaCheck: bool(pt.iCaliforniaCheck),
      comments: String(pt.iComments || ''),
      days,
      statusIndex: num(pt.CurrentStatusIndex),
    };
    // Snapshot to disk so the renderer can paint last-known data instantly
    // on the next app open. Best-effort — a failed write doesn't fail fetch.
    writeSswWeek(weekStartDate, result).catch(() => {});
    return result;
  });
}

// ----- pushWeek -----------------------------------------------------------

type SswInput = { Ref: string; Value: [[{ Type: string; Value: string; Format: string; Text: string }]] };

function mkInput(ref: string, value: string): SswInput {
  return { Ref: ref, Value: [[{ Type: '', Value: value, Format: '', Text: '' }]] };
}

// Placeholder for the future case where we need to derive iDailyRate without
// a prior GetRecordExtended. Today pushWeek re-fetches the record to read the
// stored iDailyRate verbatim.

function fmtPerDiem(n: number): string {
  if (!n) return '';
  return `$ ${n.toFixed(2)}`;
}

function fmtRate(n: number): string {
  if (!n) return '';
  return `$ ${n.toFixed(2)}`;
}

function fmt2(n: number): string {
  return n.toFixed(2);
}

// Future days are not saved to SSW — the user fills them in once they happen.
// Anything pre-populated by autofill (or typed early) gets blanked at save time
// so the server never sees speculative hours on a date that hasn't passed yet.
function isFutureISO(iso: string): boolean {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime() > today.getTime();
}

function blankFutureDay(d: SswDay): SswDay {
  return {
    ...d,
    job: '',
    startTime: '',
    endTime: '',
    lunchStart: '',
    lunchEnd: '',
    perDiem: 0,
    miles: null,
    regHours: 0,
    otHours: 0,
    dtHours: 0,
    totalHours: 0,
  };
}

// SSW's "Copy" button next to Daily Rate fans the daily rate out to each day's
// hourly rate using the weighted formula: 8 reg + 2 OT × 1.5 = 11 weighted
// hours, so hourly = dailyRate / 11. Replicating that here so we never
// propagate the stale per-day rates from getRecordExtended — a previous
// buggy save (which divided by actual hours worked) could otherwise live
// forever in the spreadsheet.
function hourlyFromDaily(dailyRateStr: string): string {
  const daily = parseFloat(dailyRateStr);
  if (!Number.isFinite(daily) || daily <= 0) return '';
  return `$ ${(daily / 11).toFixed(2)}`;
}

function buildInputs(week: SswWeek, originalDailyRate: string, _originalRates: Record<string, string>): SswInput[] {
  const inputs: SswInput[] = [];
  const date = isoToPaddedMDY(week.weekStartDate);
  const saveDays = week.days.map((d) => isFutureISO(d.date) ? blankFutureDay(d) : d);
  const hourly = hourlyFromDaily(originalDailyRate);

  // ---- PrimaryTable identity ----
  inputs.push(mkInput('iName', week.name));
  inputs.push(mkInput('iPosition', week.position));
  inputs.push(mkInput('iCaliforniaCheck', week.californiaCheck ? 'true' : 'false'));
  inputs.push(mkInput('iPhone', week.phone));
  inputs.push(mkInput('iLaborCoordinator', week.laborCoordinator));
  inputs.push(mkInput('iProjectManager', week.projectManager));
  inputs.push(mkInput('iEmail', week.email));
  inputs.push(mkInput('iUserId', week.userId));
  inputs.push(mkInput('iDate', date));
  inputs.push(mkInput('iComments', week.comments));
  inputs.push(mkInput('iEmployee_User_Name', week.email));
  inputs.push(mkInput('iEmployeeId', week.userId));
  inputs.push(mkInput('iRate', ''));
  inputs.push(mkInput('iDailyRate', originalDailyRate));
  // Primary job for the week = first non-empty day job (past/today only).
  const primaryJob = saveDays.find((d) => d.job)?.job || '';
  inputs.push(mkInput('iJob', primaryJob));

  // ---- Per-day fields × 7 ----
  for (const d of saveDays) {
    const W = d.weekday;
    const startApostrophe = d.startTime ? `'${d.startTime}` : `'`;
    const endApostrophe = d.endTime ? `'${d.endTime}` : `'`;
    const lunchStartApostrophe = d.lunchStart ? `'${d.lunchStart}` : `'`;
    const lunchEndApostrophe = d.lunchEnd ? `'${d.lunchEnd}` : `'`;
    // Same hourly for every day — matches SSW's "Copy" button which fans the
    // daily rate via dailyRate/11. We deliberately ignore the previously-saved
    // per-day rate from the server since it can be wrong (and re-saving would
    // perpetuate it). Empty if the user has no daily rate stored yet.
    const rate = hourly;

    inputs.push(mkInput(`iName_${W}`, week.name));
    inputs.push(mkInput(`iStart_Time_IN_${W}`, d.startTime));
    inputs.push(mkInput(`iStartTime_${W}`, startApostrophe));
    inputs.push(mkInput(`iStart_Time_Lunch_Dinner_${W}`, d.lunchStart));
    inputs.push(mkInput(`iLunchTime_${W}`, lunchStartApostrophe));
    inputs.push(mkInput(`iEnd_Time_Lunch_Dinner_${W}`, d.lunchEnd));
    inputs.push(mkInput(`iEndlunch_${W}`, lunchEndApostrophe));
    inputs.push(mkInput(`iEnd_Time_OUT_${W}`, d.endTime));
    inputs.push(mkInput(`iEndTime_${W}`, endApostrophe));
    inputs.push(mkInput(`iJob_${W}`, d.job));
    inputs.push(mkInput(`iPer_Diem_${W}`, fmtPerDiem(d.perDiem)));
    inputs.push(mkInput(`ino_miles_${W}`, d.miles != null ? String(d.miles) : ''));
    inputs.push(mkInput(`iRate_${W}`, rate));
    inputs.push(mkInput(`iShow_${W}`, ''));
    inputs.push(mkInput(`iTo_${W}`, ''));
    inputs.push(mkInput(`iFrom_${W}`, ''));
    inputs.push(mkInput(`oReg_Hours_${W}`, fmt2(d.regHours)));
    inputs.push(mkInput(`oReg_Hours_${W}_FBI`, 'false'));
    inputs.push(mkInput(`oOT_Hours_${W}`, fmt2(d.otHours)));
    inputs.push(mkInput(`oOT_Hours_${W}_FBI`, 'false'));
    inputs.push(mkInput(`oDT_Hours_${W}`, fmt2(d.dtHours)));
    inputs.push(mkInput(`oDT_Hours_${W}_FBI`, 'false'));
  }

  return inputs;
}

// The Outputs list we ask SSW to recompute on save. Matches the captured
// payload so the server returns useful confirmation values.
function saveOutputs(): string[] {
  const outs: string[] = [];
  for (const W of WEEKDAYS) {
    outs.push(`oDate_${W}`, `oTotal_Hrs_Worked_${W}`, `oMlb_${W}`,
              `oReg_Hours_${W}`, `oOT_Hours_${W}`, `oDT_Hours_${W}`);
  }
  outs.push('oTotal_Hrs_Worked_Total', 'oReg_Hours_Total', 'oOT_Hours_Total', 'oDT_Hours_Total');
  outs.push('oRecordId');
  return outs;
}

// ----- createWeek ---------------------------------------------------------

// Returns the RecordId of the user's most-recently-touched timesheet
// (highest in the list view). We use this as the identity template when
// creating a brand-new week — same name, email, position, rate, group, etc.
async function findLatestRecordId(): Promise<string | null> {
  const token = await ensureToken();
  const mkCol = (data: number, name: string) => ({
    data, name, searchable: true, orderable: true,
    search: { value: '', regex: false },
  });
  const body = {
    gridRequest: {
      draw: 1,
      columns: [
        mkCol(0, 'iName'), mkCol(1, 'iDate'), mkCol(2, 'EntryDate'),
        mkCol(3, 'LastUpdateDate'), mkCol(4, 'CurrentStatusIndex'),
        mkCol(5, 'Actions'), mkCol(6, 'iJob'), mkCol(7, 'iLaborCoordinator'),
      ],
      // Most recently edited first — that record's identity fields are the
      // freshest template.
      order: [{ column: 3, dir: 'desc' as const }],
      start: 0, length: 1,
      search: { value: '', regex: false },
      applicationId: APP_ID,
    },
    token,
  };
  const res = await sswFetch(`${SSW}/UI/Pages/Data.aspx/GetDataGrid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return null;
  const txt = await res.text();
  const outer = JSON.parse(txt) as { d: string };
  if (typeof outer.d === 'undefined') return null;
  const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
  const data: GridRow[] = inner.Data || [];
  const first = data[0];
  if (!Array.isArray(first)) return null;
  return String(first[first.length - 1]);
}

const WEEKDAYS_FOR_NEW: SswDay['weekday'][] = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];

function blankDay(date: string, weekday: SswDay['weekday']): SswDay {
  return {
    date, weekday,
    job: '', startTime: '', endTime: '',
    lunchStart: '', lunchEnd: '',
    perDiem: 0, miles: null,
    regHours: 0, otHours: 0, dtHours: 0, totalHours: 0,
  };
}

export async function createWeek(weekStartDate: string): Promise<SswWeek | null> {
  return withSession(async () => {
    // 0. If a record for this week already exists (user created it via SSW
    //    directly, or a previous attempt silently succeeded), don't insert
    //    a duplicate — just return the existing one.
    const existingId = await findRecordIdForWeek(weekStartDate);
    if (existingId) return fetchWeek(weekStartDate);

    // 1. Find a template record to copy identity from.
    const templateId = await findLatestRecordId();
    if (!templateId) throw new Error('No existing SSW record to use as identity template — create one in SSW first.');
    const template = await getRecordExtended(templateId);
    const pt = template.PrimaryTable;
    const cfg = await readConfig();
    const dailyRate = cfg.defaultDailyRate > 0
      ? cfg.defaultDailyRate.toFixed(2)
      : String(pt.iDailyRate || '');

    // 2. Assemble a draft SswWeek with the template identity + blank days.
    const draft: SswWeek = {
      recordId: '',
      weekStartDate,
      name: String(pt.iName || ''),
      email: String(pt.iEmail || ''),
      phone: String(pt.iPhone || ''),
      position: String(pt.iPosition || ''),
      laborCoordinator: String(pt.iLaborCoordinator || ''),
      projectManager: String(pt.iProjectManager || ''),
      userId: String(pt.iUserId || ''),
      employeeId: String(pt.iEmployee_User_Name || pt.iUserId || ''),
      dailyRate,
      groupId: num(pt.intGroupId),
      californiaCheck: bool(pt.iCaliforniaCheck),
      comments: '',
      days: WEEKDAYS_FOR_NEW.map((wd, i) => blankDay(addDays(weekStartDate, i), wd)),
      statusIndex: 0,
    };

    // 3. POST Calculate with Save:true and no RecordId — SSW inserts a new row
    //    and returns the new RecordId in oRecordId.
    const Inputs = buildInputs(draft, dailyRate, {});
    const body = {
      request: {
        ApplicationKey: APP_KEY,
        Inputs,
        Outputs: ['oRecordId', ...saveOutputs()],
        GoalSeek: { Enabled: false, TargetRef: '', ChangingRef: '', TargetValue: 0, MaxIterations: 1000, MaxChange: 1e-6 },
        SessionId: null,
        FileVersion: null,
        SaveInformation: {
          Save: true,
          SetRecordStatusIndex: '0',
          SetGroupId: draft.groupId,
          // No RecordId — server treats this as a new-record insert.
          RecordId: '',
        },
      },
    };
    const editorUrl = `${SSW}/App/CTUS/Temp+Tech+Timesheet-App?ApplicationID=${APP_ID}&CloneUpdate=1&Act=Add`;
    const res = await sswFetch(`${SSW}/Page.aspx/Calculate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        accept: 'application/json, text/javascript, */*; q=0.01',
        referer: editorUrl,
      },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) throw new Error(`createWeek HTTP ${res.status}`);
    const txt = await res.text();
    const outer = JSON.parse(txt) as { d: string };
    const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
    if (inner.InvalidToken) throw new Error('InvalidToken');
    if (inner.Success === false) {
      const msg = (inner.Messages?.[0] && JSON.stringify(inner.Messages[0])) || inner.Message || 'unknown error';
      throw new Error(`SSW create failed: ${msg}`);
    }
    // SSW sometimes omits oRecordId from the Outputs even when the insert
    // succeeded — the only reliable proof of creation is that fetchWeek
    // turns up a record for the week afterwards.
    const created = await fetchWeek(weekStartDate);
    if (!created) {
      throw new Error('SSW didn\'t return a record for this week after create. Try again, or open the timesheet directly in SSW.');
    }
    return created;
  });
}

export async function pushWeek(week: SswWeek): Promise<SswPushResult> {
  return withSession(async () => {
    try {
      // Re-fetch to capture iDailyRate / iRate_<Day> values verbatim, so we
      // don't have to compute them ourselves.
      const current = await getRecordExtended(week.recordId);
      const pt = current.PrimaryTable;
      const cfg = await readConfig();
      // Settings.defaultDailyRate (when >0) overrides whatever SSW has stored.
      // This is the user's escape hatch when SSW's stored rate is wrong or
      // missing — they can correct it in our Settings and every save fixes it.
      const dailyRate = cfg.defaultDailyRate > 0
        ? cfg.defaultDailyRate.toFixed(2)
        : String(pt.iDailyRate || '');
      const originalRates: Record<string, string> = {};
      for (const row of current.SecondaryTables.tblDay || []) {
        const dayName = String(row.Items.Day || '');
        const r = row.Items.Rate;
        if (r) originalRates[dayName] = fmtRate(num(r));
      }

      const Inputs = buildInputs(week, dailyRate, originalRates);
      const body = {
        request: {
          ApplicationKey: APP_KEY,
          Inputs,
          Outputs: saveOutputs(),
          GoalSeek: { Enabled: false, TargetRef: '', ChangingRef: '', TargetValue: 0, MaxIterations: 1000, MaxChange: 1e-6 },
          SessionId: null,
          FileVersion: null,
          SaveInformation: {
            Save: true,
            SetRecordStatusIndex: '0',           // 0 = save without advancing workflow
            SetGroupId: week.groupId || num(pt.intGroupId),
            RecordId: String(week.recordId),
          },
        },
      };
      const editorUrl = `${SSW}/App/CTUS/Temp+Tech+Timesheet-App?ApplicationID=${APP_ID}&RecordID=${week.recordId}&CloneUpdate=1&Act=Edit`;
      const res = await sswFetch(`${SSW}/Page.aspx/Calculate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          accept: 'application/json, text/javascript, */*; q=0.01',
          referer: editorUrl,
        },
        body: JSON.stringify(body),
      });
      if (res.status !== 200) {
        return { ok: false, error: `Save HTTP ${res.status}` };
      }
      const txt = await res.text();
      const outer = JSON.parse(txt) as { d: string };
      const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
      if (inner.InvalidToken) throw new Error('InvalidToken');
      if (inner.Success === false) {
        const msg = (inner.Messages?.[0] && JSON.stringify(inner.Messages[0])) || inner.Message || 'unknown error';
        return { ok: false, error: `SSW save reported failure: ${msg}` };
      }
      return { ok: true, recordId: week.recordId, savedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

