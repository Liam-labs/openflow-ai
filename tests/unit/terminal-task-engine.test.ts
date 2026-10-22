/**
 * Tests for grok engine dispatch in lib/terminal-task-engine.ts.
 *
 * Sprint 47 / T1.1: Add grok engine case to TerminalTaskEngine dispatch.
 * TDD: these tests were written before the grok cases were implemented.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEngineCommand,
  getExitCommand,
  validateEngineModel,
  ENGINE_TIMING,
} from '@/lib/terminal-task-engine';
import type { ClaudeModelMap } from '@/lib/terminal-task-engine';

// Stub claude model map — not exercised by grok tests but required by signature
const STUB_CLAUDE_MAP: ClaudeModelMap = {
  haiku: 'claude-haiku-test',
  sonnet: 'claude-sonnet-test',
  opus: 'claude-opus-test',
};

// ─── ENGINE_TIMING ────────────────────────────────────────────────────────────

describe('ENGINE_TIMING — grok', () => {
  it('grok timing entry exists', () => {
    expect(ENGINE_TIMING.grok).toBeDefined();
  });

  it('grok startupWaitMs is a positive number', () => {
    expect(ENGINE_TIMING.grok.startupWaitMs).toBeGreaterThan(0);
  });

  it('grok idleThresholdMs is a positive number', () => {
    expect(ENGINE_TIMING.grok.idleThresholdMs).toBeGreaterThan(0);
  });

  it('grok minResponseTimeMs is a positive number', () => {
    expect(ENGINE_TIMING.grok.minResponseTimeMs).toBeGreaterThan(0);
  });
});

// ─── validateEngineModel ──────────────────────────────────────────────────────

describe('validateEngineModel — grok', () => {
  it('accepts grok engine without an explicit ollamaModel (defaults to grok-4.20)', () => {
    expect(validateEngineModel('grok', undefined, undefined, STUB_CLAUDE_MAP)).toEqual({ valid: true });
  });

  it('accepts grok engine with an explicit ollamaModel override', () => {
    expect(validateEngineModel('grok', undefined, 'grok-4', STUB_CLAUDE_MAP)).toEqual({ valid: true });
  });

  it('error message for unknown engine includes "grok" as a supported option', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateEngineModel('unknown' as any, undefined, undefined, STUB_CLAUDE_MAP);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('grok');
  });
});

// ─── buildEngineCommand ───────────────────────────────────────────────────────

describe('buildEngineCommand — grok', () => {
  it('returns an array of command parts (not empty)', () => {
    const parts = buildEngineCommand('grok', 'sonnet', undefined, undefined, STUB_CLAUDE_MAP);
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBeGreaterThan(0);
  });

  it('sources ~/.secrets so XAI_API_KEY is available', () => {
    const cmd = buildEngineCommand('grok', 'sonnet', undefined, undefined, STUB_CLAUDE_MAP).join(' ');
    expect(cmd).toContain('~/.secrets');
  });

  it('defaults to grok-4.7 when no ollamaModel is specified', () => {
    const cmd = buildEngineCommand('grok', 'sonnet', undefined, undefined, STUB_CLAUDE_MAP).join(' ');
    expect(cmd).toContain('grok-4.7');
  });

  it('uses ollamaModel as the grok model name when specified', () => {
    const cmd = buildEngineCommand('grok', 'sonnet', 'grok-4', undefined, STUB_CLAUDE_MAP).join(' ');
    expect(cmd).toContain('grok-4');
    expect(cmd).not.toContain('grok-4.7');
  });

  it('includes the terminal-task-grok.py script path', () => {
    const cmd = buildEngineCommand('grok', 'sonnet', undefined, undefined, STUB_CLAUDE_MAP).join(' ');
    expect(cmd).toContain('terminal-task-grok.py');
  });

  it('includes system prompt file path when provided', () => {
    const cmd = buildEngineCommand('grok', 'sonnet', undefined, '/tmp/sys.txt', STUB_CLAUDE_MAP).join(' ');
    expect(cmd).toContain('/tmp/sys.txt');
  });

  it('omits system prompt args when not provided', () => {
    const cmd = buildEngineCommand('grok', 'sonnet', undefined, undefined, STUB_CLAUDE_MAP).join(' ');
    expect(cmd).not.toContain('system-prompt');
  });
});

// ─── getExitCommand ───────────────────────────────────────────────────────────

describe('getExitCommand — grok', () => {
  it('returns a non-empty string for grok', () => {
    const cmd = getExitCommand('grok');
    expect(typeof cmd).toBe('string');
    expect(cmd.length).toBeGreaterThan(0);
  });
});

// ─── approveClaudeTrust ───────────────────────────────────────────────────────

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { approveClaudeTrust } from '@/lib/terminal-task-engine';

describe('approveClaudeTrust', () => {
  async function tmpConfig(content?: string) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trust-'));
    const file = path.join(dir, '.claude.json');
    if (content !== undefined) await fsp.writeFile(file, content);
    return file;
  }

  it('trusts a new folder and keeps everything else in the config', async () => {
    const file = await tmpConfig(JSON.stringify({ theme: 'dark', projects: { '/a': { hasTrustDialogAccepted: true, keep: 1 } } }));
    expect(await approveClaudeTrust('/tmp/terminal-tasks', file)).toBe(true);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(out.theme).toBe('dark');
    expect(out.projects['/a']).toEqual({ hasTrustDialogAccepted: true, keep: 1 });
    expect(out.projects['/tmp/terminal-tasks'].hasTrustDialogAccepted).toBe(true);
  });

  it('does not rewrite the file when the folder is already trusted', async () => {
    const file = await tmpConfig();
    await approveClaudeTrust('/x', file);
    const before = (await fsp.stat(file)).mtimeMs;
    await new Promise(r => setTimeout(r, 15));
    expect(await approveClaudeTrust('/x', file)).toBe(false);
    expect((await fsp.stat(file)).mtimeMs).toBe(before);
  });

  it('creates the config when there is none', async () => {
    const file = await tmpConfig();
    expect(await approveClaudeTrust('/x', file)).toBe(true);
  });

  it('refuses to overwrite a config it cannot parse', async () => {
    const file = await tmpConfig('{ not json');
    await expect(approveClaudeTrust('/x', file)).rejects.toThrow();
    expect(await fsp.readFile(file, 'utf8')).toBe('{ not json');
  });
});
