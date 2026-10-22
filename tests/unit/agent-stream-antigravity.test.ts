/**
 * Sprint A T3.1 — Antigravity step interpretation.
 *
 * Builder's Phase-2 producer emits decoded Antigravity steps as Claude-shaped
 * RawContentBlocks; tool_use steps carry a human `toolSummary` + `toolAction`
 * in input (plus the real downstream tool as the name, e.g. "outlook
 * check_auth_status"). These tests pin the interpreter behaviour the rendered
 * view depends on: detection, icon/verb/subject, tone, and the end-to-end
 * path through the public interpret() (which routes via genericFallback).
 */

import { describe, it, expect } from 'vitest';
import {
  isAntigravityStep,
  interpretAntigravity,
  antigravityTone,
} from '@/lib/agent-stream-interpret/handlers/antigravity';
import { interpret } from '@/lib/agent-stream-interpret';
import type { StreamItem } from '@/components/collab/agent-stream/types';

function toolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = 'agy-1',
): StreamItem {
  return {
    id: 'x:0',
    kind: 'tool_use',
    role: 'assistant',
    timestamp: '2026-06-06T00:00:00.000Z',
    toolName,
    toolInput,
    toolUseId,
  };
}

describe('isAntigravityStep', () => {
  it('is true when toolSummary present', () => {
    expect(isAntigravityStep({ toolSummary: 'View CLAUDE.md' })).toBe(true);
  });
  it('is true when toolAction present', () => {
    expect(isAntigravityStep({ toolAction: 'Viewing file' })).toBe(true);
  });
  it('is false for Claude-shaped inputs (no agy markers)', () => {
    expect(isAntigravityStep({ file_path: '/home/user/x.ts' })).toBe(false);
    expect(isAntigravityStep({ command: 'ls' })).toBe(false);
  });
  it('is false for empty / undefined input', () => {
    expect(isAntigravityStep(undefined)).toBe(false);
    expect(isAntigravityStep({})).toBe(false);
  });
});

describe('interpretAntigravity', () => {
  it('leads with toolAction (verb) + toolSummary (subject)', () => {
    const a = interpretAntigravity(
      { toolAction: 'Viewing file', toolSummary: 'View CLAUDE.md', path: '/home/user/CLAUDE.md' },
      toolUse('view_file', {}),
    );
    expect(a.verb).toBe('Viewing file');
    expect(a.subject).toBe('View CLAUDE.md');
    expect(a.icon).toBe('file-text');
    expect(a.toolName).toBe('view_file');
    expect(a.toolUseId).toBe('agy-1');
  });

  it('falls back to a prettified name + arg summary when summaries absent', () => {
    const a = interpretAntigravity(
      { command: 'pm2 status' },
      toolUse('run_command', { command: 'pm2 status' }),
    );
    expect(a.verb).toBe('Run command');
    expect(a.subject).toContain('pm2 status');
    expect(a.icon).toBe('terminal');
  });

  it('strips the home prefix in the subject', () => {
    const a = interpretAntigravity(
      { toolSummary: '/home/user/DevFlow/x.ts' },
      toolUse('view_file', {}),
    );
    expect(a.subject).toBe('~/DevFlow/x.ts');
  });

  it('assigns sensible icons by category', () => {
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('grep_search', {})).icon).toBe('search');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('list_dir', {})).icon).toBe('folder-search');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('list_directory', {})).icon).toBe('folder-search');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('generic', {})).icon).toBe('wrench');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('search_web', {})).icon).toBe('globe');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('git_commit', {})).icon).toBe('git-branch');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('browser_click_element', {})).icon).toBe('eye');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('generate_image', {})).icon).toBe('image');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('invoke_subagent', {})).icon).toBe('brain');
    expect(interpretAntigravity({ toolSummary: 's' }, toolUse('outlook check_auth_status', {})).icon).toBe('mail');
  });
});

describe('antigravityTone', () => {
  it('read-only tools are neutral', () => {
    expect(antigravityTone('view_file')).toBe('neutral');
    expect(antigravityTone('list_dir')).toBe('neutral');
    expect(antigravityTone('grep_search')).toBe('neutral');
    expect(antigravityTone('command_status')).toBe('neutral');
  });
  it('local mutations are mutate', () => {
    expect(antigravityTone('run_command')).toBe('mutate');
    expect(antigravityTone('code_action')).toBe('mutate');
    expect(antigravityTone('git_commit')).toBe('mutate');
  });
  it('outside-the-machine actions are external', () => {
    expect(antigravityTone('search_web')).toBe('external');
    expect(antigravityTone('browser_click_element')).toBe('external');
    expect(antigravityTone('invoke_subagent')).toBe('external');
    expect(antigravityTone('outlook check_auth_status')).toBe('external');
  });
  it('destructive verbs are danger', () => {
    expect(antigravityTone('outlook send_email')).toBe('danger');
    expect(antigravityTone('outlook delete_email')).toBe('danger');
  });
});

describe('interpret() end-to-end for Antigravity steps', () => {
  it('routes an Antigravity tool_use through interpretAntigravity + antigravity tone', () => {
    const a = interpret(
      toolUse('view_file', { toolAction: 'Viewing file', toolSummary: 'View CLAUDE.md' }),
    );
    expect(a.subject).toBe('View CLAUDE.md');
    expect(a.verb).toBe('Viewing file');
    expect(a.icon).toBe('file-text');
    expect(a.tone).toBe('neutral');
  });

  it('resolves mutate tone for run_command via the public path', () => {
    const a = interpret(
      toolUse('run_command', { toolAction: 'Running command', toolSummary: 'pm2 restart devflow' }),
    );
    expect(a.tone).toBe('mutate');
    expect(a.icon).toBe('terminal');
  });

  it('fills outcome from a paired tool_result (is_error → not ok)', () => {
    const use = toolUse('run_command', { toolAction: 'Running command', toolSummary: 'bad cmd' }, 'agy-err');
    const result: StreamItem = {
      id: 'x:1',
      kind: 'tool_result',
      role: 'user',
      timestamp: '2026-06-06T00:00:01.000Z',
      toolUseId: 'agy-err',
      toolResultText: 'command not found',
      toolResultIsError: true,
    };
    const a = interpret(use, result);
    expect(a.outcome).not.toBeNull();
    expect(a.outcome?.ok).toBe(false);
  });

  it('does not mistake Claude tools for Antigravity (Read stays Read)', () => {
    const a = interpret({
      id: 'c:0',
      kind: 'tool_use',
      role: 'assistant',
      timestamp: '2026-06-06T00:00:00.000Z',
      toolName: 'Read',
      toolInput: { file_path: '/home/user/x.ts' },
      toolUseId: 'c-1',
    });
    // Read has its own handler/tone — must NOT be hijacked by the agy path.
    expect(a.tone).toBe('neutral');
    expect(a.toolName).toBe('Read');
    expect(a.icon).toBe('file-text');
  });
});
