import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_p: string, h: unknown) => h }));

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['HOME', 'DEVFLOW_HOME', 'DEVFLOW_APP_DATA_DIR', 'DEVFLOW_SECRETS_FILE', 'DEVFLOW_SECRET_STORE', 'DEVFLOW_WRITE_SHELL_SECRETS'];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsync-'));
  KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.HOME = home;
  process.env.DEVFLOW_HOME = home;
  vi.resetModules();
});
afterEach(() => {
  KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  fs.rmSync(home, { recursive: true, force: true });
});

async function post(body: unknown) {
  const { POST } = await import('@/app/api/vault/sync-secrets/route');
  const res = await (POST as (r: NextRequest) => Promise<Response>)(new NextRequest('http://localhost:3000/api/vault/sync-secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
const store = () => JSON.parse(fs.readFileSync(path.join(home, '.AppData', 'secrets.json'), 'utf8')) as Record<string, string>;
const HOSTILE = { name: 'Evil\ntouch "$HOME/RAN"\n# x', category: 'cat\ntouch "$HOME/RAN2"', payloadUrl: 'http://x\ntouch "$HOME/RAN3"', score: '1\rtouch "$HOME/RAN4"' };

describe('vault sync, default mode (private store)', () => {
  it('writes to the private store, never to ~/.secrets, and the file is mode 0600', async () => {
    const r = await post({ action: 'add', secret: { name: 'My API Key', value: 'it\'s a "$(touch RAN)" value' } });
    expect(r.status).toBe(200);
    expect(store()).toEqual({ MY_API_KEY: 'it\'s a "$(touch RAN)" value' });
    expect(fs.existsSync(path.join(home, '.secrets'))).toBe(false);
    expect(fs.statSync(path.join(home, '.AppData', 'secrets.json')).mode & 0o777).toBe(0o600);
  });
  it('sync merges, update renames and delete removes, in the store', async () => {
    await post({ action: 'sync', secrets: [{ name: 'One', value: '1' }, { name: 'Two', value: '2' }] });
    expect(store()).toEqual({ ONE: '1', TWO: '2' });
    await post({ action: 'update', secret: { name: 'Three', value: '3' }, oldName: 'One' });
    expect(store()).toEqual({ TWO: '2', THREE: '3' });
    await post({ action: 'delete', secret: { name: 'Two' } });
    expect(store()).toEqual({ THREE: '3' });
  });
  it('JSON secrets become private files in the app data folder, with the path as the stored value', async () => {
    await post({ action: 'add', secret: { name: 'GA4 Config', value: '{"a":1}', type: 'json' } });
    const file = store().GA4_CONFIG_JSON;
    expect(file).toBe(path.join(home, '.AppData', 'secrets.d', 'ga4-config.json'));
    expect(fs.readFileSync(file, 'utf8')).toContain('"a": 1');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(home, '.secrets.d'))).toBe(false);
  });
  it('an unsafe value is skipped and the rest is kept', async () => {
    await post({ action: 'sync', secrets: [{ name: 'Good', value: 'ok' }, { name: 'Bad', value: 'a\nb' }, { name: 'Path', value: '/evil' }] });
    expect(store()).toEqual({ GOOD: 'ok' });
  });
});

describe('vault sync, shell mode (opt-in)', () => {
  beforeEach(() => { process.env.DEVFLOW_WRITE_SHELL_SECRETS = '1'; });

  it('writes ~/.secrets so that sourcing it runs nothing, whatever is in names, categories, URLs and values', async () => {
    const r = await post({ action: 'sync', secrets: [{ ...HOSTILE, value: '$(touch "$HOME/RAN5") `touch "$HOME/RAN6"` \'; touch "$HOME/RAN7"; \'' }, { name: 'Plain Key', value: 'plain' }] });
    expect(r.status).toBe(200);
    const text = fs.readFileSync(path.join(home, '.secrets'), 'utf8');
    execFileSync('bash', ['-c', `. "${path.join(home, '.secrets')}"; printf %s "$PLAIN_KEY" > "$HOME/out"`], { env: { PATH: process.env.PATH, HOME: home } });
    expect(fs.readdirSync(home).filter((n) => n.startsWith('RAN'))).toEqual([]);
    expect(fs.readFileSync(path.join(home, 'out'), 'utf8')).toBe('plain');
    expect(text.split('\n').every((l) => l === '' || l.startsWith('#') || /^export [A-Z_][A-Z0-9_]*='/.test(l))).toBe(true);
    expect(fs.statSync(path.join(home, '.secrets')).mode & 0o777).toBe(0o600);
  });
  it('reads back both quote styles, so an existing double-quoted file keeps its values', async () => {
    fs.writeFileSync(path.join(home, '.secrets'), '# old\nexport OLD_KEY="a \\"b\\" \\$c"\nexport NEW_KEY=\'it\'\\\'\'s\'\n');
    await post({ action: 'add', secret: { name: 'Other', value: 'o' } });
    const out = execFileSync('bash', ['-c', `. "${path.join(home, '.secrets')}"; printf '%s|%s|%s' "$OLD_KEY" "$NEW_KEY" "$OTHER"`], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(out).toBe('a "b" $c|it\'s|o');
  });
  it('refuses to write a name that changes how shells behave', async () => {
    await post({ action: 'sync', secrets: [{ name: 'Path', value: '/evil' }, { name: 'LD PRELOAD', value: '/x.so' }, { name: 'Fine', value: 'f' }] });
    const text = fs.readFileSync(path.join(home, '.secrets'), 'utf8');
    expect(text).toMatch(/export FINE=/);
    expect(text).not.toMatch(/export PATH=|LD_PRELOAD=/);
  });
});
