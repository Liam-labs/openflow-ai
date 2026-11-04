import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from '@/lib/secret-store';
import { moveLegacyConnectorEnv, parseLegacyEnv } from '@/lib/connectors/legacy-env';

let dir: string;
let file: string;
let store: FileSecretStore;
let env: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-env-'));
  file = join(dir, 'connectors.env');
  store = new FileSecretStore(join(dir, 'secrets.json'));
  env = {};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const legacy = (pairs: Record<string, string>) => writeFileSync(file, Object.entries(pairs).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'\n`).join(''));

const NASTY = ["a'b", "'", "''", "x'; touch PWNED; echo '", '$(touch PWNED)', '`touch PWNED`', 'a"b', 'back\\slash', 'a b;c|d&e', '${HOME}', 'sk-ordinary-key_123'];

describe('moving connectors.env into the secret store', () => {
  it.each(NASTY)('moves %j exactly', async (value) => {
    legacy({ DEEPSEEK_API_KEY: value });
    const r = await moveLegacyConnectorEnv({ file, store, env });
    expect(r.status).toBe('moved');
    expect(store.get('DEEPSEEK_API_KEY')).toBe(value);
  });
  it('does nothing when there is no old file', async () => {
    expect((await moveLegacyConnectorEnv({ file, store, env })).status).toBe('none');
    expect(store.names()).toEqual([]);
  });
  it('backs up first, moves every key exactly, then deletes the old file', async () => {
    const awkward = `a'b"c$(x)\`y\`\\z`;
    legacy({ DEEPSEEK_API_KEY: 'sk-1', OPENROUTER_API_KEY: awkward });
    const r = await moveLegacyConnectorEnv({ file, store, env });
    expect(r.status).toBe('moved');
    expect(r.moved.sort()).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']);
    expect(store.get('DEEPSEEK_API_KEY')).toBe('sk-1');
    expect(store.get('OPENROUTER_API_KEY')).toBe(awkward);
    expect(existsSync(file)).toBe(false);
    expect(env.DEEPSEEK_API_KEY).toBe('sk-1');
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    const b = join(dir, 'backups', backups[0]);
    expect(statSync(b).mode & 0o777).toBe(0o600);
    expect(parseLegacyEnv(readFileSync(b, 'utf8')).OPENROUTER_API_KEY).toBe(awkward);
  });
  it('keeps the old file value for a name already in the store with a different value, and reports only the name', async () => {
    store.set('DEEPSEEK_API_KEY', 'sk-old-in-store');
    store.set('UNRELATED_TOKEN', 'stay');
    legacy({ DEEPSEEK_API_KEY: 'sk-from-connections' });
    const r = await moveLegacyConnectorEnv({ file, store, env });
    expect(r.replaced).toEqual(['DEEPSEEK_API_KEY']);
    expect(JSON.stringify(r)).not.toContain('sk-from-connections');
    expect(store.get('DEEPSEEK_API_KEY')).toBe('sk-from-connections');
    expect(store.get('UNRELATED_TOKEN')).toBe('stay');
  });
  it('does not overwrite a value the launcher already put in the environment', async () => {
    legacy({ DEEPSEEK_API_KEY: 'sk-1' });
    env.DEEPSEEK_API_KEY = 'from-launcher';
    await moveLegacyConnectorEnv({ file, store, env });
    expect(env.DEEPSEEK_API_KEY).toBe('from-launcher');
  });
  it('keeps the old file and deletes nothing when a key does not read back', async () => {
    legacy({ DEEPSEEK_API_KEY: 'sk-1' });
    const liar = Object.assign(Object.create(store), { get: () => 'something else', set: () => undefined });
    const r = await moveLegacyConnectorEnv({ file, store: liar, env });
    expect(r.status).toBe('kept');
    expect(existsSync(file)).toBe(true);
  });
  it('keeps the old file when a value is refused by the store rules', async () => {
    writeFileSync(file, `DEEPSEEK_API_KEY='${'x'.repeat(9000)}'\n`);
    const r = await moveLegacyConnectorEnv({ file, store, env });
    expect(r.status).toBe('kept');
    expect(r.refused).toEqual(['DEEPSEEK_API_KEY']);
    expect(existsSync(file)).toBe(true);
  });
  it('is harmless to run twice', async () => {
    legacy({ DEEPSEEK_API_KEY: 'sk-1' });
    await moveLegacyConnectorEnv({ file, store, env });
    expect((await moveLegacyConnectorEnv({ file, store, env })).status).toBe('none');
    expect(store.get('DEEPSEEK_API_KEY')).toBe('sk-1');
  });
});
