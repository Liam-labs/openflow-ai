/**
 * Encrypts the secret store file at rest, with a key this server holds ("auto-unlock": agents keep working after a restart, nobody has to
 * type anything).
 *
 * What it protects: a copy of the file on its own. That is the usual leak: a backup of the app data folder, a support bundle, a synced
 * or committed folder, a stolen file. What it does not protect: someone who has the whole machine or disk, or a program running as the
 * same user, because the key has to be readable by the app. It is not a defence against a compromised server.
 *
 * Where the key comes from, first match:
 *   1. OPENFLOW_SECRETS_KEY: 32 bytes, base64, set by whatever starts the app (systemd, Docker secret, a launcher). Nothing on disk.
 *   2. A key file, default `<home>/.openflow/secrets.key` (override DEVFLOW_SECRETS_KEY_FILE), created owner-only the first time a value
 *      is saved. It sits outside the app data folder on purpose, so a backup of that folder does not carry the key with it.
 *
 * File format: JSON `{ "v": 1, "alg": "aes-256-gcm", "iv": base64, "tag": base64, "data": base64 }`. The old plain JSON object is still
 * read, and scripts/read-secret.mjs reads this format for the Python agent wrapper (a test keeps the two in step).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export const AAD = Buffer.from('openflow-secrets:v1');
const KEY_BYTES = 32;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export interface Envelope { v: 1; alg: 'aes-256-gcm'; iv: string; tag: string; data: string }

export function isEnvelope(x: unknown): x is Envelope {
  return !!x && typeof x === 'object' && (x as Envelope).v === 1 && (x as Envelope).alg === 'aes-256-gcm'
    && typeof (x as Envelope).iv === 'string' && typeof (x as Envelope).tag === 'string' && typeof (x as Envelope).data === 'string';
}

export function defaultKeyFile(env: Record<string, string | undefined> = process.env): string {
  if (env.DEVFLOW_SECRETS_KEY_FILE) return path.resolve(env.DEVFLOW_SECRETS_KEY_FILE);
  return path.join(env.HOME || env.DEVFLOW_HOME || os.homedir(), '.openflow', 'secrets.key');
}

function parseKey(text: string, where: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== KEY_BYTES) throw new SecretBoxError(`${where} must hold ${KEY_BYTES} bytes as base64`);
  return key;
}

/** The key, or null when there is none yet. `create` makes the key file (owner-only, never overwriting) when neither source exists. */
export function loadKey(opts: { create: boolean; env?: Record<string, string | undefined>; keyFile?: string }): Buffer | null {
  const env = opts.env ?? process.env;
  if (env.OPENFLOW_SECRETS_KEY?.trim()) return parseKey(env.OPENFLOW_SECRETS_KEY, 'OPENFLOW_SECRETS_KEY');
  const file = opts.keyFile ?? defaultKeyFile(env);
  try {
    return parseKey(fs.readFileSync(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!opts.create) return null;
  const key = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return parseKey(fs.readFileSync(file, 'utf8'), file); // another writer got there first
    throw error;
  }
}

export function encrypt(plain: string, key: Buffer): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Throws SecretBoxError when the key is wrong or the file was changed; the message never contains a value. */
export function decrypt(envelope: Envelope, key: Buffer): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError('the secret store could not be decrypted: the key does not match this file, or the file was changed');
  }
}
