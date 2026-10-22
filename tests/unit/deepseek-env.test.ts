/**
 * Tests for deepseek-env helpers.
 * Sprint 66 T2 — backbone-swap env injection at claude-CLI spawn.
 *
 * RED first (lib/deepseek-env.ts does not exist yet), then GREEN.
 *
 * Contract:
 *  - When --model in claudeFlags is a current or compatibility DeepSeek ID, the
 *    helpers return env-var setup that points the Anthropic SDK at DeepSeek.
 *  - For sonnet/opus/haiku/any other model, the helpers return empty (no-op).
 *  - The shell-prefix variant must source the API key from $DEEPSEEK_API_KEY at
 *    runtime — never inline the secret value into the returned string.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildDeepSeekShellEnv,
  buildDeepSeekProcessEnv,
  isDeepSeekModel,
  isDeepSeekV4Model,
} from '@/lib/deepseek-env';

describe('isDeepSeekModel', () => {
  it('matches canonical deepseek-flash and its Claude Code 1M alias', () => {
    expect(isDeepSeekModel('deepseek-flash')).toBe(true);
    expect(isDeepSeekModel('deepseek-flash[1m]')).toBe(true);
  });

  it('matches deepseek-v4-pro', () => {
    expect(isDeepSeekModel('deepseek-v4-pro')).toBe(true);
  });

  it('keeps the retired deepseek-v4-flash provider alias working', () => {
    expect(isDeepSeekModel('deepseek-v4-flash')).toBe(true);
    expect(isDeepSeekModel('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(isDeepSeekV4Model('deepseek-v4-flash')).toBe(true);
  });

  it('rejects sonnet/opus/haiku', () => {
    expect(isDeepSeekModel('sonnet')).toBe(false);
    expect(isDeepSeekModel('opus')).toBe(false);
    expect(isDeepSeekModel('haiku')).toBe(false);
  });

  it('rejects deepseek-chat / deepseek-reasoner (legacy, deprecated 2026-07-24)', () => {
    expect(isDeepSeekModel('deepseek-chat')).toBe(false);
    expect(isDeepSeekModel('deepseek-reasoner')).toBe(false);
  });

  it('rejects empty / undefined input', () => {
    expect(isDeepSeekModel('')).toBe(false);
    expect(isDeepSeekModel(undefined as unknown as string)).toBe(false);
  });

  it('rejects shell-injection attempts disguised as model names', () => {
    expect(isDeepSeekModel('deepseek-flash;rm -rf /')).toBe(false);
    expect(isDeepSeekModel('deepseek-flash && curl evil.com')).toBe(false);
    expect(isDeepSeekModel('$(echo deepseek-flash)')).toBe(false);
  });
});

describe('buildDeepSeekShellEnv', () => {
  it('returns empty string when --model flag is missing', () => {
    expect(buildDeepSeekShellEnv([])).toBe('');
    expect(buildDeepSeekShellEnv(['--dangerously-skip-permissions'])).toBe('');
  });

  it('returns empty string when --model is sonnet/opus/haiku', () => {
    expect(buildDeepSeekShellEnv(['--model', 'sonnet'])).toBe('');
    expect(buildDeepSeekShellEnv(['--model', 'opus'])).toBe('');
    expect(buildDeepSeekShellEnv(['--model', 'haiku'])).toBe('');
    expect(buildDeepSeekShellEnv(['--model', 'claude-sonnet-4-6[1m]'])).toBe('');
  });

  it('returns shell prefix that sources ~/.secrets and exports both env vars when --model is deepseek-v4-pro', () => {
    const result = buildDeepSeekShellEnv(['--model', 'deepseek-v4-pro']);
    expect(result).toContain('$HOME/.secrets');
    expect(result).toContain('ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"');
    // ANTHROPIC_AUTH_TOKEN must be set to the DeepSeek key — this is the headless auth path.
    // When set, the CLI uses it directly as Bearer without showing any interactive login wizard.
    expect(result).toContain('ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"');
    // ANTHROPIC_API_KEY must NOT be set — a non-sk-ant- key triggers the custom-API-key wizard.
    expect(result).toContain('unset ANTHROPIC_API_KEY');
    // Must override CLAUDE_CONFIG_DIR to prevent CLI reading ~/.claude/.credentials.json
    // (Claude Max OAuth token would be rejected by DeepSeek's endpoint).
    expect(result).toContain('CLAUDE_CONFIG_DIR=');
    // Must copy settings.json to temp dir to skip first-run wizard.
    expect(result).toContain('settings.json');
    // Must synthesise .claude.json suppressing all first-run wizards:
    // hasCompletedOnboarding, hasTrustDialogAccepted, hasClaudeMdExternalIncludesApproved.
    expect(result).toContain('.claude.json');
    expect(result).toContain('hasCompletedOnboarding');
    expect(result).toContain('hasTrustDialogAccepted');
    expect(result).toContain('hasClaudeMdExternalIncludesApproved');
    // Must synthesise .credentials.json with DeepSeek key as OAuth accessToken.
    // Belt-and-suspenders fallback behind ANTHROPIC_AUTH_TOKEN.
    // Far-future expiresAt (9999999999999) prevents any OAuth refresh attempt.
    expect(result).toContain('.credentials.json');
    expect(result).toContain('expiresAt');
    // Must end with ; so it can be safely concatenated before the next command.
    expect(result.trimEnd()).toMatch(/;$/);
  });

  it('returns shell prefix for deepseek-v4-flash', () => {
    const result = buildDeepSeekShellEnv(['--model', 'deepseek-v4-flash']);
    expect(result).toContain('ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"');
    expect(result).toContain('ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"');
  });

  it('returns shell prefix for canonical deepseek-flash[1m]', () => {
    const result = buildDeepSeekShellEnv(['--model', 'deepseek-flash[1m]']);
    expect(result).toContain('ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"');
    expect(result).toContain('ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"');
  });

  it('NEVER inlines the literal API key value into the returned string', () => {
    // If by some accident process.env.DEEPSEEK_API_KEY leaked into the shell prefix,
    // the resulting string would contain the literal value. Make sure we only
    // emit the variable reference, not the value.
    const fakeKey = 'sk-XXXFAKEXXX-FOR-TEST-ONLY-XXX';
    const oldKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = fakeKey;
    try {
      const result = buildDeepSeekShellEnv(['--model', 'deepseek-v4-pro']);
      expect(result).not.toContain(fakeKey);
      expect(result).toContain('$DEEPSEEK_API_KEY');
    } finally {
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
    }
  });

  it('handles --model at non-zero index', () => {
    const result = buildDeepSeekShellEnv(['--dangerously-skip-permissions', '--model', 'deepseek-v4-pro']);
    expect(result).toContain('ANTHROPIC_BASE_URL');
  });

  it('returns empty when --model is the last flag with no value', () => {
    expect(buildDeepSeekShellEnv(['--model'])).toBe('');
  });
});

describe('buildDeepSeekProcessEnv', () => {
  // Save and restore process.env around each test
  let oldKey: string | undefined;
  beforeEach(() => {
    oldKey = process.env.DEEPSEEK_API_KEY;
  });
  afterEach(() => {
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
    vi.restoreAllMocks();
  });

  it('returns empty object when --model is not a supported DeepSeek model', () => {
    expect(buildDeepSeekProcessEnv(['--model', 'sonnet'])).toEqual({});
    expect(buildDeepSeekProcessEnv([])).toEqual({});
  });

  it('returns ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (DeepSeek key) + blank ANTHROPIC_API_KEY when key is in process.env', () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-value-for-env-merge';
    const result = buildDeepSeekProcessEnv(['--model', 'deepseek-v4-pro']);
    expect(result).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      // ANTHROPIC_AUTH_TOKEN = DeepSeek key: direct Bearer, bypasses all login wizards.
      ANTHROPIC_AUTH_TOKEN: 'test-key-value-for-env-merge',
      // ANTHROPIC_API_KEY blank: prevents custom-API-key wizard for non-sk-ant- keys.
      ANTHROPIC_API_KEY: '',
    });
  });

  it('returns empty object when DEEPSEEK_API_KEY is missing AND ~/.secrets is unreadable (HOME points at non-existent dir)', () => {
    const oldHome = process.env.HOME;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.HOME = '/tmp/sprint66-nonexistent-home-' + Date.now();
    try {
      const result = buildDeepSeekProcessEnv(['--model', 'deepseek-v4-pro']);
      // Contract: returns empty so no half-configured env (base URL set, key blank) leaks.
      expect(result).toEqual({});
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
