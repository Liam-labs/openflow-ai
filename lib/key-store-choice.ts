/**
 * Where the person chose to keep their keys, and the options the wizard shows for it.
 *
 * Today one place really works: the server's own store, encrypted on disk (lib/secret-store.ts). A launcher can switch the app to read keys
 * from the environment instead (DEVFLOW_SECRET_STORE=env), and the screen reports that when it is the case. A password manager such as
 * 1Password is shown as an optional later choice and cannot be picked yet, so the screen never offers something that does nothing.
 * The choice is saved in a small file so later screens and the setup assistant can say where keys live.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { DataPaths } from '@/lib/data-paths';
import { writeJsonFile } from '@/lib/data-io';

export type KeyStoreId = 'server' | 'password-manager';

export interface KeyStoreOption {
  id: KeyStoreId;
  label: string;
  description: string;
  /** False for a choice that is shown but cannot be picked yet. */
  available: boolean;
  /** Plain note for an option that is not available. */
  note?: string;
}

export const KEY_STORE_OPTIONS: KeyStoreOption[] = [
  {
    id: 'server',
    label: 'On this computer, encrypted',
    description: 'OpenFlow keeps your keys in a private file that only OpenFlow can read, encrypted with a key held in a separate file. Your agents keep working after a restart and nobody types a password.',
    available: true,
  },
  {
    id: 'password-manager',
    label: 'In my password manager (1Password)',
    description: 'Optional. Keys would stay in your own vault and OpenFlow would ask for them when it needs one.',
    available: false,
    note: 'Not available yet. Until then your keys stay on this computer.',
  },
];

export const DEFAULT_KEY_STORE: KeyStoreId = 'server';

function choiceFile(): string {
  return path.join(path.dirname(DataPaths.user.profile), 'key-store.json');
}

export function isAvailableChoice(id: unknown): id is KeyStoreId {
  return typeof id === 'string' && KEY_STORE_OPTIONS.some((o) => o.id === id && o.available);
}

export async function readKeyStoreChoice(file = choiceFile()): Promise<KeyStoreId> {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf-8')) as { store?: unknown };
    return isAvailableChoice(data.store) ? data.store : DEFAULT_KEY_STORE;
  } catch {
    return DEFAULT_KEY_STORE;
  }
}

export async function saveKeyStoreChoice(id: KeyStoreId, file = choiceFile()): Promise<void> {
  await writeJsonFile(file, { store: id, savedAt: new Date().toISOString() });
}
