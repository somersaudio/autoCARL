import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';
import { readConfig, updateConfig } from './config';
import { saveCredential, hasCredential, clearCredential, getCredential } from './credentials';
import { scrapeCarl } from '../automation/scrapeCarl';
import { fillTimesheet } from '../automation/submitTimesheet';
import { loadExistingTimesheet, loadMostRecentTimesheet } from '../automation/loadExisting';
import { getShowLogo } from '../automation/logodev';
import { weekKey, type CredService, type ProgressOp, type SavedWeek, type WeekEntry } from '../shared/types';

function makeReporter(op: ProgressOp) {
  return (percent: number, label: string) => {
    const payload = { op, percent, label, done: percent >= 100 };
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('progress', payload); } catch { /* ignore */ }
    }
  };
}

const isDev = !app.isPackaged;

// Auto-update from GitHub Releases. Checks once on launch; downloads in the
// background; prompts to restart when ready. No-ops in dev (unpackaged).
function initAutoUpdater(): void {
  if (isDev) return;
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

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
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

let loadExistingInFlight = false;

function registerIpc(): void {
  ipcMain.handle('config:get', () => readConfig());
  ipcMain.handle('config:update', (_e, patch) => updateConfig(patch));

  ipcMain.handle('credentials:save', (_e, service: CredService, username: string, password: string) =>
    saveCredential(service, username, password),
  );
  ipcMain.handle('credentials:has', (_e, service: CredService, username: string) =>
    hasCredential(service, username),
  );
  ipcMain.handle('credentials:clear', (_e, service: CredService, username: string) =>
    clearCredential(service, username),
  );

  ipcMain.handle('logo:forShow', (_e, jobName: string) => getShowLogo(jobName));

  ipcMain.handle('carl:refresh', async () => {
    const config = await readConfig();
    if (!config.carlUsername) return { ok: false, error: 'C.A.R.L. username not configured' };
    const password = await getCredential('carl', config.carlUsername);
    if (!password) return { ok: false, error: 'No saved C.A.R.L. password for ' + config.carlUsername };

    const result = await scrapeCarl({ username: config.carlUsername, password });
    if (result.ok) {
      await updateConfig({
        pulledShows: result.shows,
        pulledShowsAt: new Date().toISOString(),
        profile: result.profile,
      });
    }
    return result;
  });

  ipcMain.handle('timesheet:fill', async (_e, entry: WeekEntry) => {
    const config = await readConfig();
    const show = config.pulledShows.find((s) => s.jobNumber === entry.jobNumber);
    if (!show) return { ok: false, error: 'Selected show not found in pulled shows. Refresh from C.A.R.L. first.' };
    if (!config.profile) return { ok: false, error: 'No C.A.R.L. profile cached. Refresh from C.A.R.L. first.' };
    if (!config.sswUsername) return { ok: false, error: 'SpreadsheetWeb username not configured' };
    const sswPassword = await getCredential('ssw', config.sswUsername);
    if (!sswPassword) return { ok: false, error: 'No saved SpreadsheetWeb password' };

    const key = weekKey(entry.jobNumber, entry.weekOfMonday);
    const existing = config.savedWeeks[key];

    const result = await fillTimesheet({
      sswUsername: config.sswUsername,
      sswPassword,
      show,
      profile: config.profile,
      entry,
      dailyRate: config.weeklyDefaults.dailyRate,
      existingRecordId: existing?.sswRecordId ?? null,
      sswAppId: config.sswAppId,
    }, makeReporter('ssw-fill'));

    if (result.ok) {
      // Persist this week's state locally so we can preload next time.
      const saved: SavedWeek = {
        jobNumber: entry.jobNumber,
        weekOfMonday: entry.weekOfMonday,
        days: entry.days,
        includePerDiem: entry.includePerDiem,
        lastSavedAt: new Date().toISOString(),
        sswRecordId: result.sswRecordId ?? existing?.sswRecordId ?? null,
      };
      const next = await readConfig();
      next.savedWeeks[key] = saved;
      const patch: Partial<typeof next> = { savedWeeks: next.savedWeeks };
      if (result.sswAppId && result.sswAppId !== config.sswAppId) {
        patch.sswAppId = result.sswAppId;
      }
      await updateConfig(patch);
    }
    return result;
  });

  ipcMain.handle('timesheet:loadMostRecent', async () => {
    const config = await readConfig();
    if (!config.sswUsername) return { ok: false, error: 'SpreadsheetWeb username not configured' };
    const sswPassword = await getCredential('ssw', config.sswUsername);
    if (!sswPassword) return { ok: false, error: 'No saved SpreadsheetWeb password' };

    const result = await loadMostRecentTimesheet({
      sswUsername: config.sswUsername,
      sswPassword,
      sswAppId: config.sswAppId,
    }, makeReporter('ssw-load-most-recent'));

    if (result.ok && result.record) {
      const next = await readConfig();
      const key = weekKey(result.record.jobNumber, result.record.weekOfMonday);
      next.savedWeeks[key] = {
        jobNumber: result.record.jobNumber,
        weekOfMonday: result.record.weekOfMonday,
        days: result.record.days,
        includePerDiem: result.record.includePerDiem,
        lastSavedAt: new Date().toISOString(),
        sswRecordId: result.record.recordId,
        sswStatus: result.record.status,
      };
      const patch: Partial<typeof next> = { savedWeeks: next.savedWeeks };
      if (result.sswAppId && result.sswAppId !== config.sswAppId) patch.sswAppId = result.sswAppId;
      await updateConfig(patch);
    }
    return result;
  });

  ipcMain.handle('timesheet:loadExisting', async (_e, jobNumber: string, weekOfMonday: string) => {
    // Hard cap: never run two SSW load browsers in parallel. A renderer bug
    // that re-fires this IPC must not spawn N headless Chromiums.
    if (loadExistingInFlight) {
      return { ok: false, error: 'A timesheet load is already in progress' };
    }
    loadExistingInFlight = true;
    try {
    const config = await readConfig();
    if (!config.sswUsername) return { ok: false, error: 'SpreadsheetWeb username not configured' };
    const sswPassword = await getCredential('ssw', config.sswUsername);
    if (!sswPassword) return { ok: false, error: 'No saved SpreadsheetWeb password' };

    const result = await loadExistingTimesheet({
      sswUsername: config.sswUsername,
      sswPassword,
      jobNumber,
      weekOfMonday,
      sswAppId: config.sswAppId,
    }, makeReporter('ssw-load'));

    // Cache results: local week (if found) + app ID (if newly discovered).
    if (result.ok) {
      const next = await readConfig();
      const patch: Partial<typeof next> = {};
      if (result.existing) {
        const key = weekKey(jobNumber, weekOfMonday);
        const saved: SavedWeek = {
          jobNumber,
          weekOfMonday,
          days: result.existing.days,
          includePerDiem: result.existing.includePerDiem,
          lastSavedAt: new Date().toISOString(),
          sswRecordId: result.existing.recordId,
          sswStatus: result.existing.status,
        };
        next.savedWeeks[key] = saved;
        patch.savedWeeks = next.savedWeeks;
      }
      if (result.sswAppId && result.sswAppId !== config.sswAppId) {
        patch.sswAppId = result.sswAppId;
      }
      if (Object.keys(patch).length) await updateConfig(patch);
    }
    return result;
    } finally {
      loadExistingInFlight = false;
    }
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  initAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
