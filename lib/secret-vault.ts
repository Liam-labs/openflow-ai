/**
 * Encryption at rest for every value in the secret store, so no key sits in a data file as readable text. (It began with the Anthropic API
 * key that agents can be switched to when the Max plan is used up; see lib/anthropic-api-key.ts. OpenFlow encrypts every value.)
 *
 * Format of one protected value:  enc:v1:<base64( nonce(12) | tag(16) | ciphertext )>   AES-256-GCM, a fresh random nonce per save.
 * The secret's own name is bound in as additional authenticated data, so a value cannot be copied under another name.
 *
 * Where the data-encryption key lives (never in the data folder):
 *   1. DEVFLOW_SECRETS_KEY in the environment, 32 random bytes as base64 (44 characters) or hex (64). Preferred: on our own server
 *      scripts/devflow-secret-exec puts it there from 1Password, so the key exists only in the process memory of the app.
 *   2. Fallback for an install without a secret manager: a key file (mode 0600, folder 0700) in a different directory,
 *      DEVFLOW_SECRETS_KEY_FILE or ~/.config/devflow/secrets.key. It is created at the first protected save.
 *      A key file protects a stolen or backed-up data folder. It does not protect against someone who can read the user's home folder.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export const ENC_PREFIX = 'enc:v1:';
/**
 * Secret names agents get only through the spawn code, never in the app's own environment (see loadSecretsIntoEnv).
 * Every value in the store is encrypted at rest, not only these; the difference is only what happens when the store is loaded.
 */
export const PROTECTED_SECRET_NAMES: ReadonlySet<string> = new Set(['ANTHROPIC_API_KEY']);

export class SecretVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretVaultError';
  }
}

export type VaultKeySource = 'env' | 'file';
export interface VaultKey {
  key: Buffer;
  source: VaultKeySource;
}

export const isProtectedName = (name: string): boolean => PROTECTED_SECRET_NAMES.has(name);
export const isEncryptedValue = (value: unknown): value is string => typeof value === 'string' && value.startsWith(ENC_PREFIX);

/** 32 bytes from base64 or hex; null for anything else. */
export function parseVaultKey(text: string): Buffer | null {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) {
    const buf = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.length === 32 ? buf : null;
  }
  return null;
}

export function defaultVaultKeyFile(env: Record<string, string | undefined> = process.env): string {
  if (env.DEVFLOW_SECRETS_KEY_FILE) return path.resolve(env.DEVFLOW_SECRETS_KEY_FILE);
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(config, 'devflow', 'secrets.key');
}

export interface ResolveOptions {
  /** Create the key file when there is neither an env key nor a file. Only a protected SAVE passes true. */
  create?: boolean;
  /** The folder holding the data file: the key file must not be inside it. */
  dataDir?: string;
}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The key in force, or null when none exists (and `create` is not set). A malformed key is an error, never "no key". */
export function resolveVaultKey(env: Record<string, string | undefined> = process.env, opts: ResolveOptions = {}): VaultKey | null {
  const fromEnv = (env.DEVFLOW_SECRETS_KEY || '').trim();
  if (fromEnv) {
    const key = parseVaultKey(fromEnv);
    if (!key) throw new SecretVaultError('DEVFLOW_SECRETS_KEY must be 32 random bytes written as base64 (44 characters) or hex (64 characters)');
    return { key, source: 'env' };
  }
  const file = defaultVaultKeyFile(env);
  if (opts.dataDir && inside(file, opts.dataDir)) {
    throw new SecretVaultError('the encryption key file must not be inside the data folder: set DEVFLOW_SECRETS_KEY_FILE to another place');
  }
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SecretVaultError(`cannot read the encryption key file: ${(error as NodeJS.ErrnoException).code || 'error'}`);
  }
  if (text !== null) {
    const key = parseVaultKey(text);
    if (!key) throw new SecretVaultError('the encryption key file does not hold a 32-byte key');
    return { key, source: 'file' };
  }
  if (!opts.create) return null;
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return resolveVaultKey(env, { ...opts, create: false });   // another process won the race
    throw new SecretVaultError(`cannot create the encryption key file: ${(error as NodeJS.ErrnoException).code || 'error'}`);
  }
  return { key, source: 'file' };
}

export function encryptSecret(plain: string, key: Buffer, name: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}

/** Throws SecretVaultError for a wrong key, a changed value or a value stored under another name. The message never holds the secret. */
export function decryptSecret(blob: string, key: Buffer, name: string): string {
  if (!isEncryptedValue(blob)) throw new SecretVaultError('not an encrypted value');
  const raw = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64');
  if (raw.length < 12 + 16 + 1) throw new SecretVaultError('the encrypted value is damaged');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretVaultError('the stored value cannot be decrypted with the current encryption key (wrong key, or the value was changed)');
  }
}
