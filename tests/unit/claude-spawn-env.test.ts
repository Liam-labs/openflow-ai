/**
 * Guard test for the Claude CLI spawn-env auth invariant.
 * Runbook §5b — the cheapest insurance against another Max→API billing leak.
 *
 * The invariant (runbook §0): an interactive Claude CLI agent bills to the Max
 * subscription if and only if ANTHROPIC_API_KEY is ABSENT from its spawned
 * process env. The key is exported in ~/.secrets → inherited by the PM2 process
 * env, so it is present by default and MUST be explicitly stripped by every
 * spawn path. A model upgrade that routes an agent down a path which forgot to
 * strip it silently flips that agent onto pay-per-token API billing.
 *
 * This test asserts the single shared scrub helper (and the shell-unset prefix
 * built from the same key list) always removes ANTHROPIC_API_KEY. All four CLI
 * spawn paths in lib/collab-pty.ts route through
 * these, so green here = the invariant holds for every path. Red here is the
 * only thing standing between a future change and another billing leak.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scrubClaudeSpawnEnv,
  claudeSpawnUnsetPrefix,
  CLAUDE_SPAWN_SCRUB_KEYS,
} from '@/lib/claude-spawn-env';

describe('CLAUDE_SPAWN_SCRUB_KEYS', () => {
  it('includes the three keys every Claude CLI spawn must remove', () => {
    expect(CLAUDE_SPAWN_SCRUB_KEYS).toContain('ANTHROPIC_API_KEY');
    expect(CLAUDE_SPAWN_SCRUB_KEYS).toContain('CLAUDECODE');
    expect(CLAUDE_SPAWN_SCRUB_KEYS).toContain('CLAUDE_CODE_ENTRYPOINT');
  });
});

describe('scrubClaudeSpawnEnv — the Max-vs-API invariant', () => {
  let saved: Record<string, string | undefined>;
  const touched = ['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

  beforeEach(() => {
    saved = {};
    for (const k of touched) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('strips ANTHROPIC_API_KEY inherited from the PM2 process env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-XXXFAKEXXX-FOR-TEST-ONLY';
    const env = scrubClaudeSpawnEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('strips CLAUDECODE and CLAUDE_CODE_ENTRYPOINT (nested-session markers)', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const env = scrubClaudeSpawnEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it('strips ANTHROPIC_API_KEY even when a caller tries to inject it via extra', () => {
    // A future caller spreading buildDeepSeekProcessEnv (which sets the key to '')
    // or any other source must never be able to reintroduce the key.
    const env = scrubClaudeSpawnEnv({ ANTHROPIC_API_KEY: 'sk-ant-leak', FOO: 'bar' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FOO).toBe('bar');
  });

  it('preserves the DeepSeek override (AUTH_TOKEN + BASE_URL) — only the API key is stripped', () => {
    // DeepSeek rides the Claude CLI but bills DeepSeek via the headless
    // AUTH_TOKEN path. Those two must survive; only ANTHROPIC_API_KEY goes.
    const env = scrubClaudeSpawnEnv({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'deepseek-key-value',
      ANTHROPIC_API_KEY: '',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('deepseek-key-value');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('passes through unrelated extra env (channel identity, etc.)', () => {
    const env = scrubClaudeSpawnEnv({
      DEVFLOW_CHANNEL_ID: 'chan-123',
      DEVFLOW_PARTICIPANT_ID: 'p-456',
    });
    expect(env.DEVFLOW_CHANNEL_ID).toBe('chan-123');
    expect(env.DEVFLOW_PARTICIPANT_ID).toBe('p-456');
  });
});

describe('claudeSpawnUnsetPrefix — shell path (tmux / WSL)', () => {
  it('unsets all scrub keys and ends with ; for safe concatenation', () => {
    const prefix = claudeSpawnUnsetPrefix();
    expect(prefix).toContain('ANTHROPIC_API_KEY');
    expect(prefix).toContain('CLAUDECODE');
    expect(prefix).toContain('CLAUDE_CODE_ENTRYPOINT');
    expect(prefix.startsWith('unset ')).toBe(true);
    expect(prefix.trimEnd()).toMatch(/;$/);
  });

  it('covers exactly the same key list as the process-env scrub (single source of truth)', () => {
    const prefix = claudeSpawnUnsetPrefix();
    for (const key of CLAUDE_SPAWN_SCRUB_KEYS) {
      expect(prefix).toContain(key);
    }
  });
});

describe('API-key mode (DEVFLOW_CLAUDE_AUTH=api-key) — opt-in for installs with no Claude login', () => {
  let saved: Record<string, string | undefined>;
  const touched = ['ANTHROPIC_API_KEY', 'DEVFLOW_CLAUDE_AUTH'];
  beforeEach(() => {
    saved = {};
    for (const k of touched) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = 'sk-ant-XXXFAKEXXX-FOR-TEST-ONLY';
  });
  afterEach(() => {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is off unless the setting is exactly api-key: the key is still stripped', () => {
    for (const value of [undefined, '', 'subscription', 'true', '1']) {
      if (value === undefined) delete process.env.DEVFLOW_CLAUDE_AUTH;
      else process.env.DEVFLOW_CLAUDE_AUTH = value;
      expect(scrubClaudeSpawnEnv().ANTHROPIC_API_KEY).toBeUndefined();
      expect(claudeSpawnUnsetPrefix()).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('keeps DevFlow\'s own key when on, and the shell prefix no longer unsets it', () => {
    process.env.DEVFLOW_CLAUDE_AUTH = 'api-key';
    expect(scrubClaudeSpawnEnv().ANTHROPIC_API_KEY).toBe('sk-ant-XXXFAKEXXX-FOR-TEST-ONLY');
    const prefix = claudeSpawnUnsetPrefix();
    expect(prefix).not.toContain('ANTHROPIC_API_KEY');
    expect(prefix).toContain('CLAUDECODE');
    expect(prefix).toContain('CLAUDE_CODE_ENTRYPOINT');
  });

  it('still removes the nested-session markers when on', () => {
    process.env.DEVFLOW_CLAUDE_AUTH = 'api-key';
    const env = scrubClaudeSpawnEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it('does not let a caller inject a key, and DeepSeek (which sets it empty) still loses it', () => {
    process.env.DEVFLOW_CLAUDE_AUTH = 'api-key';
    expect(scrubClaudeSpawnEnv({ ANTHROPIC_API_KEY: 'sk-ant-leak' }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubClaudeSpawnEnv({ ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps nothing when the key is not set at all', () => {
    process.env.DEVFLOW_CLAUDE_AUTH = 'api-key';
    delete process.env.ANTHROPIC_API_KEY;
    expect(scrubClaudeSpawnEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });
});
