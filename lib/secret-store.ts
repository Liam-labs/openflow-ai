/**
 * Where DevFlow keeps the keys and tokens you give it (provider API keys, bridge tokens ...).
 *
 * Default: one JSON file, mode 0600, in the app's data folder (.AppData/secrets.json). Nothing sources it: the app reads it
 * itself at start (loadSecretsIntoEnv) and its child processes inherit the values. A shell never executes it, so a stranger's
 * first run does not create a file that every new terminal runs. Writing a shell-sourceable ~/.secrets as well is opt-in
 * (DEVFLOW_WRITE_SHELL_SECRETS=1, see app/api/setup/complete).
 *
 * Other stores plug in behind the same interface: "env" (read-only, whatever is in the environment) is built in, and a vault
 * can be added by implementing SecretStore. Our own server uses 1Password through scripts/devflow-secret-exec, which sets the
 * environment before the app starts, so nothing here changes for it.
 *
 *   DEVFLOW_SECRET_STORE  file (default) | env
 *   DEVFLOW_SECRETS_FILE  path of the file store (default <app data>/secrets.json)
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { secretNameAllowed, secretValueAllowed } from './secrets-file';

export interface SecretStore {
  readonly kind: string;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  names(): string[];
}

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

function checkName(name: string): void {
  if (!secretNameAllowed(name)) throw new SecretStoreError(`"${name}" is not an allowed secret name`);
}

/** A JSON object of NAME -> value in a private file. Strict: a damaged file is an error (a copy is kept), never "empty". */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file';
  constructor(readonly filePath: string) {}

  private read(): Record<string, string> {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
      return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch (error) {
      const copy = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        fs.writeFileSync(copy, text, { mode: 0o600, flag: 'wx' });
      } catch {
        // best effort
      }
      throw new SecretStoreError(`${this.filePath} is not valid JSON (${error instanceof Error ? error.message : 'error'}); a copy was kept as ${copy} and the file was not changed`);
    }
  }

  private write(data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.filePath);
  }

  get(name: string): string | undefined {
    return this.read()[name];
  }

  set(name: string, value: string): void {
    checkName(name);
    if (!secretValueAllowed(value)) throw new SecretStoreError(`the value for ${name} is empty, too long or has a line break`);
    const data = this.read();
    data[name] = value;
    this.write(data);
  }

  delete(name: string): void {
    const data = this.read();
    if (name in data) {
      delete data[name];
      this.write(data);
    }
  }

  names(): string[] {
    return Object.keys(this.read()).sort();
  }
}

/** Read-only view of the process environment, for installs that inject keys themselves (a launcher, Docker, systemd). */
export class EnvSecretStore implements SecretStore {
  readonly kind = 'env';
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  get(name: string): string | undefined {
    return this.env[name] || undefined;
  }
  set(): void {
    throw new SecretStoreError('the environment store is read-only: set the variable where the app is started');
  }
  delete(): void {
    throw new SecretStoreError('the environment store is read-only');
  }
  names(): string[] {
    return Object.keys(this.env).filter((n) => secretNameAllowed(n) && /(KEY|TOKEN|SECRET|PASSWORD)/.test(n) && this.env[n]).sort();
  }
}

export function defaultSecretsFile(env: Record<string, string | undefined> = process.env, appDataDir?: string): string {
  if (env.DEVFLOW_SECRETS_FILE) return path.resolve(env.DEVFLOW_SECRETS_FILE);
  const base = appDataDir || env.DEVFLOW_APP_DATA_DIR || '.AppData';
  const root = env.DEVFLOW_HOME || process.cwd();
  return path.join(path.isAbsolute(base) ? base : path.join(root, base), 'secrets.json');
}

export function resolveSecretStore(env: Record<string, string | undefined> = process.env, appDataDir?: string): SecretStore {
  const kind = (env.DEVFLOW_SECRET_STORE || 'file').trim().toLowerCase();
  if (kind === 'env') return new EnvSecretStore(env);
  if (kind !== 'file') throw new SecretStoreError(`DEVFLOW_SECRET_STORE=${kind} is not a known store (file or env)`);
  return new FileSecretStore(defaultSecretsFile(env, appDataDir));
}

/**
 * Put the stored secrets into the environment for names that are not already set (a value given by the launcher, Docker or the shell
 * always wins). Called once when the app starts, so code that reads process.env and the processes the app starts see them.
 * Returns the names it filled; a damaged store is logged and skipped rather than stopping the app.
 */
export function loadSecretsIntoEnv(store: SecretStore = resolveSecretStore(), env: Record<string, string | undefined> = process.env): string[] {
  if (store.kind === 'env') return [];
  const filled: string[] = [];
  try {
    for (const name of store.names()) {
      if (env[name] === undefined || env[name] === '') {
        const value = store.get(name);
        if (value !== undefined) {
          env[name] = value;
          filled.push(name);
        }
      }
    }
  } catch (error) {
    console.error('[secret-store] not loaded:', error instanceof Error ? error.message : error);
  }
  return filled;
}
