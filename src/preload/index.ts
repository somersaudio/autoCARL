import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  Api, Booking, BookingContactsCache, ExpenseReport, ExpensesCache, FlightsCache, IngestOutcome,
  FriendsList, FriendsStatus, RefreshResult, SetupStatus, SswPushResult, SswWeek, UpdateProgress, UserSettings,
} from '../shared/types';

const api: Api = {
  setup: {
    getStatus: () => ipcRenderer.invoke('setup:getStatus') as Promise<SetupStatus>,
    saveCarl: (email, password) =>
      ipcRenderer.invoke('setup:saveCarl', email, password) as Promise<SetupStatus>,
    saveCarlWithUrl: (email, password, icalUrl) =>
      ipcRenderer.invoke('setup:saveCarlWithUrl', email, password, icalUrl) as Promise<SetupStatus>,
    saveSsw: (email, password) =>
      ipcRenderer.invoke('setup:saveSsw', email, password) as Promise<SetupStatus>,
    clear: () => ipcRenderer.invoke('setup:clear') as Promise<void>,
  },
  bookings: {
    getCached: () => ipcRenderer.invoke('bookings:getCached') as Promise<{ bookings: Booking[]; fetchedAt: string | null }>,
    refresh: () => ipcRenderer.invoke('bookings:refresh') as Promise<RefreshResult>,
    openInCarl: (bookingId) => ipcRenderer.invoke('bookings:openInCarl', bookingId) as Promise<void>,
    subscribe: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: RefreshResult) => handler(payload);
      ipcRenderer.on('bookings:refresh', listener);
      return () => ipcRenderer.removeListener('bookings:refresh', listener);
    },
  },
  flights: {
    getCached: () => ipcRenderer.invoke('flights:getCached') as Promise<FlightsCache>,
    open: (localPath) => ipcRenderer.invoke('flights:open', localPath) as Promise<void>,
    subscribe: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: FlightsCache) => handler(payload);
      ipcRenderer.on('flights:update', listener);
      return () => ipcRenderer.removeListener('flights:update', listener);
    },
  },
  contacts: {
    getCached: () => ipcRenderer.invoke('contacts:getCached') as Promise<BookingContactsCache>,
    subscribe: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: BookingContactsCache) => handler(payload);
      ipcRenderer.on('contacts:update', listener);
      return () => ipcRenderer.removeListener('contacts:update', listener);
    },
    markNotesSeen: (bookingId) => ipcRenderer.invoke('contacts:markNotesSeen', bookingId) as Promise<void>,
  },
  ssw: {
    getCached: (weekStartDate) =>
      ipcRenderer.invoke('ssw:getCached', weekStartDate) as Promise<SswWeek | null>,
    getCachedWeeks: () =>
      ipcRenderer.invoke('ssw:getCachedWeeks') as Promise<Record<string, SswWeek>>,
    identity: () =>
      ipcRenderer.invoke('ssw:identity') as Promise<{ name: string; userId: string } | null>,
    fetchWeek: (weekStartDate) =>
      ipcRenderer.invoke('ssw:fetchWeek', weekStartDate) as Promise<SswWeek | null>,
    createWeek: (weekStartDate) =>
      ipcRenderer.invoke('ssw:createWeek', weekStartDate) as Promise<SswWeek | null>,
    pushWeek: (week) =>
      ipcRenderer.invoke('ssw:pushWeek', week) as Promise<SswPushResult>,
  },
  logo: {
    forJob: (jobName) => ipcRenderer.invoke('logo:forJob', jobName) as Promise<string | null>,
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
  },
  friends: {
    status: () => ipcRenderer.invoke('friends:status') as Promise<FriendsStatus>,
    enroll: (name) => ipcRenderer.invoke('friends:enroll', name) as Promise<FriendsStatus>,
    list: () => ipcRenderer.invoke('friends:list') as Promise<FriendsList>,
    request: (email) => ipcRenderer.invoke('friends:request', email) as Promise<void>,
    respond: (email, accept) => ipcRenderer.invoke('friends:respond', email, accept) as Promise<void>,
    remove: (email) => ipcRenderer.invoke('friends:remove', email) as Promise<void>,
  },
  expenses: {
    getCached: () => ipcRenderer.invoke('expenses:getCached') as Promise<ExpensesCache>,
    addFiles: (paths, assignTo) => ipcRenderer.invoke('expenses:addFiles', paths, assignTo) as Promise<IngestOutcome>,
    pickFiles: (assignTo) => ipcRenderer.invoke('expenses:pickFiles', assignTo) as Promise<IngestOutcome | null>,
    updateReceipt: (id, patch) => ipcRenderer.invoke('expenses:updateReceipt', id, patch) as Promise<ExpensesCache>,
    removeReceipt: (id) => ipcRenderer.invoke('expenses:removeReceipt', id) as Promise<ExpensesCache>,
    openReceipt: (id) => ipcRenderer.invoke('expenses:openReceipt', id) as Promise<void>,
    buildDraft: (bookingIds) => ipcRenderer.invoke('expenses:buildDraft', bookingIds) as Promise<ExpenseReport>,
    saveReport: (report) => ipcRenderer.invoke('expenses:saveReport', report) as Promise<ExpensesCache>,
    removeReport: (id) => ipcRenderer.invoke('expenses:removeReport', id) as Promise<ExpensesCache>,
    resetGig: (bookingId, reportId) => ipcRenderer.invoke('expenses:resetGig', bookingId, reportId) as Promise<ExpensesCache>,
    exportReport: (report) => ipcRenderer.invoke('expenses:exportReport', report) as Promise<{ path: string } | null>,
    mailReport: (report) => ipcRenderer.invoke('expenses:mailReport', report) as Promise<void>,
    // Synchronous, preload-local — no IPC. Dropped File objects only resolve
    // to paths here, where webUtils is available.
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  updater: {
    onProgress: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: UpdateProgress) => handler(payload);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<UserSettings>,
    update: (patch) => ipcRenderer.invoke('settings:update', patch) as Promise<UserSettings>,
    getCredentials: () =>
      ipcRenderer.invoke('settings:getCredentials') as Promise<{ carlEmail: string; sswEmail: string }>,
    updateCarlCredentials: (email, password) =>
      ipcRenderer.invoke('settings:updateCarlCredentials', email, password) as Promise<{ ok: true } | { ok: false; error: string }>,
    updateSswCredentials: (email, password) =>
      ipcRenderer.invoke('settings:updateSswCredentials', email, password) as Promise<{ ok: true } | { ok: false; error: string }>,
  },
};

contextBridge.exposeInMainWorld('api', api);
