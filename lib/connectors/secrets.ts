/**
 * Where connector keys live: one owner-only file, `.UserData/connectors.env`, lines of `NAME='value'`.
 * Agents started by DevFlow source it (see `connectorEnvShellPrefix`), so a saved key is simply `$NAME` to them.
 * Only names the catalog declares may be written, values never reach a log or an API answer, and the
 * file is created 0600 from its first byte.
 */
import { promises as fs, existsSync, readFileSync } from 'fs';
import path from 'path';
import { withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { ConnectorInputError } from '@/lib/connectors/errors';

const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const LINE = /^([A-Z][A-Z0-9_]{1,63})='((?:[^']|'\\'')*)'$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_VALUE_LENGTH = 4096;

export function connectorEnvPath(): string {
  return path.join(DataPaths.userData, 'connectors.env');
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Returns the cleaned value, or throws a message that is safe to show (it never contains the value). */
export function validateKeyValue(value: unknown): string {
  if (typeof value !== 'string') throw new ConnectorInputError('The key must be text.');
  const v = value.trim();
  if (!v) throw new ConnectorInputError('The key is empty.');
  if (v.length > MAX_VALUE_LENGTH) throw new ConnectorInputError('The key is too long.');
  if (CONTROL.test(v)) throw new ConnectorInputError('The key has a line break or hidden character in it. Copy it again.');
  return v;
}

export function parseConnectorEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m) out[m[1]] = m[2].replace(/'\\''/g, "'");
  }
  return out;
}

export function serializeConnectorEnv(values: Record<string, string>): string {
  return Object.keys(values).sort().map((k) => `${k}=${shellQuote(values[k])}\n`).join('');
}

/** One saved key, read without waiting: for code that builds an agent's start-up environment and cannot be async. */
export function readConnectorKeySync(name: string, file: string = connectorEnvPath()): string | undefined {
  try {
    return parseConnectorEnv(readFileSync(file, 'utf8'))[name]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function readConnectorEnv(file: string = connectorEnvPath()): Promise<Record<string, string>> {
  try {
    return parseConnectorEnv(await fs.readFile(file, 'utf-8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

async function writeOwnerOnly(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // mode on open: the secret is never readable by anyone else, not even for a moment.
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf-8');
  } finally {
    await handle.close();
  }
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/** Saves one key. `allowed` is the set of names the catalog declares; anything else is refused. */
export async function saveConnectorKey(name: string, value: unknown, allowed: ReadonlySet<string>, file: string = connectorEnvPath()): Promise<void> {
  if (!NAME.test(name) || !allowed.has(name)) throw new ConnectorInputError('That key name is not in the connectors list.');
  const clean = validateKeyValue(value);
  await withFileLock(file, async () => {
    const all = await readConnectorEnv(file);
    all[name] = clean;
    await writeOwnerOnly(file, serializeConnectorEnv(all));
  });
}

export async function removeConnectorKey(name: string, file: string = connectorEnvPath()): Promise<boolean> {
  if (!NAME.test(name)) throw new ConnectorInputError('Bad key name.');
  return withFileLock(file, async () => {
    const all = await readConnectorEnv(file);
    if (!(name in all)) return false;
    delete all[name];
    await writeOwnerOnly(file, serializeConnectorEnv(all));
    return true;
  });
}

export async function savedConnectorKeyNames(file: string = connectorEnvPath()): Promise<string[]> {
  return Object.keys(await readConnectorEnv(file)).sort();
}

/**
 * Shell text for the start of an agent's launch command: loads the saved keys into that agent's environment.
 * Empty when no key has been saved, so an install that never used connectors launches exactly as before.
 */
export function connectorEnvShellPrefix(file: string = connectorEnvPath()): string {
  if (!existsSync(file)) return '';
  return `set -a; . ${shellQuote(file)} 2>/dev/null; set +a;`;
}
