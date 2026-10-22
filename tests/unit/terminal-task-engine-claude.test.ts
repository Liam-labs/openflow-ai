/**
 * The launch command for the claude engine of terminal tasks (lib/terminal-task-engine.ts).
 *
 * A task's answer is read back with `tmux capture-pane`. The fullscreen renderer (settings "tui": "fullscreen", set on both of
 * Owner's machines) draws on the alternate screen, which has no scrollback, so a long answer came back as only its last screenful
 * (19 Oct 2026: the weekly changelog analysis returned its last 23 lines). Every claude task is therefore started with the
 * default renderer, for that one launch only.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildEngineCommand } from '@/lib/terminal-task-engine';
import type { ClaudeModelMap } from '@/lib/terminal-task-engine';

const MAP: ClaudeModelMap = { haiku: 'claude-haiku-test', sonnet: 'claude-sonnet-test', opus: 'claude-opus-test' };

/** What the route does to the command before tmux sees it (app/api/terminal-tasks/route.ts): wrap in single quotes, escape inner ones. */
function routeQuote(command: string): string {
  return `'${command.replace(/'/g, "'\\''")}'`;
}

/** Run the command text with `claude` replaced by a function that prints its arguments NUL-separated; returns the argument list. */
function argvSeenByClaude(command: string): string[] {
  const out = execFileSync('bash', ['-c', `claude() { printf '%s\\0' "$@"; }; ${command}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

describe('claude engine launch command', () => {
  it('starts claude with the default renderer, the permission bypass and the chosen model', () => {
    const parts = buildEngineCommand('claude', 'sonnet', undefined, undefined, MAP);
    const argv = argvSeenByClaude(parts.join(' '));
    expect(argv.slice(0, 3)).toEqual(['--dangerously-skip-permissions', '--model', 'claude-sonnet-test']);
    const settings = argv[argv.indexOf('--settings') + 1];
    expect(JSON.parse(settings)).toEqual({ tui: 'default' });
  });

  it('keeps the settings JSON intact through the route\'s single-quote escaping and the outer shell', () => {
    const full = buildEngineCommand('claude', 'haiku', undefined, undefined, MAP).join(' ');
    // The outer shell removes the quoting the route adds; what is left must be the original command text.
    const afterOuterShell = execFileSync('sh', ['-c', `printf %s ${routeQuote(full)}`], { encoding: 'utf8' });
    expect(afterOuterShell).toBe(full);
    // And the inner shell (tmux runs it) must still hand claude the JSON as ONE argument.
    const argv = argvSeenByClaude(afterOuterShell);
    expect(argv).toContain('{"tui":"default"}');
  });

  it('still passes a system prompt file as a single argument', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
    try {
      const file = path.join(dir, 'task.system');
      writeFileSync(file, `Line one\nShe said "hi" and it's fine\n`);
      const argv = argvSeenByClaude(buildEngineCommand('claude', 'opus', undefined, file, MAP).join(' '));
      expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(`Line one\nShe said "hi" and it's fine`);
      expect(argv).toContain('{"tui":"default"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not add the renderer setting to the other engines', () => {
    expect(buildEngineCommand('gemini', 'sonnet', undefined, undefined, MAP).join(' ')).not.toContain('tui');
    expect(buildEngineCommand('ollama', 'sonnet', undefined, undefined, MAP).join(' ')).not.toContain('tui');
    expect(buildEngineCommand('grok', 'sonnet', undefined, undefined, MAP).join(' ')).not.toContain('tui');
  });
});
