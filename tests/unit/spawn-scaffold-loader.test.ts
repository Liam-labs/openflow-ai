import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  ACTIVE_TASK_BLOCK_MAX_BYTES,
  buildActiveTaskContext,
  buildActiveTaskLines,
  normalizeSpawnAgentType,
  shouldUseGrokAcp,
  validateHarnessScaffold,
} from '@/app/api/collab/pty/_handlers/message-inject';

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'spawn-scaffold-'));
  workspaces.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('spawn scaffold loader', () => {
  it('treats active board work as context that yields to newer direction', () => {
    const context = buildActiveTaskContext('- [12345678] Existing task');

    expect(context).toContain('latest explicit human or system direction');
    expect(context).toContain('supersedes older queued task context');
    expect(context).not.toContain('Claim and complete these before taking on new work');
  });

  it('bounds the active task block so a long board cannot exceed the argv limit', () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({
      id: `${String(i).padStart(8, '0')}-aaaa-bbbb`,
      title: `Task number ${i}`,
      description: 'long description '.repeat(500),
    }));
    const lines = buildActiveTaskLines(tasks);

    expect(Buffer.byteLength(lines, 'utf-8')).toBeLessThanOrEqual(ACTIVE_TASK_BLOCK_MAX_BYTES);
    expect(lines).toContain('- [00000000] Task number 0: long description');
    expect(lines).toMatch(/- \d+ more tasks in progress; read the task board/);
    expect(lines).not.toContain('long description '.repeat(30));
    expect(lines.split('\n').every(l => l.length < 450)).toBe(true);
  });

  it('keeps every task intact when the block is small', () => {
    const lines = buildActiveTaskLines([
      { id: 'abcdef123456', title: 'Fix\nthing', description: 'short' },
      { id: '99999999zzzz', title: 'No description' },
    ]);
    expect(lines).toBe('- [abcdef12] Fix thing: short\n- [99999999] No description');
  });

  it('defaults missing and unsupported harness values to Claude', () => {
    expect(normalizeSpawnAgentType()).toBe('claude');
    expect(normalizeSpawnAgentType('legacy-wrapper')).toBe('claude');
    expect(normalizeSpawnAgentType(' CODEX ')).toBe('codex');
  });

  it('routes only Grok Build models through the ACP harness', () => {
    expect(shouldUseGrokAcp('grok-build')).toBe(true);
    expect(shouldUseGrokAcp('GROK-BUILD-0.1')).toBe(true);
    expect(shouldUseGrokAcp('grok-build', true)).toBe(false);
    expect(shouldUseGrokAcp('grok-4.5')).toBe(false);
    expect(shouldUseGrokAcp('grok-4.3')).toBe(false);
    expect(shouldUseGrokAcp()).toBe(false);
  });

  it('requires Claude alignment when the harness value is missing', async () => {
    const root = await workspace();
    const rules = path.join(root, '.claude', 'rules');
    await mkdir(rules, { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Claude\n');
    await writeFile(path.join(rules, 'startup.md'), '# startup\n');
    await writeFile(path.join(rules, 'base-role-boilerplate.md'), '# agreement\n');

    await expect(validateHarnessScaffold(root)).rejects.toThrow(
      /missing \.claude\/rules\/alignment-claude\.md/,
    );
  });

  it('walks every local import from the selected entrypoint', async () => {
    const root = await workspace();
    const rules = path.join(root, '.claude', 'rules');
    await mkdir(rules, { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), '@./.claude/rules/startup.md\n');
    await writeFile(path.join(root, 'alignment-codex.md'), '# alignment\n');
    await writeFile(path.join(rules, 'startup.md'), '@./nested.md\n@/canonical/identity.md\n');
    await writeFile(path.join(rules, 'nested.md'), '# loaded\n');

    await expect(validateHarnessScaffold(root, 'codex')).resolves.toBeUndefined();
  });

  it('reports the missing local dependency chain before spawn', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'GROK.md'), '@./.claude/rules/missing.md\n');
    await writeFile(path.join(root, 'alignment-grok.md'), '# alignment\n');

    await expect(validateHarnessScaffold(root, 'grok')).rejects.toThrow(
      /missing \.claude\/rules\/missing\.md .*GROK\.md -> \.claude\/rules\/missing\.md/,
    );
  });

  it('rejects a local import that leaves the agent workspace', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'GEMINI.md'), '@./../outside.md\n');
    await writeFile(path.join(root, 'alignment-gemini.md'), '# alignment\n');

    await expect(validateHarnessScaffold(root, 'gemini')).rejects.toThrow(/escapes the agent workspace/);
  });
});
