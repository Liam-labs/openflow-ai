import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDeepSeekProcessEnv } from '@/lib/deepseek-env';
import { saveConnectorKey, removeConnectorKey } from '@/lib/connectors/secrets';
import { FileSecretStore } from '@/lib/secret-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A DeepSeek key saved on the Connections page must reach a DeepSeek agent: saving puts it in the secret store and in the running
// app's environment, which is where the agent start-up reads it.
let dir: string;
const old: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dskey-'));
  for (const k of ['DEVFLOW_AGENT_HOST', 'DEEPSEEK_API_KEY', 'HOME']) old[k] = process.env[k];
  process.env.DEVFLOW_AGENT_HOST = 'test-host'; // the save skips the real tmux server
  process.env.HOME = join(dir, 'home'); // no ~/.secrets to fall back on
  delete process.env.DEEPSEEK_API_KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

describe('DeepSeek key saved on the Connections page', () => {
  const allowed = new Set(['DEEPSEEK_API_KEY']);
  it('reaches a DeepSeek agent, and stops reaching it once removed', async () => {
    const store = new FileSecretStore(join(dir, 'secrets.json'));
    expect(buildDeepSeekProcessEnv(['--model', 'deepseek-flash'])).toEqual({});
    await saveConnectorKey('DEEPSEEK_API_KEY', 'sk-from-connections', allowed, store);
    expect(buildDeepSeekProcessEnv(['--model', 'deepseek-flash']).ANTHROPIC_AUTH_TOKEN).toBe('sk-from-connections');
    expect(buildDeepSeekProcessEnv(['--model', 'sonnet'])).toEqual({});
    await removeConnectorKey('DEEPSEEK_API_KEY', allowed, store);
    expect(buildDeepSeekProcessEnv(['--model', 'deepseek-flash'])).toEqual({});
  });
});
