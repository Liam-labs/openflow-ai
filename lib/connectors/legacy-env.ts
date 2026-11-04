/**
 * One-time move of the keys in `.UserData/connectors.env` (where the Connections page saved keys before the secret store took over)
 * into the secret store.
 *
 * Order, so a key is never lost: copy the old file to a private backup first, write each key into the store, read each one back,
 * and only then delete the old file. If any key does not read back, the old file stays and nothing is deleted. A name that is already in
 * the store with a different value keeps the old file's value (the Connections page was the last place the owner typed it), and only
 * the name is logged. Values are never logged. The backup stays until the next release.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { resolveSecretStore, type SecretStore } from '@/lib/secret-store';
import { secretNameAllowed, secretValueAllowed } from '@/lib/secrets-file';

const LINE = /^([A-Z][A-Z0-9_]{1,63})='((?:[^']|'\\'')*)'$/;

export function legacyEnvPath(): string {
  return path.join(DataPaths.userData, 'connectors.env');
}

export function parseLegacyEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m) out[m[1]] = m[2].replace(/'\\''/g, "'");
  }
  return out;
}

export interface LegacyMoveResult {
  status: 'none' | 'moved' | 'kept';
  moved: string[];
  replaced: string[];
  refused: string[];
  backup?: string;
}

export async function moveLegacyConnectorEnv(opts: { file?: string; store?: SecretStore; env?: Record<string, string | undefined> } = {}): Promise<LegacyMoveResult> {
  const file = opts.file ?? legacyEnvPath();
  const store = opts.store ?? resolveSecretStore();
  const env = opts.env ?? process.env;
  const none: LegacyMoveResult = { status: 'none', moved: [], replaced: [], refused: [] };

  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return none;
    throw e;
  }

  // Backup first, owner-only from the first byte.
  const backup = path.join(path.dirname(file), 'backups', `connectors.env.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await fs.writeFile(backup, text, { mode: 0o600, flag: 'wx' });

  const keys = parseLegacyEnv(text);
  const result: LegacyMoveResult = { status: 'moved', moved: [], replaced: [], refused: [], backup };
  for (const [name, value] of Object.entries(keys)) {
    if (!secretNameAllowed(name) || !secretValueAllowed(value)) { result.refused.push(name); continue; }
    const existing = store.get(name);
    if (existing !== undefined && existing !== value) result.replaced.push(name);
    store.set(name, value);
    result.moved.push(name);
  }

  // Check every key reads back before the old file goes.
  for (const name of result.moved) {
    if (store.get(name) !== keys[name]) { result.status = 'kept'; return result; }
  }
  if (result.refused.length) { result.status = 'kept'; return result; }
  for (const name of result.moved) if (env[name] === undefined || env[name] === '') env[name] = keys[name];
  await fs.unlink(file);
  return result;
}
