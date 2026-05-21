import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../shared/types';

const CONFIG_FILE = 'autocarl-config.json';

const DEFAULT_CONFIG: AppConfig = {
  carlUsername: '',
  sswUsername: '',
  pulledShows: [],
  pulledShowsAt: null,
  profile: null,
  weeklyDefaults: {
    dailyRate: null,
  },
  savedWeeks: {},
  sswAppId: null,
  theme: 'dark',
  autoApplySchedule: true,
  hideMealBreak: false,
};

function configPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE);
}

export async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      weeklyDefaults: { ...DEFAULT_CONFIG.weeklyDefaults, ...(parsed.weeklyDefaults || {}) },
      savedWeeks: parsed.savedWeeks || {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    throw err;
  }
}

export async function writeConfig(config: AppConfig): Promise<void> {
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await readConfig();
  const next = { ...current, ...patch };
  await writeConfig(next);
  return next;
}
