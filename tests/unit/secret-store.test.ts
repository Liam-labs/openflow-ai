import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EnvSecretStore, FileSecretStore, SecretStoreError, defaultSecretsFile, loadSecretsIntoEnv, resolveSecretStore } from '@/lib/secret-store';

let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretstore-')); file = path.join(dir, 'data', 'secrets.json'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('FileSecretStore', () => {
  it('keeps secrets in a private file in a private folder, and round-trips any value literally', () => {
    const s = new FileSecretStore(file);
    const odd = ['$(touch x)', "it's", '"q"', '\\', ' pad ', 'ünï©ode', '${HOME}'];
    odd.forEach((v, i) => s.set(`KEY_${i}`, v));
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
    odd.forEach((v, i) => expect(s.get(`KEY_${i}`)).toBe(v));
    expect(s.names()).toEqual(odd.map((_, i) => `KEY_${i}`).sort());
    expect(fs.readdirSync(path.dirname(file))).toEqual(['secrets.json']);              // no temp file left
  });
  it('is not a shell script: nothing in it is executable by sourcing', () => {
    new FileSecretStore(file).set('A_KEY', '$(touch should-not-run)');
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
    expect(fs.readFileSync(file, 'utf8').trimStart().startsWith('{')).toBe(true);
  });
  it('updates, deletes, and a missing file is simply empty', () => {
    const s = new FileSecretStore(file);
    expect(s.names()).toEqual([]);
    s.set('A_KEY', 'one'); s.set('A_KEY', 'two'); s.set('B_KEY', 'b');
    expect(s.get('A_KEY')).toBe('two');
    s.delete('A_KEY'); s.delete('NOT_THERE');
    expect(s.names()).toEqual(['B_KEY']);
  });
  it('refuses unsafe names and values', () => {
    const s = new FileSecretStore(file);
    for (const name of ['PATH', 'LD_PRELOAD', 'lower', 'A-B', '']) expect(() => s.set(name, 'v')).toThrow(SecretStoreError);
    for (const value of ['', 'a\nb', 'x'.repeat(9000)]) expect(() => s.set('OK_KEY', value)).toThrow(SecretStoreError);
    expect(fs.existsSync(file)).toBe(false);
  });
  it('a damaged file is an error with a kept copy, never read as empty and never overwritten', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"A_KEY": "kept-value"');
    const s = new FileSecretStore(file);
    expect(() => s.get('A_KEY')).toThrow(/not valid JSON/);
    expect(() => s.set('B_KEY', 'x')).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"A_KEY": "kept-value"');
    const copies = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-'));
    expect(copies.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(path.dirname(file), copies[0]), 'utf8')).toContain('kept-value');
  });
  it('a JSON value that is not an object counts as damaged; non-string entries are ignored', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[1,2]');
    expect(() => new FileSecretStore(file).names()).toThrow(/not valid JSON/);
    fs.writeFileSync(file, '{"A_KEY":"a","B_KEY":5,"C_KEY":null}');
    expect(new FileSecretStore(file).names()).toEqual(['A_KEY']);
  });
});

describe('stores and settings', () => {
  it('the environment store is read-only', () => {
    const s = new EnvSecretStore({ MY_API_KEY: 'v', PLAIN: 'x', EMPTY_TOKEN: '' });
    expect(s.get('MY_API_KEY')).toBe('v');
    expect(s.names()).toEqual(['MY_API_KEY']);
    expect(() => s.set()).toThrow(SecretStoreError);
    expect(() => s.delete()).toThrow(SecretStoreError);
  });
  it('the default is the file store in the app data folder, overridable, and an unknown store is refused', () => {
    expect(defaultSecretsFile({ DEVFLOW_HOME: '/h' })).toBe('/h/.AppData/secrets.json');
    expect(defaultSecretsFile({ DEVFLOW_HOME: '/h', DEVFLOW_APP_DATA_DIR: 'data' })).toBe('/h/data/secrets.json');
    expect(defaultSecretsFile({ DEVFLOW_HOME: '/h', DEVFLOW_APP_DATA_DIR: '/abs' })).toBe('/abs/secrets.json');
    expect(defaultSecretsFile({ DEVFLOW_SECRETS_FILE: '/x/s.json' })).toBe('/x/s.json');
    expect(resolveSecretStore({ DEVFLOW_HOME: '/h' }).kind).toBe('file');
    expect(resolveSecretStore({ DEVFLOW_SECRET_STORE: 'ENV' }).kind).toBe('env');
    expect(() => resolveSecretStore({ DEVFLOW_SECRET_STORE: 'vault' })).toThrow(/not a known store/);
  });
});

describe('loadSecretsIntoEnv', () => {
  it('fills only names that are not already set, so a launcher or shell value always wins', () => {
    const s = new FileSecretStore(file);
    s.set('FROM_FILE_KEY', 'file'); s.set('ALREADY_KEY', 'file'); s.set('EMPTY_KEY', 'file');
    const env: Record<string, string | undefined> = { ALREADY_KEY: 'launcher', EMPTY_KEY: '' };
    expect(loadSecretsIntoEnv(s, env).sort()).toEqual(['EMPTY_KEY', 'FROM_FILE_KEY']);
    expect(env).toEqual({ FROM_FILE_KEY: 'file', ALREADY_KEY: 'launcher', EMPTY_KEY: 'file' });
  });
  it('does nothing for the environment store, and a damaged file is logged and skipped, not thrown', () => {
    const env: Record<string, string | undefined> = {};
    expect(loadSecretsIntoEnv(new EnvSecretStore({ A_KEY: 'x' }), env)).toEqual([]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(loadSecretsIntoEnv(new FileSecretStore(file), env)).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
