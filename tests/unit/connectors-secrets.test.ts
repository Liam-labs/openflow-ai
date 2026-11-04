import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Connector keys live in the app's secret store. These tests use a real file store in a temp folder, and a fake `tmux` so the
// real tmux server on a developer machine is never touched.
const tmuxCalls: string[][] = [];
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return { ...real, execFile: (cmd: string, args: string[], _o: unknown, cb?: () => void) => { if (cmd === 'tmux') tmuxCalls.push(args); cb?.(); return {} as never; } };
});

let dir: string;
let store: import('@/lib/secret-store').FileSecretStore;
let api: typeof import('@/lib/connectors/secrets');
const ALLOWED = new Set(['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY']);
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conn-store-'));
  for (const k of ['DEVFLOW_AGENT_HOST', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  tmuxCalls.length = 0;
  const { FileSecretStore } = await import('@/lib/secret-store');
  store = new FileSecretStore(join(dir, 'secrets.json'));
  api = await import('@/lib/connectors/secrets');
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

describe('connector keys in the secret store', () => {
  it('saves into an owner-only store file, sets the running app\'s environment, and tells tmux', async () => {
    await api.saveConnectorKey('OPENROUTER_API_KEY', '  sk-or-1  ', ALLOWED, store);
    expect(store.get('OPENROUTER_API_KEY')).toBe('sk-or-1');
    expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(process.env.OPENROUTER_API_KEY).toBe('sk-or-1');
    expect(tmuxCalls).toEqual([['set-environment', '-g', '--', 'OPENROUTER_API_KEY', 'sk-or-1']]);
  });
  it('does not touch tmux when agents run on another machine', async () => {
    process.env.DEVFLOW_AGENT_HOST = 'pc';
    await api.saveConnectorKey('OPENROUTER_API_KEY', 'sk-or-1', ALLOWED, store);
    expect(tmuxCalls).toEqual([]);
    expect(process.env.OPENROUTER_API_KEY).toBe('sk-or-1');
  });
  it('keeps several keys, replaces one, removes one, and lists names only', async () => {
    await api.saveConnectorKey('OPENROUTER_API_KEY', 'a', ALLOWED, store);
    await api.saveConnectorKey('DEEPSEEK_API_KEY', 'b', ALLOWED, store);
    await api.saveConnectorKey('OPENROUTER_API_KEY', 'c', ALLOWED, store);
    expect(api.savedConnectorKeyNames(store)).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']);
    expect(api.getConnectorKey('OPENROUTER_API_KEY', store)).toBe('c');
    expect(await api.removeConnectorKey('DEEPSEEK_API_KEY', ALLOWED, store)).toBe(true);
    expect(await api.removeConnectorKey('DEEPSEEK_API_KEY', ALLOWED, store)).toBe(false);
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(tmuxCalls.at(-1)).toEqual(['set-environment', '-gu', '--', 'DEEPSEEK_API_KEY']);
    expect(api.savedConnectorKeyNames(store)).toEqual(['OPENROUTER_API_KEY']);
  });
  it('never lets a connector save or remove a name that belongs to another feature', async () => {
    store.set('SOMETHING_ELSE_KEY', 'keep-me');
    await expect(api.saveConnectorKey('SOMETHING_ELSE_KEY', 'x', ALLOWED, store)).rejects.toThrow('not in the connectors list');
    await expect(api.removeConnectorKey('SOMETHING_ELSE_KEY', ALLOWED, store)).rejects.toThrow('not in the connectors list');
    expect(store.get('SOMETHING_ELSE_KEY')).toBe('keep-me');
    expect(tmuxCalls).toEqual([]);
  });
  it('refuses empty, over-long and multi-line values without echoing them', async () => {
    for (const v of ['   ', 'x'.repeat(9000), 'a\nb']) {
      const err = await api.saveConnectorKey('OPENROUTER_API_KEY', v, ALLOWED, store).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).not.toContain('xxxx');
    }
    expect(store.names()).toEqual([]);
  });
  it('stores awkward characters exactly', async () => {
    const v = `a'b"c$d\`e\\f g;h|i`;
    await api.saveConnectorKey('OPENROUTER_API_KEY', v, ALLOWED, store);
    expect(api.getConnectorKey('OPENROUTER_API_KEY', store)).toBe(v);
  });
  it('says so plainly when the store is read-only', async () => {
    const { EnvSecretStore } = await import('@/lib/secret-store');
    await expect(api.saveConnectorKey('OPENROUTER_API_KEY', 'x', ALLOWED, new EnvSecretStore({}))).rejects.toThrow('read-only');
  });
  it('treats a damaged store as having no keys instead of throwing', () => {
    writeFileSync(join(dir, 'secrets.json'), '{not json');
    expect(api.savedConnectorKeyNames(store)).toEqual([]);
    expect(api.getConnectorKey('OPENROUTER_API_KEY', store)).toBeUndefined();
  });
});
