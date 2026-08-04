import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { discoverIcalUrl } from './ical-discover';
import { discoverIcalUrlViaApi } from './carl-api';
import { fetchAndParseBookings } from './ical';
import { getJobLogo } from './logodev';
import {
  clearCarlPassword, clearIcalUrl, clearSswPassword,
  getCarlPassword, getIcalUrl, getSswPassword,
  saveCarlPassword, saveIcalUrl, saveSswPassword,
  findStoredCarlEmail, findStoredSswEmail, migrateCredentials,
} from './credentials';
import {
  readCachedBookings, readConfig, updateConfig, writeCachedBookings,
  readFlightsCache, readSswWeek, readContactsCache, migrateStoreFiles,
} from './store';
import { sweepFlights } from './flight-fetcher';
import { createWeek, fetchWeek, pushWeek, testSswLogin } from './ssw';
import { loginCarl } from './carl-api';
import type {
  Booking, BookingContactsCache, FlightsCache, RefreshResult, SetupStatus, SswWeek, UpdateProgress,
  UserSettings,
} from '../shared/types';
import { FILING_STATUSES, type FilingStatus } from '../shared/taxes';
import { friendlyError } from '../shared/errors';

const isDev = !app.isPackaged;
const GITHUB_REPO = 'somersaudio/autoCARL';

// ----- auto-updater -------------------------------------------------------
//
// Mirrors v1's behaviour:
//   - macOS (unsigned DMG): check GitHub Releases once at launch; if a newer
//     tag exists, prompt the user to download the new DMG manually.
//   - Windows (signed installer): use electron-updater to download in the
//     background and prompt to restart (or install at next quit).
// Both no-op in dev (unpackaged builds).

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Track which version the user dismissed with "Later" so we don't re-prompt
// every poll. Resets to undefined on launch (and naturally when a newer
// release ships, since we compare exact version strings).
let macDismissedVersion: string | undefined;
// Avoid stacking dialogs if a previous poll's prompt is still open.
let macUpdatePromptOpen = false;

async function checkMacUpdateAndNotify(): Promise<void> {
  if (macUpdatePromptOpen) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const rel = (await res.json()) as { tag_name?: string };
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest || !isNewerVersion(latest, app.getVersion())) return;
    if (latest === macDismissedVersion) return;
    macUpdatePromptOpen = true;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `AUTOcarl ${latest} is available`,
      detail: `You're on ${app.getVersion()}. AUTOcarl will download, install, and relaunch — about 30 seconds.`,
    });
    macUpdatePromptOpen = false;
    if (response === 0) {
      try {
        await macAutoInstallUpdate();
      } catch (e) {
        // No browser fallback — surface the actual failure so we can fix it.
        await dialog.showMessageBox({
          type: 'error',
          message: 'AUTOcarl update failed',
          detail:
            `${e instanceof Error ? e.message : String(e)}\n\n` +
            `If this keeps happening, check /tmp/autocarl-update.log for the installer-script output and let support know.`,
        });
      }
    } else {
      macDismissedVersion = latest;
    }
  } catch {
    macUpdatePromptOpen = false;
    /* offline / API error — silently skip */
  }
}

// Locate the running app's .app bundle by walking up from the executable.
// Works regardless of asar packaging — `app.getAppPath()` points inside the
// bundle and varies between asar/no-asar layouts.
function findAppBundle(): string {
  let p = process.execPath;
  while (p && p !== '/' && !p.endsWith('.app')) {
    p = dirname(p);
  }
  if (!p || p === '/') {
    throw new Error(`Could not locate .app bundle starting from ${process.execPath}`);
  }
  return p;
}

// Download a URL to a local path, following redirects. `onProgress` is called
// with 0–100 as bytes arrive (only when the server reports Content-Length;
// GitHub's redirect target does).
function downloadFile(url: string, destPath: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryGet = (u: string, hops: number) => {
      if (hops > 6) return reject(new Error('Too many redirects'));
      const req = httpsRequest(u, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          tryGet(res.headers.location, hops + 1);
          return;
        }
        if (code !== 200) {
          reject(new Error(`HTTP ${code} downloading ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let lastPct = -1;
        const chunks: Buffer[] = [];
        res.on('data', (c) => {
          chunks.push(c);
          if (total > 0 && onProgress) {
            received += c.length;
            const pct = Math.min(100, Math.round((received / total) * 100));
            // Throttle to whole-percent changes so we don't spam IPC.
            if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
          }
        });
        res.on('end', async () => {
          try { await fs.writeFile(destPath, Buffer.concat(chunks)); resolve(); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120_000, () => req.destroy(new Error('download timed out')));
      req.end();
    };
    tryGet(url, 0);
  });
}

// Push an update-progress event to every open window + the macOS Dock.
function reportUpdateProgress(p: UpdateProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('update:progress', p); } catch { /* ignore */ }
    try {
      if (p.phase === 'downloading') w.setProgressBar(p.percent / 100);
      else w.setProgressBar(1, { mode: 'indeterminate' });
    } catch { /* ignore */ }
  }
}

// In-place install on macOS without code-signing requirements: download the
// ZIP of the new .app, write a detached shell script that waits for the
// current app to quit, swaps the bundle, and relaunches.
async function macAutoInstallUpdate(): Promise<void> {
  const arch = process.arch; // 'arm64' | 'x64'
  // Stable URL — no version in filename (see artifactName in package.json).
  const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/AUTOcarl-${arch}.zip`;

  // Locate the running .app bundle. We walk up from process.execPath because
  // app.getAppPath() points into the bundle and varies between asar layouts.
  const appBundle = findAppBundle();
  const parentDir = dirname(appBundle);

  const tmpZip = join(tmpdir(), `autocarl-update-${Date.now()}.zip`);
  const scriptPath = join(tmpdir(), `autocarl-update-${Date.now()}.sh`);
  const logPath = '/tmp/autocarl-update.log';

  reportUpdateProgress({ phase: 'downloading', percent: 0 });
  await downloadFile(url, tmpZip, (percent) => reportUpdateProgress({ phase: 'downloading', percent }));
  reportUpdateProgress({ phase: 'installing' });

  const myPid = process.pid;
  // Script waits for the running app to exit, then swaps the bundle and
  // relaunches. Output goes to /tmp/autocarl-update.log so we can debug
  // failures post-mortem (the parent app is dead by then so we can't log
  // through normal channels).
  const script = `#!/bin/sh
exec >> "${logPath}" 2>&1
echo "---- $(date -u +%Y-%m-%dT%H:%M:%SZ) autocarl update starting ----"
echo "appBundle: ${appBundle}"
echo "parentDir: ${parentDir}"
echo "tmpZip:    ${tmpZip}"
# Wait for the running AUTOcarl process to exit (max ~30s).
for i in $(seq 1 60); do
  if ! kill -0 ${myPid} 2>/dev/null; then echo "parent pid ${myPid} exited"; break; fi
  sleep 0.5
done
sleep 1
echo "removing old bundle"
rm -rf "${appBundle}" || { echo "rm failed"; exit 1; }
echo "extracting new bundle"
if command -v ditto >/dev/null 2>&1; then
  ditto -xk "${tmpZip}" "${parentDir}" || { echo "ditto failed"; exit 1; }
else
  /usr/bin/unzip -q -o "${tmpZip}" -d "${parentDir}" || { echo "unzip failed"; exit 1; }
fi
echo "stripping quarantine"
/usr/bin/xattr -dr com.apple.quarantine "${appBundle}" 2>/dev/null || true
echo "relaunching"
open "${appBundle}" || { echo "open failed"; exit 1; }
echo "cleanup"
rm -f "${tmpZip}" "${scriptPath}"
echo "---- done ----"
`;
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);

  // Detach the helper so it survives this process quitting.
  const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();

  app.quit();
}

function initWindowsAutoUpdater(): void {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: 'A new version of AUTOcarl is ready',
      detail: `Version ${info.version} has been downloaded. Restart to install it (otherwise it installs next time you quit).`,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.log('[autocarl] auto-update error:', err == null ? 'unknown' : (err.stack || err).toString());
  });

  autoUpdater.checkForUpdates().catch((e) => {
    console.log('[autocarl] checkForUpdates failed:', e instanceof Error ? e.message : e);
  });
}

function initAutoUpdater(): void {
  if (isDev) return;
  if (process.platform === 'win32') {
    initWindowsAutoUpdater();
    // electron-updater only auto-polls when feedURL is set explicitly; with
    // GitHub Releases we need to re-trigger checkForUpdates ourselves so a
    // running app picks up new releases instead of waiting for next launch.
    setInterval(() => {
      electronUpdater.autoUpdater.checkForUpdates().catch(() => { /* ignore */ });
    }, 10 * 60 * 1000);
  } else {
    checkMacUpdateAndNotify();
    setInterval(() => { checkMacUpdateAndNotify(); }, 10 * 60 * 1000);
  }
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    // Sized so the bookings list and the Settings modal both fit without
    // scrolling. Outer window size, title bar included.
    width: 899,
    height: 863,
    title: 'AUTOcarl',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Broadcast a refresh result to every open window's renderer.
function broadcastRefresh(payload: RefreshResult): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('bookings:refresh', payload); } catch { /* ignore */ }
  }
}

function broadcastFlights(payload: FlightsCache): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('flights:update', payload); } catch { /* ignore */ }
  }
}

function broadcastContacts(payload: BookingContactsCache): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('contacts:update', payload); } catch { /* ignore */ }
  }
}

// Runs once per app launch after we have fresh bookings + creds.
let flightSweepStartedThisLaunch = false;

// Append a line to userData/autocarl-sweep.log so packaged builds have a
// debuggable trail for the CARL sweep (PDFs + contacts + per-diem).
function logSweep(line: string): void {
  try {
    const path = join(app.getPath('userData'), 'autocarl-sweep.log');
    const stamp = new Date().toISOString();
    require('node:fs').appendFileSync(path, `${stamp} ${line}\n`);
  } catch { /* ignore */ }
}

async function maybeStartFlightSweep(bookings: Booking[]): Promise<void> {
  if (flightSweepStartedThisLaunch) return;
  const cfg = await readConfig();
  if (!cfg.carlEmail) { logSweep('skip: no carlEmail in config'); return; }
  const password = await getCarlPassword(cfg.carlEmail);
  if (!password) { logSweep(`skip: no CARL password in keychain for ${cfg.carlEmail}`); return; }
  flightSweepStartedThisLaunch = true;
  logSweep(`start: ${bookings.length} bookings, email=${cfg.carlEmail}`);
  sweepFlights(bookings, cfg.carlEmail, password, broadcastFlights, broadcastContacts)
    .then(() => logSweep('done: ok'))
    .catch((e) => logSweep(`FAILED: ${e instanceof Error ? (e.stack || e.message) : String(e)}`));
}

// If the config file is missing emails but the keychain still has stored
// credentials (e.g. a fresh-install packaged build inheriting a developer's
// dev-session keychain entries), restore the email accounts from keytar so
// downstream code that keys on email — like the CARL sweep — works.
async function recoverConfigFromKeychain(): Promise<void> {
  const cfg = await readConfig();
  const patch: Partial<typeof cfg> = {};
  if (!cfg.carlEmail) {
    const recovered = await findStoredCarlEmail();
    if (recovered) patch.carlEmail = recovered;
  }
  if (!cfg.sswEmail) {
    const recovered = await findStoredSswEmail();
    if (recovered) patch.sswEmail = recovered;
  }
  if (Object.keys(patch).length > 0) await updateConfig(patch);
}

async function currentSetupStatus(): Promise<SetupStatus> {
  await recoverConfigFromKeychain();
  const url = await getIcalUrl();
  if (!url) return { stage: 'needs-carl-credentials' };
  const cfg = await readConfig();
  if (!cfg.carlEmail) return { stage: 'needs-carl-credentials' };
  if (!cfg.sswEmail) return { stage: 'needs-ssw-credentials' };
  const sswPass = await getSswPassword(cfg.sswEmail);
  if (!sswPass) return { stage: 'needs-ssw-credentials' };
  return { stage: 'ready', icalUrl: url };
}

async function doRefresh(): Promise<RefreshResult> {
  const url = await getIcalUrl();
  if (!url) return { ok: false, error: 'No iCal URL configured — complete setup first.' };
  try {
    const bookings = await fetchAndParseBookings(url);
    const fetchedAt = await writeCachedBookings(bookings);
    maybeStartFlightSweep(bookings).catch(() => {});
    const payload: RefreshResult = { ok: true, bookings, fetchedAt };
    broadcastRefresh(payload);
    return payload;
  } catch (e) {
    const payload: RefreshResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    broadcastRefresh(payload);
    return payload;
  }
}

// Project the on-disk Config onto the renderer-facing UserSettings shape.
// Config also holds carlEmail/sswEmail, which the renderer gets through the
// dedicated credentials endpoint instead — keep them out of here.
function toUserSettings(cfg: Awaited<ReturnType<typeof readConfig>>): UserSettings {
  return {
    defaultStartTime: cfg.defaultStartTime,
    defaultEndTime: cfg.defaultEndTime,
    autofillPerDiem: cfg.autofillPerDiem,
    defaultDailyRate: cfg.defaultDailyRate,
    theme: cfg.theme,
    basePayDayRate: cfg.basePayDayRate,
    subtractTaxes: cfg.subtractTaxes,
    retirementPct: cfg.retirementPct,
    filingStatus: cfg.filingStatus,
    ytdWages: cfg.ytdWages,
    ytdAsOf: cfg.ytdAsOf,
    expectedAnnualWages: cfg.expectedAnnualWages,
    spouseAnnualWages: cfg.spouseAnnualWages,
    stateTaxRatePct: cfg.stateTaxRatePct,
  };
}

function nonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function registerIpc(): void {
  ipcMain.handle('setup:getStatus', () => currentSetupStatus());

  ipcMain.handle('setup:saveCarl', async (_e, email: string, password: string): Promise<SetupStatus> => {
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) return { stage: 'error', from: 'carl', message: 'Email and password are required.' };
    try {
      await saveCarlPassword(cleanEmail, password);
      await updateConfig({ carlEmail: cleanEmail });
      // Try the XHR path first (no Chromium binary needed — works on a fresh
      // install). Fall back to the Playwright-based discovery if the URL
      // formula doesn't validate for this user.
      let url: string;
      try {
        url = await discoverIcalUrlViaApi(cleanEmail, password);
      } catch (apiErr) {
        console.log('[setup] XHR iCal discovery failed, falling back to browser:', apiErr instanceof Error ? apiErr.message : apiErr);
        url = await discoverIcalUrl(cleanEmail, password);
      }
      await saveIcalUrl(url);
      // Kick off the first iCal fetch in the background.
      doRefresh().catch(() => {});
      return await currentSetupStatus();
    } catch (e) {
      return { stage: 'error', from: 'carl', message: friendlyError(e) };
    }
  });

  ipcMain.handle('setup:saveCarlWithUrl', async (_e, email: string, password: string, icalUrl: string): Promise<SetupStatus> => {
    const cleanEmail = email.trim();
    const cleanUrl = (icalUrl || '').trim();
    if (!cleanEmail || !password) return { stage: 'error', from: 'carl', message: 'Email and password are required.' };
    if (!cleanUrl) return { stage: 'error', from: 'carl', message: 'iCal URL is required.' };
    if (!/^https:\/\/calendar\..*carl\.ctus\.live\//.test(cleanUrl)) {
      return { stage: 'error', from: 'carl', message: 'That doesn\'t look like a CARL iCal URL. It should start with https://calendar.prod.carl.ctus.live/' };
    }
    try {
      await saveCarlPassword(cleanEmail, password);
      await updateConfig({ carlEmail: cleanEmail });
      await saveIcalUrl(cleanUrl);
      doRefresh().catch(() => {});
      return await currentSetupStatus();
    } catch (e) {
      return { stage: 'error', from: 'carl', message: friendlyError(e) };
    }
  });

  ipcMain.handle('setup:saveSsw', async (_e, email: string, password: string): Promise<SetupStatus> => {
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) return { stage: 'error', from: 'ssw', message: 'Email and password are required.' };
    try {
      await saveSswPassword(cleanEmail, password);
      await updateConfig({ sswEmail: cleanEmail });
      return await currentSetupStatus();
    } catch (e) {
      return { stage: 'error', from: 'ssw', message: friendlyError(e) };
    }
  });

  ipcMain.handle('setup:clear', async () => {
    const cfg = await readConfig();
    if (cfg.carlEmail) await clearCarlPassword(cfg.carlEmail).catch(() => {});
    if (cfg.sswEmail) await clearSswPassword(cfg.sswEmail).catch(() => {});
    await clearIcalUrl().catch(() => {});
    await updateConfig({ carlEmail: '', sswEmail: '' });
  });

  ipcMain.handle('bookings:getCached', () => readCachedBookings());
  ipcMain.handle('bookings:refresh', () => doRefresh());

  ipcMain.handle('flights:getCached', () => readFlightsCache());
  ipcMain.handle('flights:open', async (_e, localPath: string) => {
    const err = await shell.openPath(localPath);
    if (err) throw new Error(err);
  });

  ipcMain.handle('contacts:getCached', () => readContactsCache());

  ipcMain.handle('ssw:getCached', (_e, weekStartDate: string) => readSswWeek(weekStartDate));
  ipcMain.handle('ssw:fetchWeek', (_e, weekStartDate: string) => fetchWeek(weekStartDate));
  ipcMain.handle('ssw:createWeek', (_e, weekStartDate: string) => createWeek(weekStartDate));
  ipcMain.handle('ssw:pushWeek', (_e, week: SswWeek) => pushWeek(week));

  ipcMain.handle('logo:forJob', (_e, jobName: string) => getJobLogo(jobName));

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('settings:get', async () => toUserSettings(await readConfig()));
  ipcMain.handle('settings:update', async (_e, patch: Partial<UserSettings>) => {
    const allowed: Partial<UserSettings> = {};
    if (typeof patch?.defaultStartTime === 'string') allowed.defaultStartTime = patch.defaultStartTime.trim();
    if (typeof patch?.defaultEndTime === 'string') allowed.defaultEndTime = patch.defaultEndTime.trim();
    if (typeof patch?.autofillPerDiem === 'boolean') allowed.autofillPerDiem = patch.autofillPerDiem;
    if (nonNegative(patch?.defaultDailyRate)) allowed.defaultDailyRate = patch.defaultDailyRate as number;
    if (typeof patch?.theme === 'string' && patch.theme.trim()) allowed.theme = patch.theme.trim();
    if (nonNegative(patch?.basePayDayRate)) allowed.basePayDayRate = patch.basePayDayRate as number;
    if (typeof patch?.subtractTaxes === 'boolean') allowed.subtractTaxes = patch.subtractTaxes;
    // Percentages are clamped to 0–100 here as well as in the renderer, so a
    // malformed patch can't persist a rate that makes take-home go negative.
    if (nonNegative(patch?.retirementPct)) allowed.retirementPct = Math.min(patch.retirementPct as number, 100);
    if (nonNegative(patch?.stateTaxRatePct)) allowed.stateTaxRatePct = Math.min(patch.stateTaxRatePct as number, 100);
    if (nonNegative(patch?.ytdWages)) allowed.ytdWages = patch.ytdWages as number;
    // '' clears it (meaning "as of today"); otherwise require ISO YYYY-MM-DD.
    if (typeof patch?.ytdAsOf === 'string' && /^(\d{4}-\d{2}-\d{2})?$/.test(patch.ytdAsOf)) {
      allowed.ytdAsOf = patch.ytdAsOf;
    }
    if (nonNegative(patch?.expectedAnnualWages)) allowed.expectedAnnualWages = patch.expectedAnnualWages as number;
    if (nonNegative(patch?.spouseAnnualWages)) allowed.spouseAnnualWages = patch.spouseAnnualWages as number;
    if (FILING_STATUSES.includes(patch?.filingStatus as FilingStatus)) {
      allowed.filingStatus = patch.filingStatus as FilingStatus;
    }
    return toUserSettings(await updateConfig(allowed));
  });

  ipcMain.handle('settings:getCredentials', async () => {
    const cfg = await readConfig();
    return { carlEmail: cfg.carlEmail, sswEmail: cfg.sswEmail };
  });

  ipcMain.handle('settings:updateCarlCredentials', async (_e, email: string, password: string) => {
    const cleanEmail = (email || '').trim();
    if (!cleanEmail || !password) return { ok: false, error: 'Email and password are required.' };
    try {
      // Validate against CARL — if login fails, this throws.
      await loginCarl(cleanEmail, password);
      // Only persist after the test succeeds. If the email changed, also
      // clean up the old keychain entry so we don't leave stale passwords.
      const cfg = await readConfig();
      if (cfg.carlEmail && cfg.carlEmail !== cleanEmail) {
        await clearCarlPassword(cfg.carlEmail).catch(() => {});
      }
      await saveCarlPassword(cleanEmail, password);
      await updateConfig({ carlEmail: cleanEmail });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendlyError(e) };
    }
  });

  ipcMain.handle('settings:updateSswCredentials', async (_e, email: string, password: string) => {
    const cleanEmail = (email || '').trim();
    if (!cleanEmail || !password) return { ok: false, error: 'Email and password are required.' };
    try {
      await testSswLogin(cleanEmail, password);
      const cfg = await readConfig();
      if (cfg.sswEmail && cfg.sswEmail !== cleanEmail) {
        await clearSswPassword(cfg.sswEmail).catch(() => {});
      }
      await saveSswPassword(cleanEmail, password);
      await updateConfig({ sswEmail: cleanEmail });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendlyError(e) };
    }
  });
}

// Light-weight 5-min background poll once setup is complete. Real updates
// usually come in much smaller chunks — this is the safety net.
function startBackgroundPoll(): void {
  const FIVE_MIN = 5 * 60 * 1000;
  setInterval(async () => {
    const url = await getIcalUrl();
    if (url) doRefresh().catch(() => {});
  }, FIVE_MIN);
}

// Force CARL passwords / iCal URL into the keychain are silently consumed by
// the renderer-bound getter — let's also surface a typed reference so the
// async functions below are recognised as used by the type-checker.
void getCarlPassword;

app.whenReady().then(async () => {
  // Lift credentials and store files off their previous names before anything
  // reads them, so an existing install keeps its logins, settings and caches.
  await migrateCredentials();
  await migrateStoreFiles();
  registerIpc();
  await createWindow();
  startBackgroundPoll();
  initAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
