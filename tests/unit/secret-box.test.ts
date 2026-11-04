import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileSecretStore } from '@/lib/secret-store';
import { decrypt, encrypt, isEnvelope, loadKey, SecretBoxError } from '@/lib/secret-box';

let dir: string;
let file: string;
let keyFile: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sbox-'));
  file = join(dir, 'secrets.json');
  keyFile = join(dir, 'keys', 'secrets.key');
  for (const k of ['DEVFLOW_SECRETS_KEY_FILE', 'OPENFLOW_SECRETS_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.DEVFLOW_SECRETS_KEY_FILE = keyFile;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

describe('secret box', () => {
  it('round-trips and uses a fresh iv each time', () => {
    const key = Buffer.alloc(32, 7);
    const a = encrypt('{"A":"x"}', key);
    const b = encrypt('{"A":"x"}', key);
    expect(a.iv).not.toBe(b.iv);
    expect(decrypt(a, key)).toBe('{"A":"x"}');
  });
  it('refuses a wrong key and a changed file, without echoing anything', () => {
    const e = encrypt('{"A":"super-secret"}', Buffer.alloc(32, 1));
    expect(() => decrypt(e, Buffer.alloc(32, 2))).toThrow(SecretBoxError);
    expect(() => decrypt({ ...e, data: Buffer.from('tampered').toString('base64') }, Buffer.alloc(32, 1))).toThrow(SecretBoxError);
    try { decrypt(e, Buffer.alloc(32, 2)); } catch (err) { expect(String((err as Error).message)).not.toContain('super-secret'); }
  });
  it('takes the key from OPENFLOW_SECRETS_KEY first, and rejects a key of the wrong size', () => {
    process.env.OPENFLOW_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(loadKey({ create: false })?.equals(Buffer.alloc(32, 9))).toBe(true);
    process.env.OPENFLOW_SECRETS_KEY = 'AAAA';
    expect(() => loadKey({ create: false })).toThrow();
  });
  it('creates the key file owner-only once, and never overwrites it', () => {
    expect(loadKey({ create: false })).toBeNull();
    const first = loadKey({ create: true })!;
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(loadKey({ create: true })!.equals(first)).toBe(true);
  });
});

describe('the file store, encrypted at rest', () => {
  it('writes an encrypted owner-only file that holds no plain value or name', () => {
    const store = new FileSecretStore(file);
    store.set('OPENROUTER_API_KEY', 'sk-or-VISIBLE-IF-PLAIN');
    const text = readFileSync(file, 'utf8');
    expect(isEnvelope(JSON.parse(text))).toBe(true);
    expect(text).not.toContain('sk-or-VISIBLE-IF-PLAIN');
    expect(text).not.toContain('OPENROUTER');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new FileSecretStore(file).get('OPENROUTER_API_KEY')).toBe('sk-or-VISIBLE-IF-PLAIN');
  });
  it('a copy of the file alone, without the key, cannot be read, and the file is left alone', () => {
    new FileSecretStore(file).set('A_KEY', 'v1');
    const before = readFileSync(file, 'utf8');
    rmSync(keyFile);
    delete process.env.OPENFLOW_SECRETS_KEY;
    const store = new FileSecretStore(file);
    expect(() => store.get('A_KEY')).toThrow(/encrypted and its key was not found/);
    expect(() => store.names()).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(keyFile)).toBe(false); // reading never invents a new key
  });
  it('a wrong key is an error that leaves the file alone, and set() does not overwrite it', () => {
    new FileSecretStore(file).set('A_KEY', 'v1');
    const before = readFileSync(file, 'utf8');
    process.env.OPENFLOW_SECRETS_KEY = Buffer.alloc(32, 3).toString('base64');
    const store = new FileSecretStore(file);
    expect(() => store.get('A_KEY')).toThrow(/could not be decrypted/);
    expect(() => store.set('B_KEY', 'v2')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('still reads an old plain file, and upgrades it once, checking it reads back', () => {
    writeFileSync(file, JSON.stringify({ A_KEY: 'plain-1', B_KEY: 'plain-2' }), { mode: 0o600 });
    const store = new FileSecretStore(file);
    expect(store.get('A_KEY')).toBe('plain-1');
    expect(store.isPlain()).toBe(true);
    expect(store.upgradeToEncrypted()).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('plain-1');
    expect(new FileSecretStore(file).names()).toEqual(['A_KEY', 'B_KEY']);
    expect(store.upgradeToEncrypted()).toBe(false);
  });
  it('does nothing to an empty or missing store', () => {
    expect(new FileSecretStore(file).upgradeToEncrypted()).toBe(false);
    writeFileSync(file, '{}');
    expect(new FileSecretStore(file).upgradeToEncrypted()).toBe(false);
  });
});

describe('scripts/read-secret.mjs, used by the Python agent wrapper', () => {
  const script = resolve(__dirname, '../../scripts/read-secret.mjs');
  const run = (name: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [script, name], { encoding: 'utf8', env: { PATH: process.env.PATH, DEVFLOW_SECRETS_FILE: file, ...extra } });
  it('reads a value from the file the app wrote, with the app\'s key file', () => {
    new FileSecretStore(file).set('ANTHROPIC_API_KEY', 'sk-ant-from-app');
    const r = run('ANTHROPIC_API_KEY', { DEVFLOW_SECRETS_KEY_FILE: keyFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('sk-ant-from-app');
  });
  it('reads with OPENFLOW_SECRETS_KEY too, and from an old plain file', () => {
    process.env.OPENFLOW_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');
    new FileSecretStore(file).set('A_KEY', 'v-env');
    expect(run('A_KEY', { OPENFLOW_SECRETS_KEY: process.env.OPENFLOW_SECRETS_KEY }).stdout).toBe('v-env');
    writeFileSync(file, JSON.stringify({ P_KEY: 'plain' }));
    expect(run('P_KEY').stdout).toBe('plain');
  });
  it('prints nothing and exits 1 for a missing name, a missing key or a tampered file', () => {
    new FileSecretStore(file).set('A_KEY', 'v1');
    expect(run('NOPE_KEY', { DEVFLOW_SECRETS_KEY_FILE: keyFile })).toMatchObject({ status: 1, stdout: '' });
    expect(run('A_KEY', { DEVFLOW_SECRETS_KEY_FILE: join(dir, 'missing.key') })).toMatchObject({ status: 1, stdout: '' });
    const e = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...e, data: Buffer.from('x').toString('base64') }));
    expect(run('A_KEY', { DEVFLOW_SECRETS_KEY_FILE: keyFile })).toMatchObject({ status: 1, stdout: '' });
  });
  it('the Python wrapper reads an encrypted store through it', () => {
    new FileSecretStore(file).set('ANTHROPIC_API_KEY', 'sk-ant-for-python');
    const src = readFileSync(resolve(__dirname, '../../scripts/collab-claude.py'), 'utf8');
    const start = src.indexOf('def _stored_secret(name):');
    const end = src.indexOf('def _use_stored_api_key():');
    const py = `import os, json, subprocess\n__file__ = ${JSON.stringify(resolve(__dirname, '../../scripts/collab-claude.py'))}\n${src.slice(start, end)}\nprint(repr(_stored_secret('ANTHROPIC_API_KEY')), repr(_stored_secret('NOPE_KEY')))`;
    const r = spawnSync('python3', ['-I', '-c', py], { encoding: 'utf8', env: { PATH: process.env.PATH, DEVFLOW_SECRETS_FILE: file, DEVFLOW_SECRETS_KEY_FILE: keyFile } });
    expect(r.stdout.trim()).toBe("'sk-ant-for-python' ''");
  });
});
