/**
 * Computer Use Settings Utilities
 *
 * Provides the safety gate for all computer-use API actions.
 * Fail-closed: if settings cannot be read, computer use is treated as disabled.
 */

import { DataPaths } from './data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import type { DevFlowSettings } from './types';

const DEFAULT_SETTINGS: DevFlowSettings = {
  computerUse: {
    enabled: false,
    enabledAt: null,
    enabledBy: null,
  },
};

export async function readSettings(): Promise<DevFlowSettings> {
  return readJsonFile<DevFlowSettings>(DataPaths.settings, DEFAULT_SETTINGS);
}

/**
 * Safety gate: returns true only if computerUse.enabled === true in settings.json.
 * Fails closed on any read error.
 */
export async function isComputerUseEnabled(): Promise<boolean> {
  try {
    const settings = await readSettings();
    return settings?.computerUse?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Enable or disable computer use. Records who enabled it and when.
 */
export async function setComputerUseEnabled(
  enabled: boolean,
  enabledBy: string = 'user'
): Promise<void> {
  await withFileLock(DataPaths.settings, async () => {
    const settings = await readSettings();
    settings.computerUse = {
      ...settings.computerUse,
      enabled,
      enabledAt: enabled ? new Date().toISOString() : null,
      enabledBy: enabled ? enabledBy : null,
    };
    await writeJsonFile(DataPaths.settings, settings);
  });
}

/**
 * Set the execution backend for Computer Use ('api' or 'max').
 */
export async function setComputerUseBackend(backend: 'api' | 'max'): Promise<void> {
  await withFileLock(DataPaths.settings, async () => {
    const settings = await readSettings();
    settings.computerUse = {
      ...settings.computerUse,
      backend,
    };
    await writeJsonFile(DataPaths.settings, settings);
  });
}
