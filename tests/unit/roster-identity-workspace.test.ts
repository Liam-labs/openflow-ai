import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ root: '', commands: [] as string[][], restoreOldIdentity: false }));
vi.mock('@/lib/data-paths', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/data-paths')>();
  return { ...original, DataPaths: { ...original.DataPaths, scaffolding: {
    ...original.DataPaths.scaffolding,
    get agents() { return path.join(fixture.root, 'registry', 'agents.json'); },
  } } };
});
vi.mock('child_process', async importOriginal => {
  const original = await importOriginal<typeof import('child_process')>();
  return { ...original, execFile: vi.fn((_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    fixture.commands.push(args);
    const targetIndex = args.indexOf('--target-dir');
    const output = targetIndex >= 0
      ? Promise.all([
        ...['AGENTS.md', 'alignment-codex.md'].map(file => fs.writeFile(path.join(args[targetIndex + 1], file), '# Fixture harness loader\n')),
        ...(fixture.restoreOldIdentity ? [fs.writeFile(path.join(args[targetIndex + 1], '.claude/rules/Personality.md'), `@${process.cwd()}/data/roles/personalities/Sheppard.md\n`)] : []),
      ])
      : Promise.resolve();
    output.then(() => callback(null, '', ''), error => callback(error, '', ''));
    return {};
  }) };
});

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-identity-workspace-'));
  fixture.commands = [];
  fixture.restoreOldIdentity = false;
});
afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true });
});

describe('identity workspace preparation', () => {
  it('registers a custom name, targets only its dedicated scaffold and loads the selected canonical preset', async () => {
    const { setupAgentWorkspace } = await import('@/app/api/collab/pty/_handlers/message-inject');
    const workspace = await setupAgentWorkspace(fixture.root, 'Jack 2', undefined, 'Jack', 'codex', true);
    expect(workspace).toBe(path.join(fixture.root, 'Team', 'Jack-2'));
    const registry = JSON.parse(await fs.readFile(path.join(fixture.root, 'registry', 'agents.json'), 'utf8'));
    expect(registry.agents).toEqual([expect.objectContaining({ name: 'Jack-2', agentType: 'codex', agentDir: workspace, teamDir: workspace, projectDir: fixture.root })]);
    expect(fixture.commands[0]).toContain('--target-dir');
    expect(fixture.commands[0]).toContain(workspace);
    expect(fixture.commands[0][fixture.commands[0].indexOf('--agent') + 1]).toBe('Jack-2');
    expect(await fs.readFile(path.join(workspace, '.claude/rules/Personality.md'), 'utf8')).toMatch(/@.*\/Jack\.md\n$/);
    // Ordinary subsequent spawn uses the same registry/directory identity.
    await setupAgentWorkspace(fixture.root, 'Jack 2', undefined, 'Jack', 'codex');
    expect(JSON.parse(await fs.readFile(path.join(fixture.root, 'registry', 'agents.json'), 'utf8')).agents).toHaveLength(1);
  });

  it('backs up replaced project-owned personality prose outside the auto-loaded rules', async () => {
    const { setupAgentWorkspace } = await import('@/app/api/collab/pty/_handlers/message-inject');
    const workspace = path.join(fixture.root, 'Team', 'Sheppard');
    await fs.mkdir(path.join(workspace, '.claude/rules'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.claude/rules/Personality.md'), '# Old Sheppard prose\n');
    await setupAgentWorkspace(fixture.root, 'Sheppard', undefined, 'Jack', 'codex', true);
    const histories = await fs.readdir(path.join(workspace, '.identity-history'));
    expect(histories).toHaveLength(1);
    expect(await fs.readFile(path.join(workspace, '.identity-history', histories[0], 'Personality.md'), 'utf8')).toBe('# Old Sheppard prose\n');
    expect(await fs.readFile(path.join(workspace, '.claude/rules/Personality.md'), 'utf8')).toMatch(/@.*\/Jack\.md\n$/);
  });

  it('reapplies the selected preset if pre-commit sync restores the old roster identity in the same directory', async () => {
    fixture.restoreOldIdentity = true;
    const { setupAgentWorkspace } = await import('@/app/api/collab/pty/_handlers/message-inject');
    const workspace = await setupAgentWorkspace(fixture.root, 'Sheppard', undefined, 'Jack', 'codex', true);
    expect(await fs.readFile(path.join(workspace, '.claude/rules/Personality.md'), 'utf8')).toMatch(/@.*\/Jack\.md\n$/);
  });
});
