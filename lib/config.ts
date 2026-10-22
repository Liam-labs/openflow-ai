import { promises as fs } from 'fs';
import path from 'path';
import { APP_CWD } from './app-paths';
import { Config, Project } from './types';
import { withFileLock } from './data-io';

// Runtime config lives in .AppData (user data). Legacy config in config/ (product data).
const RUNTIME_CONFIG_PATH = path.join(/* turbopackIgnore: true */ APP_CWD, '.AppData', 'projects.json');
const LEGACY_CONFIG_PATH = path.join(/* turbopackIgnore: true */ APP_CWD, 'config', 'projects.json');

const EMPTY_CONFIG: Config = {
  projects: [],
  settings: {
    refreshInterval: 2000,
    defaultCategory: 'all',
  },
};

export async function loadConfig(): Promise<Config> {
  // 1. Try runtime config (.AppData/projects.json)
  try {
    const content = await fs.readFile(RUNTIME_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Not found — check for legacy migration
  }

  // 2. Migrate from legacy config/projects.json (existing installs)
  try {
    const content = await fs.readFile(LEGACY_CONFIG_PATH, 'utf-8');
    const config: Config = JSON.parse(content);
    if (config.projects && config.projects.length > 0) {
      // Migrate: copy to runtime path so future reads/writes use .AppData
      await fs.mkdir(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true });
      await fs.writeFile(RUNTIME_CONFIG_PATH, content, 'utf-8');
      return config;
    }
  } catch {
    // No legacy config either
  }

  // 3. Fresh install — empty config
  return EMPTY_CONFIG;
}

export async function saveConfig(config: Config): Promise<void> {
  await fs.mkdir(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true });
  await withFileLock(RUNTIME_CONFIG_PATH, async () => {
    await fs.writeFile(RUNTIME_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  });
}

export async function getProjects(): Promise<Project[]> {
  const config = await loadConfig();
  return config.projects;
}

export async function getProjectById(id: string): Promise<Project | undefined> {
  const projects = await getProjects();
  return projects.find((p) => p.id === id);
}

export async function getSettings(): Promise<Config['settings']> {
  const config = await loadConfig();
  return config.settings;
}
