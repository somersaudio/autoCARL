// Persistent browser sessions: save cookies + localStorage to disk after each
// successful login, then load them on subsequent runs so we skip the login
// step entirely (as long as the session is still valid server-side).
//
// Files live in app.getPath('userData') alongside the config.

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';

type Service = 'carl' | 'ssw';

function statePath(service: Service): string {
  return join(app.getPath('userData'), `${service}-session.json`);
}

/** Returns the path if a saved state exists, else undefined. Playwright
 * accepts an absolute path string for `storageState`. */
export async function loadStorageState(service: Service): Promise<string | undefined> {
  const path = statePath(service);
  try {
    await fs.access(path);
    return path;
  } catch {
    return undefined;
  }
}

export async function saveStorageState(context: BrowserContext, service: Service): Promise<void> {
  try {
    await context.storageState({ path: statePath(service) });
  } catch {
    /* ignore — if we can't save, next run will just do a fresh login */
  }
}

export async function clearStorageState(service: Service): Promise<void> {
  await fs.unlink(statePath(service)).catch(() => {});
}
