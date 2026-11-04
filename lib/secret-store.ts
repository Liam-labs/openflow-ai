/**
 * Where DevFlow keeps the keys and tokens you give it (provider API keys, bridge tokens ...).
 *
 * Default: one JSON file, mode 0600, in the app's data folder (.AppData/secrets.json). Nothing sources it: the app reads it
 * itself at start (loadSecretsIntoEnv) and its child processes inherit the values. A shell never executes it, so a stranger's
 * first run does not create a file that every new terminal runs. Writing a shell-sourceable ~/.secrets as well is opt-in
 * (DEVFLOW_WRITE_SHELL_SECRETS=1, see app/api/setup/complete).
 *
 * Every value is written encrypted (AES-256-GCM, key held outside this folder, see lib/secret-vault.ts). set() encrypts, get() decrypts, and the
 * file can never receive a new plaintext value. An older file with plain values is upgraded once at start (upgradeToEncrypted).
 * A few names (PROTECTED_SECRET_NAMES, today ANTHROPIC_API_KEY) are also kept out of the app's own environment: agents get them only through
 * the spawn code. Every other value is decrypted into the environment at start (loadSecretsIntoEnv).
 *
 * Other stores plug in behind the same interface: "env" (read-only, whatever is in the environment) is built in, and a vault
 * can be added by implementing SecretStore. A launcher that sets the environment before the app starts needs nothing here.
 *
 *   DEVFLOW_SECRET_STORE  file (default) | env
 *   DEVFLOW_SECRETS_FILE  path of the file store (default <app data>/secrets.json)
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { secretNameAllowed, secretValueAllowed } from './secrets-file';
import { SecretVaultError, decryptSecret, encryptSecret, isEncryptedValue, isProtectedName, resolveVaultKey } from './secret-vault';
import { claudeUsesApiKey } from './claude-spawn-env';

export interface SecretStore {
  readonly kind: string;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  names(): string[];
  /** True when the stored value is encrypted at rest (lib/secret-vault.ts). Stores without encryption omit this. */
  isEncrypted?(name: string): boolean;
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
  constructor(readonly filePath: string, private readonly env: Record<string, string | undefined> = process.env) {}

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

  private write(data: Record<string, string>, before: Record<string, string> = {}): void {
    // Last line of defence: no name may gain or change a plaintext value, whatever the caller did.
    for (const [name, value] of Object.entries(data)) {
      if (!isEncryptedValue(value) && before[name] !== value) throw new SecretStoreError(`${name} may only be stored encrypted`);
    }
    this.writeRaw(data);
  }

  private writeRaw(data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.filePath);
  }

  get(name: string): string | undefined {
    const raw = this.read()[name];
    if (raw === undefined || !isEncryptedValue(raw)) return raw;
    try {
      const vault = resolveVaultKey(this.env, { dataDir: path.dirname(this.filePath) });
      if (!vault) throw new SecretStoreError(`${name} is stored encrypted but no encryption key is available (set DEVFLOW_SECRETS_KEY)`);
      return decryptSecret(raw, vault.key, name);
    } catch (error) {
      if (error instanceof SecretVaultError) throw new SecretStoreError(`${name}: ${error.message}`);
      throw error;
    }
  }

  isEncrypted(name: string): boolean {
    const raw = this.read()[name];
    return raw !== undefined && isEncryptedValue(raw);
  }

  set(name: string, value: string): void {
    checkName(name);
    if (!secretValueAllowed(value)) throw new SecretStoreError(`the value for ${name} is empty, too long or has a line break`);
    if (isEncryptedValue(value)) throw new SecretStoreError(`the value for ${name} looks like an already-encrypted blob; give the real value`);
    const data = this.read();
    const before = { ...data };
    try {
      const vault = resolveVaultKey(this.env, { create: true, dataDir: path.dirname(this.filePath) });
      if (!vault) throw new SecretStoreError('no encryption key is available');
      data[name] = encryptSecret(value, vault.key, name);   // a new random nonce each time: saving the same key twice gives different bytes
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError(`${name} was not saved: ${error instanceof SecretVaultError ? error.message : `cannot make the encryption key (${(error as NodeJS.ErrnoException).code || 'error'})`}`);
    }
    this.write(data, before);
  }

  delete(name: string): void {
    const data = this.read();
    if (name in data) {
      const before = { ...data };
      delete data[name];
      this.write(data, before);
    }
  }

  names(): string[] {
    return Object.keys(this.read()).sort();
  }

  /**
   * Encrypts every plain value in an older file, once. The old contents stay in memory until the encrypted file has been read back and
   * every value matches; if anything does not, the old file is put back and nothing is lost. No plaintext copy is left on disk.
   * Returns the names it upgraded (none for a file that is already encrypted or empty).
   */
  upgradeToEncrypted(): string[] {
    const original = this.read();
    const plain = Object.keys(original).filter((n) => !isEncryptedValue(original[n]));
    if (plain.length === 0) return [];
    const upgraded = { ...original };
    try {
      const vault = resolveVaultKey(this.env, { create: true, dataDir: path.dirname(this.filePath) });
      if (!vault) throw new SecretStoreError('no encryption key is available');
      for (const name of plain) upgraded[name] = encryptSecret(original[name], vault.key, name);
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError(`the secret store was not encrypted: ${error instanceof SecretVaultError ? error.message : `cannot make the encryption key (${(error as NodeJS.ErrnoException).code || 'error'})`}`);
    }
    this.write(upgraded, original);
    const mismatched = plain.filter((name) => {
      try { return this.get(name) !== original[name]; } catch { return true; }
    });
    if (mismatched.length) {
      this.writeRaw(original);   // put the old file back untouched
      throw new SecretStoreError(`the secret store was not encrypted: ${mismatched.length} value(s) did not read back the same, so the old file was restored`);
    }
    return plain;
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
  // turbopackIgnore: root and base are only known at run time; without it the build traces the whole .AppData tree (7 GB of backups) and runs out of memory.
  return path.join(path.isAbsolute(base) ? base : path.join(/* turbopackIgnore: true */ root, base), 'secrets.json');
}

export function resolveSecretStore(env: Record<string, string | undefined> = process.env, appDataDir?: string): SecretStore {
  const kind = (env.DEVFLOW_SECRET_STORE || 'file').trim().toLowerCase();
  if (kind === 'env') return new EnvSecretStore(env);
  if (kind !== 'file') throw new SecretStoreError(`DEVFLOW_SECRET_STORE=${kind} is not a known store (file or env)`);
  return new FileSecretStore(defaultSecretsFile(env, appDataDir), env);
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
        // A protected value stays in the store: agents get it only through the spawn code, so it is not in the app's own environment.
        // The one exception is the install-wide API-key mode (DEVFLOW_CLAUDE_AUTH=api-key), which expects ANTHROPIC_API_KEY in the environment.
        // Every other value is stored encrypted too, and is decrypted here so the app and the agents it starts can read it.
        if (isProtectedName(name) && store.isEncrypted?.(name) && !(name === 'ANTHROPIC_API_KEY' && claudeUsesApiKey(env))) continue;
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
