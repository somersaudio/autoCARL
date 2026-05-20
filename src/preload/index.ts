import { contextBridge, ipcRenderer } from 'electron';
import type { Api, AppConfig, CredService, LoadExistingResult, LoadMostRecentResult, ProgressEvent, RefreshResult, SubmitResult, WeekEntry } from '../shared/types';

const api: Api = {
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
    update: (patch) => ipcRenderer.invoke('config:update', patch) as Promise<AppConfig>,
  },
  credentials: {
    save: (service: CredService, username, password) =>
      ipcRenderer.invoke('credentials:save', service, username, password) as Promise<void>,
    has: (service: CredService, username) =>
      ipcRenderer.invoke('credentials:has', service, username) as Promise<boolean>,
    clear: (service: CredService, username) =>
      ipcRenderer.invoke('credentials:clear', service, username) as Promise<void>,
  },
  carl: {
    refresh: () => ipcRenderer.invoke('carl:refresh') as Promise<RefreshResult>,
  },
  timesheet: {
    fill: (entry: WeekEntry) =>
      ipcRenderer.invoke('timesheet:fill', entry) as Promise<SubmitResult>,
    loadExisting: (jobNumber: string, weekOfMonday: string) =>
      ipcRenderer.invoke('timesheet:loadExisting', jobNumber, weekOfMonday) as Promise<LoadExistingResult>,
    loadMostRecent: () =>
      ipcRenderer.invoke('timesheet:loadMostRecent') as Promise<LoadMostRecentResult>,
  },
  progress: {
    subscribe: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: ProgressEvent) => handler(payload);
      ipcRenderer.on('progress', listener);
      return () => ipcRenderer.removeListener('progress', listener);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
