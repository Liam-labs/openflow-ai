import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { ENC_PREFIX, SecretVaultError, decryptSecret, encryptSecret, isEncryptedValue, parseVaultKey, resolveVaultKey } from '@/lib/secret-vault';

const FAKE = 'sk-ant-FAKE-vault-test-0123456789';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('AES-256-GCM envelope', () => {
  it('round-trips and never contains the plain text', () => {
    const key = randomBytes(32);
    const blob = encryptSecret(FAKE, key, 'ANTHROPIC_API_KEY');
    expect(blob.startsWith(ENC_PREFIX)).toBe(true);
    expect(blob).not.toContain(FAKE);
    expect(Buffer.from(blob.slice(ENC_PREFIX.length), 'base64').toString('latin1')).not.toContain('sk-ant');
    expect(decryptSecret(blob, key, 'ANTHROPIC_API_KEY')).toBe(FAKE);
  });
  it('gives different bytes for the same secret every time (fresh random nonce)', () => {
    const key = randomBytes(32);
    const a = encryptSecret(FAKE, key, 'N');
    const b = encryptSecret(FAKE, key, 'N');
    expect(a).not.toBe(b);
    expect(Buffer.from(a.slice(ENC_PREFIX.length), 'base64').subarray(0, 12)).not.toEqual(Buffer.from(b.slice(ENC_PREFIX.length), 'base64').subarray(0, 12));
  });
  it('fails with the wrong key, a changed byte, or another name', () => {
    const key = randomBytes(32);
    const blob = encryptSecret(FAKE, key, 'ANTHROPIC_API_KEY');
    expect(() => decryptSecret(blob, randomBytes(32), 'ANTHROPIC_API_KEY')).toThrow(SecretVaultError);
    expect(() => decryptSecret(blob, key, 'OTHER_NAME')).toThrow(SecretVaultError);
    const raw = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret(ENC_PREFIX + raw.toString('base64'), key, 'ANTHROPIC_API_KEY')).toThrow(/cannot be decrypted/);
  });
  it('the failure message never holds the secret', () => {
    const key = randomBytes(32);
    try { decryptSecret(encryptSecret(FAKE, key, 'N'), randomBytes(32), 'N'); } catch (e) { expect(String((e as Error).message)).not.toContain(FAKE); }
  });
  it('isEncryptedValue only accepts the prefix', () => {
    expect(isEncryptedValue(ENC_PREFIX + 'abc')).toBe(true);
    expect(isEncryptedValue(FAKE)).toBe(false);
  });
});

describe('where the key lives', () => {
  it('parses 32 bytes as base64 or hex, nothing else', () => {
    const k = randomBytes(32);
    expect(parseVaultKey(k.toString('hex'))).toEqual(k);
    expect(parseVaultKey(k.toString('base64'))).toEqual(k);
    expect(parseVaultKey('short')).toBeNull();
    expect(parseVaultKey(randomBytes(16).toString('hex'))).toBeNull();
  });
  it('uses DEVFLOW_SECRETS_KEY first and rejects a malformed one loudly', () => {
    const k = randomBytes(32);
    expect(resolveVaultKey({ DEVFLOW_SECRETS_KEY: k.toString('base64') })?.source).toBe('env');
    expect(() => resolveVaultKey({ DEVFLOW_SECRETS_KEY: 'not-a-key' })).toThrow(SecretVaultError);
  });
  it('creates the key file 0600 in a 0700 folder only when asked, and reads it back', () => {
    const file = path.join(dir, 'cfg', 'devflow', 'secrets.key');
    const env = { DEVFLOW_SECRETS_KEY_FILE: file };
    expect(resolveVaultKey(env)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    const made = resolveVaultKey(env, { create: true });
    expect(made?.source).toBe('file');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(resolveVaultKey(env)?.key).toEqual(made?.key);
  });
  it('refuses a key file inside the data folder', () => {
    const data = path.join(dir, 'data');
    expect(() => resolveVaultKey({ DEVFLOW_SECRETS_KEY_FILE: path.join(data, 'secrets.key') }, { create: true, dataDir: data })).toThrow(/inside the data folder/);
  });
});
