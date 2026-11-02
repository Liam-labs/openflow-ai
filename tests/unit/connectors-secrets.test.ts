import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectorEnvShellPrefix, parseConnectorEnv, readConnectorEnv, removeConnectorKey, saveConnectorKey,
  savedConnectorKeyNames, serializeConnectorEnv, validateKeyValue,
} from '@/lib/connectors/secrets';
import { ConnectorInputError } from '@/lib/connectors/errors';

const ALLOWED = new Set(['OPENROUTER_API_KEY', 'FAL_KEY']);
let dir: string;
let file: string;

let oldTmuxDir: string | undefined;
let oldTmux: string | undefined;
let oldHost: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conn-sec-'));
  file = join(dir, 'sub', 'connectors.env');
  // A save also writes the key into the tmux server's environment: keep that away from the real server and any agent host.
  oldTmuxDir = process.env.TMUX_TMPDIR; oldTmux = process.env.TMUX; oldHost = process.env.DEVFLOW_AGENT_HOST;
  // TMUX (set inside an agent's terminal) beats TMUX_TMPDIR.
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = dir; delete process.env.DEVFLOW_AGENT_HOST;
});
afterEach(() => {
  spawnSync('tmux', ['kill-server'], { env: { ...process.env, TMUX: undefined, TMUX_TMPDIR: dir } });
  if (oldTmuxDir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = oldTmuxDir;
  if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
  if (oldHost !== undefined) process.env.DEVFLOW_AGENT_HOST = oldHost;
  rmSync(dir, { recursive: true, force: true });
});

// The nastiest value a key box could be given: every shell trick in one string.
const HOSTILE = `a'b"c$(touch ${'${DIR}'}/pwned)\`touch \${DIR}/pwned2\`;\\n$HOME #x`;

describe('connector key file', () => {
  it('is created owner-only and holds the key', async () => {
    await saveConnectorKey('OPENROUTER_API_KEY', '  sk-or-test-1234  ', ALLOWED, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await readConnectorEnv(file)).toEqual({ OPENROUTER_API_KEY: 'sk-or-test-1234' });
  });

  it('keeps several keys, replaces one, removes one, and lists names only', async () => {
    await saveConnectorKey('OPENROUTER_API_KEY', 'one', ALLOWED, file);
    await saveConnectorKey('FAL_KEY', 'two', ALLOWED, file);
    await saveConnectorKey('OPENROUTER_API_KEY', 'three', ALLOWED, file);
    expect(await readConnectorEnv(file)).toEqual({ FAL_KEY: 'two', OPENROUTER_API_KEY: 'three' });
    expect(await savedConnectorKeyNames(file)).toEqual(['FAL_KEY', 'OPENROUTER_API_KEY']);
    expect(await removeConnectorKey('FAL_KEY', file)).toBe(true);
    expect(await removeConnectorKey('FAL_KEY', file)).toBe(false);
    expect(await savedConnectorKeyNames(file)).toEqual(['OPENROUTER_API_KEY']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a name the catalog does not declare, and a badly formed one', async () => {
    await expect(saveConnectorKey('PATH', 'x', ALLOWED, file)).rejects.toBeInstanceOf(ConnectorInputError);
    await expect(saveConnectorKey('LD_PRELOAD', 'x', ALLOWED, file)).rejects.toBeInstanceOf(ConnectorInputError);
    await expect(saveConnectorKey('fal_key', 'x', new Set(['fal_key']), file)).rejects.toBeInstanceOf(ConnectorInputError);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses empty, over-long and multi-line values without echoing them', () => {
    for (const bad of ['', '   ', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(5000), 42 as unknown as string]) {
      expect(() => validateKeyValue(bad)).toThrow(ConnectorInputError);
    }
    try { validateKeyValue('secret-value\nmore'); } catch (e) { expect(String(e)).not.toContain('secret-value'); }
  });

  it('allows a key of exactly the longest size and refuses one a character longer', () => {
    expect(validateKeyValue('k'.repeat(4096))).toHaveLength(4096);
    expect(() => validateKeyValue('k'.repeat(4097))).toThrow(ConnectorInputError);
  });

  it('round-trips awkward characters', () => {
    const values = { FAL_KEY: `it's "quoted" $HOME \`x\` \\ end` };
    expect(parseConnectorEnv(serializeConnectorEnv(values))).toEqual(values);
  });

  it('is safe to source: a hostile value arrives intact and runs nothing', async () => {
    const value = HOSTILE.replace(/\$\{DIR\}/g, dir);
    await saveConnectorKey('FAL_KEY', value, ALLOWED, file);
    const out = execFileSync('bash', ['-c', `. '${file}'; printf %s "$FAL_KEY"`], { encoding: 'utf-8' });
    expect(out).toBe(value);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(existsSync(join(dir, 'pwned2'))).toBe(false);
  });

  it('gives no shell prefix until a key exists, then a prefix that loads the keys', async () => {
    expect(connectorEnvShellPrefix(file)).toBe('');
    await saveConnectorKey('FAL_KEY', 'abc123', ALLOWED, file);
    const prefix = connectorEnvShellPrefix(file);
    expect(prefix).toMatch(/^set -a; \. '.*'/);
    expect(execFileSync('bash', ['-c', `${prefix} printf %s "$FAL_KEY"`], { encoding: 'utf-8', env: { PATH: process.env.PATH } })).toBe('abc123');
  });

  it('loads keys for the launch shell only: variables set after it are not exported', async () => {
    await saveConnectorKey('FAL_KEY', 'abc', ALLOWED, file);
    const out = execFileSync('bash', ['-c', `${connectorEnvShellPrefix(file)} LATER=1; env | grep -c '^LATER=' || true`], { encoding: 'utf-8', env: { PATH: process.env.PATH } }).trim();
    expect(out).toBe('0');
  });

  it('quotes a file path that has a quote in it', async () => {
    const odd = join(dir, "it's", 'connectors.env');
    await saveConnectorKey('FAL_KEY', 'v', ALLOWED, odd);
    expect(execFileSync('bash', ['-c', `${connectorEnvShellPrefix(odd)} printf %s "$FAL_KEY"`], { encoding: 'utf-8', env: { PATH: process.env.PATH } })).toBe('v');
  });

  it('ignores a damaged line instead of throwing', () => {
    writeFileSync(file.replace('sub/', ''), '');
    expect(parseConnectorEnv("GOOD='1'\nthis is junk\nbad name='2'\nlower='3'\nFAL_KEY='ok'\n")).toEqual({ GOOD: '1', FAL_KEY: 'ok' });
  });

  it('never writes a half file: a second writer sees whole contents', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => saveConnectorKey(i % 2 ? 'FAL_KEY' : 'OPENROUTER_API_KEY', `v${i}`, ALLOWED, file)));
    const all = await readConnectorEnv(file);
    expect(Object.keys(all).sort()).toEqual(['FAL_KEY', 'OPENROUTER_API_KEY']);
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(2);
  });
});
