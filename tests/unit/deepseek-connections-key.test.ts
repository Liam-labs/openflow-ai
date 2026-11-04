import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// A DeepSeek key saved on the Connections page (.UserData/connectors.env) must reach a DeepSeek agent.
let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dskey-'));
  mkdirSync(path.join(dir, 'home'), { recursive: true });
  process.env.HOME = path.join(dir, 'home');
  // DataPaths joins this onto the app folder, so give it a path relative to there.
  process.env.DEVFLOW_USER_DATA_DIR = path.relative(process.cwd(), path.join(dir, 'userdata'));
  delete process.env.DEEPSEEK_API_KEY;
  vi.resetModules();
});
afterEach(() => { process.env = { ...saved }; rmSync(dir, { recursive: true, force: true }); });

function saveConnectionsKey(value: string) {
  mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  writeFileSync(path.join(dir, 'userdata', 'connectors.env'), `DEEPSEEK_API_KEY='${value}'\n`, { mode: 0o600 });
}

describe('DeepSeek key saved on the Connections page', () => {
  it('reaches a DeepSeek agent started as a process', async () => {
    saveConnectionsKey('sk-from-connections');
    const { buildDeepSeekProcessEnv } = await import('@/lib/deepseek-env');
    expect(buildDeepSeekProcessEnv(['--model', 'deepseek-flash']).ANTHROPIC_AUTH_TOKEN).toBe('sk-from-connections');
  });
  it('wins over a key in ~/.secrets', async () => {
    saveConnectionsKey('sk-from-connections');
    writeFileSync(path.join(dir, 'home', '.secrets'), 'export DEEPSEEK_API_KEY=sk-old-secrets\n');
    const { buildDeepSeekProcessEnv } = await import('@/lib/deepseek-env');
    expect(buildDeepSeekProcessEnv(['--model', 'deepseek-flash']).ANTHROPIC_AUTH_TOKEN).toBe('sk-from-connections');
  });
  it('is still empty for a non-DeepSeek model, and when no key is saved anywhere', async () => {
    saveConnectionsKey('sk-from-connections');
    const { buildDeepSeekProcessEnv } = await import('@/lib/deepseek-env');
    expect(buildDeepSeekProcessEnv(['--model', 'sonnet'])).toEqual({});
    rmSync(path.join(dir, 'userdata'), { recursive: true });
    expect(buildDeepSeekProcessEnv(['--model', 'deepseek-flash'])).toEqual({});
  });
  it('the shell start-up sources the saved file after ~/.secrets, and never contains the key', async () => {
    saveConnectionsKey('sk-from-connections');
    const { buildDeepSeekShellEnv } = await import('@/lib/deepseek-env');
    const sh = buildDeepSeekShellEnv(['--model', 'deepseek-flash'], '/work');
    expect(sh).toContain('connectors.env');
    expect(sh.indexOf('.secrets')).toBeLessThan(sh.indexOf('connectors.env'));
    expect(sh).not.toContain('sk-from-connections');
  });
  it('the shell start-up really exports the saved key to the agent', async () => {
    saveConnectionsKey('sk-from-connections');
    const { buildDeepSeekShellEnv } = await import('@/lib/deepseek-env');
    const { spawnSync } = await import('child_process');
    const sh = buildDeepSeekShellEnv(['--model', 'deepseek-flash'], '/work');
    const r = spawnSync('bash', ['-c', `${sh} printf %s "$ANTHROPIC_AUTH_TOKEN"`], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' });
    expect(r.stdout).toBe('sk-from-connections');
  });
});
