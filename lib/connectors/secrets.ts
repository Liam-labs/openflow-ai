/**
 * Where connector keys live: the app's own secret store (lib/secret-store.ts, `.AppData/secrets.json`, mode 0600), the same place
 * the Vault sync and the setup wizard put keys. The app loads it into its environment at start, so what is saved here is what agents
 * and tools the app starts inherit. This module adds the rules for the Connections page: only names the catalog declares, values
 * checked before they are written, and a save that also takes effect now (the running app and the running tmux server).
 * Values never reach a log or an API answer.
 *
 * Until November 2026 keys lived in `.UserData/connectors.env`. lib/connectors/legacy-env.ts moves that file's keys into the store once.
 */
import { execFile } from 'child_process';
import { resolveSecretStore, SecretStoreError, type SecretStore } from '@/lib/secret-store';
import { secretNameAllowed, secretValueAllowed } from '@/lib/secrets-file';
import { defaultHost } from '@/lib/host-executor';
import { ConnectorInputError } from '@/lib/connectors/errors';

/** Returns the cleaned value, or throws a message that is safe to show (it never contains the value). */
export function validateKeyValue(value: unknown): string {
  if (typeof value !== 'string') throw new ConnectorInputError('The key must be text.');
  const v = value.trim();
  if (!v) throw new ConnectorInputError('The key is empty.');
  if (!secretValueAllowed(v)) throw new ConnectorInputError('The key is too long, or has a line break or hidden character in it. Copy it again.');
  return v;
}

function checkName(name: string, allowed: ReadonlySet<string>): void {
  if (!secretNameAllowed(name) || !allowed.has(name)) throw new ConnectorInputError('That key name is not in the connectors list.');
}

function asInputError(e: unknown): never {
  // The store's own messages name the problem without the value ("the environment store is read-only: ...").
  if (e instanceof SecretStoreError) throw new ConnectorInputError(e.message);
  throw e;
}

/** New agents start from the tmux server's environment, which was fixed when it started; keep it in step with the key just saved. */
async function offerToTmux(name: string, value: string | null): Promise<void> {
  if (defaultHost()) return;  // agents live on another machine; this process cannot reach their tmux
  const args = value === null ? ['set-environment', '-gu', '--', name] : ['set-environment', '-g', '--', name, value];
  await new Promise<void>((resolve) => { execFile('tmux', args, { timeout: 3000 }, () => resolve()); });  // no tmux server yet is fine
}

/** Saves one key. `allowed` is the set of names the catalog declares; anything else is refused. */
export async function saveConnectorKey(name: string, value: unknown, allowed: ReadonlySet<string>, store: SecretStore = resolveSecretStore()): Promise<void> {
  checkName(name, allowed);
  const clean = validateKeyValue(value);
  try {
    store.set(name, clean);
  } catch (e) {
    asInputError(e);
  }
  process.env[name] = clean;
  await offerToTmux(name, clean);
}

export async function removeConnectorKey(name: string, allowed: ReadonlySet<string>, store: SecretStore = resolveSecretStore()): Promise<boolean> {
  checkName(name, allowed);
  let had = false;
  try {
    had = store.get(name) !== undefined;
    store.delete(name);
  } catch (e) {
    asInputError(e);
  }
  if (had) {
    delete process.env[name];
    await offerToTmux(name, null);
  }
  return had;
}

export function getConnectorKey(name: string, store: SecretStore = resolveSecretStore()): string | undefined {
  try { return store.get(name); } catch { return undefined; }
}

/** Names saved in the store (an unreadable store counts as none). Never values. */
export function savedConnectorKeyNames(store: SecretStore = resolveSecretStore()): string[] {
  try { return store.names(); } catch { return []; }
}
