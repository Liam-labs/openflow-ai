import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore, loadSecretsIntoEnv } from '@/lib/secret-store';
import { isEncryptedValue } from '@/lib/secret-vault';

// OpenFlow encrypts every value in the secret store at rest (key: lib/secret-vault.ts, held outside the data folder).
let dir: string;
let file: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'every-'));
  mkdirSync(join(dir, 'data'));
  file = join(dir, 'data', 'secrets.json');
  env = { DEVFLOW_SECRETS_KEY_FILE: join(dir, 'keys', 'secrets.key') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onDisk = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;

describe('every value is written encrypted', () => {
  it('an ordinary key is encrypted, owner-only, and reads back', () => {
    const store = new FileSecretStore(file, env);
    store.set('DEEPSEEK_API_KEY', 'sk-VISIBLE-IF-PLAIN');
    expect(readFileSync(file, 'utf8')).not.toContain('sk-VISIBLE-IF-PLAIN');
    expect(isEncryptedValue(onDisk().DEEPSEEK_API_KEY)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.get('DEEPSEEK_API_KEY')).toBe('sk-VISIBLE-IF-PLAIN');
    expect(store.isEncrypted('DEEPSEEK_API_KEY')).toBe(true);
  });
  it('a copy of the file without the key cannot be read, and the file is left alone', () => {
    new FileSecretStore(file, env).set('DEEPSEEK_API_KEY', 'sk-x');
    const before = readFileSync(file, 'utf8');
    const lost = new FileSecretStore(file, { DEVFLOW_SECRETS_KEY_FILE: join(dir, 'elsewhere', 'none.key') });
    expect(() => lost.get('DEEPSEEK_API_KEY')).toThrow(/no encryption key|cannot be decrypted/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('a value cannot be copied under another name', () => {
    const store = new FileSecretStore(file, env);
    store.set('A_KEY', 'secret-a');
    const copy = onDisk();
    writeFileSync(file, JSON.stringify({ B_KEY: copy.A_KEY }));
    expect(() => store.get('B_KEY')).toThrow();
  });
});

describe('loading the store into the environment', () => {
  it('puts ordinary keys in, and keeps a protected one out, without overwriting a value the launcher set', () => {
    const store = new FileSecretStore(file, env);
    store.set('DEEPSEEK_API_KEY', 'sk-ds');
    store.set('OPENROUTER_API_KEY', 'sk-or');
    store.set('ANTHROPIC_API_KEY', 'sk-ant');
    const target: Record<string, string | undefined> = { OPENROUTER_API_KEY: 'from-launcher' };
    expect(loadSecretsIntoEnv(store, target)).toEqual(['DEEPSEEK_API_KEY']);
    expect(target).toEqual({ OPENROUTER_API_KEY: 'from-launcher', DEEPSEEK_API_KEY: 'sk-ds' });
  });
});

describe('upgrading an older plain file', () => {
  it('encrypts every plain value once, keeps them all, and leaves no plaintext on disk', () => {
    writeFileSync(file, JSON.stringify({ DEEPSEEK_API_KEY: 'sk-plain-1', DEVFLOW_API_TOKEN: 'tok-plain-2' }), { mode: 0o600 });
    const store = new FileSecretStore(file, env);
    expect(store.upgradeToEncrypted().sort()).toEqual(['DEEPSEEK_API_KEY', 'DEVFLOW_API_TOKEN']);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('sk-plain-1');
    expect(text).not.toContain('tok-plain-2');
    expect(store.get('DEEPSEEK_API_KEY')).toBe('sk-plain-1');
    expect(store.get('DEVFLOW_API_TOKEN')).toBe('tok-plain-2');
    expect(store.upgradeToEncrypted()).toEqual([]);          // second time: nothing to do
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it('upgrades only the plain values of a mixed file', () => {
    const store = new FileSecretStore(file, env);
    store.set('ANTHROPIC_API_KEY', 'sk-ant-already');
    const mixed = { ...onDisk(), DEEPSEEK_API_KEY: 'sk-plain' };
    writeFileSync(file, JSON.stringify(mixed));
    expect(store.upgradeToEncrypted()).toEqual(['DEEPSEEK_API_KEY']);
    expect(store.get('ANTHROPIC_API_KEY')).toBe('sk-ant-already');
  });
  it('puts the old file back untouched when a value does not read back, and leaves a plain file when no key can be made', () => {
    const plain = JSON.stringify({ DEEPSEEK_API_KEY: 'sk-plain-1' });
    writeFileSync(file, plain, { mode: 0o600 });
    // A key file that cannot be created: its folder is read-only.
    const ro = join(dir, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    const store = new FileSecretStore(file, { DEVFLOW_SECRETS_KEY_FILE: join(ro, 'sub', 'secrets.key') });
    try {
      if (process.getuid?.() !== 0) expect(() => store.upgradeToEncrypted()).toThrow(/not encrypted/);
      expect(readFileSync(file, 'utf8')).toBe(plain);
    } finally {
      chmodSync(ro, 0o700);
    }
  });
  it('does nothing for a missing or empty file', () => {
    expect(new FileSecretStore(file, env).upgradeToEncrypted()).toEqual([]);
    writeFileSync(file, '{}');
    expect(new FileSecretStore(file, env).upgradeToEncrypted()).toEqual([]);
  });
});

describe('the Python agent wrapper reads an encrypted store', () => {
  it('opens an ordinary key and a protected key through scripts/read-secret.mjs, and returns nothing for a missing name or the wrong key', async () => {
    const { spawnSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const store = new FileSecretStore(file, env);
    store.set('DEEPSEEK_API_KEY', 'sk-for-python');
    store.set('ANTHROPIC_API_KEY', 'sk-ant-for-python');
    const wrapper = resolve(__dirname, '../../scripts/collab-claude.py');
    const src = readFileSync(wrapper, 'utf8');
    const code = src.slice(src.indexOf('def _stored_secret(name):'), src.indexOf('def _use_stored_api_key():'));
    const py = `import os, json\n__file__ = ${JSON.stringify(wrapper)}\n${code}\nprint(repr(_stored_secret('DEEPSEEK_API_KEY')), repr(_stored_secret('ANTHROPIC_API_KEY')), repr(_stored_secret('NOPE_KEY')))`;
    const run = (keyFile: string) => spawnSync('python3', ['-I', '-c', py], { encoding: 'utf8', env: { PATH: process.env.PATH, DEVFLOW_SECRETS_FILE: file, DEVFLOW_SECRETS_KEY_FILE: keyFile } });
    expect(run(env.DEVFLOW_SECRETS_KEY_FILE as string).stdout.trim()).toBe("'sk-for-python' 'sk-ant-for-python' ''");
    writeFileSync(join(dir, 'other.key'), Buffer.alloc(32, 4).toString('base64'));
    expect(run(join(dir, 'other.key')).stdout.trim()).toBe("'' '' ''");
  });
});
