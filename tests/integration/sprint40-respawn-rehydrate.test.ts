/**
 * Sprint 40 T3.1 — Integration test for both respawn modes + backward compat.
 *
 * Tests the full respawn pipeline:
 * 1. Standard respawn (rehydrate=false) — no rehydrate block in role temp file
 * 2. Rehydrate respawn (rehydrate=true) — rehydrate block injected
 * 3. Backward compat — old frontend calling without rehydrate field defaults to no injection
 *
 * Strategy: import handleRosterRespawnAction directly, mock file I/O + tmux + pty.
 * This exercises the real handler branching without needing a running server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Mocks — set up before dynamic imports
// ---------------------------------------------------------------------------

// Track role temp file writes
const writtenFiles = new Map<string, string>();
const readableFiles = new Map<string, string>();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(async (filePath: string, _encoding?: string) => {
        const p = filePath.toString();
        if (readableFiles.has(p)) return readableFiles.get(p);
        if (writtenFiles.has(p)) return writtenFiles.get(p);
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
      }),
      writeFile: vi.fn(async (filePath: string, content: string) => {
        writtenFiles.set(filePath.toString(), content);
      }),
      mkdir: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      access: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
    },
  };
});

// Workspace setup invokes the canonical scaffolding and hook merge CLIs before
// launch. This integration test owns the handler branch, not those subprocesses.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((
      _file: string,
      _args: readonly string[],
      options: unknown,
      callback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const done = typeof options === 'function' ? options : callback;
      if (typeof done === 'function') done(null, '', '');
      return {};
    }),
  };
});

// Mock data-io (withFileLock should be pass-through)
vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn(async () => ({ tasks: [], lastUpdated: '' })),
  withFileLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock collab-pty (tmux/spawn operations)
vi.mock('@/lib/collab-pty', () => ({
  spawnCollabPtySession: vi.fn(async () => ({
    session: { id: 'test-session-001', pid: 12345 },
    participant: { id: 'part-001', name: 'TestAgent' },
  })),
  spawnWindowsPtySession: vi.fn(async () => ({
    session: { id: 'test-session-001', pid: 12345 },
    participant: { id: 'part-001', name: 'TestAgent' },
  })),
  forceKillByTmuxName: vi.fn(async () => {}),
  captureClaudeSessionId: vi.fn(async () => null),
  snapshotSessionFiles: vi.fn(() => new Set<string>()),
  safeKillProcess: vi.fn(async () => {}),
  cleanupTempFiles: vi.fn(async () => {}),
  killOrphanedWrapperProcesses: vi.fn(async () => {}),
  sweepStaleCollabFiles: vi.fn(async () => {}),
  tmuxSessionExists: vi.fn(async () => false),
}));

// Mock team-operations
vi.mock('@/lib/team-operations', () => ({
  syncSessionIdsToTeam: vi.fn(async () => {}),
}));

// Mock collab-message-io
vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: vi.fn(async () => {}),
}));

// Mock log-writer
vi.mock('@/lib/log-writer', () => ({
  logEvent: vi.fn(async () => {}),
}));

// Mock role-tools
vi.mock('@/lib/role-tools', () => ({
  parseRoleFrontmatter: vi.fn(() => ({})),
  getEffectiveToolsForRole: vi.fn(() => []),
  buildAllowedToolsFlag: vi.fn(() => ''),
}));

// Mock data-paths
vi.mock('@/lib/data-paths', () => ({
  DataPaths: {
    collabTasks: '/tmp/test-collab-tasks.json',
  },
}));

// Build a fake channels data structure for the respawn handler
const fakeAgent = {
  id: 'agent-rehydrate-test',
  name: 'TestAgent',
  status: 'running' as const,
  participantId: 'part-001',
  tmuxSessionName: 'collab-agent-test1234',
  ptySessionId: 'pty-001',
  useCollabWrapper: true,
  workingDirectory: '/tmp/test-agent',
};

const fakeChannelsData = {
  channels: [{
    id: 'ch-rehydrate-test',
    name: 'Test Channel',
    participants: [{ id: 'part-001', name: 'TestAgent', type: 'agent', source: 'WSL', joinedAt: '', lastSeen: '' }],
    messages: [] as unknown[],
    lastActivity: '',
    roster: {
      agents: [{ ...fakeAgent }],
      lastUpdated: '',
    },
  }],
};

// Mock _pty-shared readChannelsData/writeChannelsData
// The handler imports from '../_pty-shared' (relative), which resolves via tsconfig to:
vi.mock('@/app/api/collab/pty/_pty-shared', async () => {
  return {
    CHANNELS_PATH: '/tmp/test-channels.json',
    readChannelsData: vi.fn(async () => JSON.parse(JSON.stringify(fakeChannelsData))),
    writeChannelsData: vi.fn(async () => {}),
    getAvailableMemoryMB: vi.fn(async () => 4096),
    MIN_MEMORY_FOR_SPAWN_MB: 512,
    findPersonalityFile: vi.fn(async () => null),
    readTemplateFile: vi.fn(async () => null),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sprint 40: Respawn rehydrate integration', () => {
  beforeEach(() => {
    writtenFiles.clear();
    readableFiles.clear();
    const workspace = '/tmp/test-agent/Team/TestAgent';
    for (const relative of [
      'CLAUDE.md',
      '.claude/rules/startup.md',
      '.claude/rules/base-role-boilerplate.md',
      '.claude/rules/alignment-claude.md',
    ]) {
      readableFiles.set(path.join(workspace, relative), '');
    }
    // Reset agent status for each test
    fakeChannelsData.channels[0].roster.agents[0].status = 'running';
    fakeChannelsData.channels[0].messages = [];
  });

  it('standard respawn (rehydrate=false) does NOT inject rehydrate block', async () => {
    const { handleRosterRespawnAction } = await import(
      '../../app/api/collab/pty/_handlers/message-inject'
    );

    const result = await handleRosterRespawnAction(
      { action: 'roster_respawn', channelId: 'ch-rehydrate-test', agentId: 'agent-rehydrate-test', rehydrate: false },
      new Date().toISOString()
    );

    const body = await result.json();
    expect(body.success).toBe(true);

    // Check no temp file contains rehydrate
    for (const [, content] of writtenFiles) {
      expect(content).not.toContain('[REHYDRATE]');
    }
  });

  it('rehydrate respawn (rehydrate=true) injects rehydrate block into role temp file', async () => {
    const { handleRosterRespawnAction } = await import(
      '../../app/api/collab/pty/_handlers/message-inject'
    );

    const result = await handleRosterRespawnAction(
      { action: 'roster_respawn', channelId: 'ch-rehydrate-test', agentId: 'agent-rehydrate-test', rehydrate: true },
      new Date().toISOString()
    );

    const body = await result.json();
    expect(body.success).toBe(true);

    // Find the role temp file that was written
    const rehydrateFile = [...writtenFiles.entries()].find(([, content]) =>
      content.includes('[REHYDRATE]')
    );
    expect(rehydrateFile).toBeDefined();
    expect(rehydrateFile![1]).toContain('last 50 messages');
    expect(rehydrateFile![1]).toContain('Rehydrate Context');
  });

  it('backward compat — omitted rehydrate field defaults to no injection', async () => {
    const { handleRosterRespawnAction } = await import(
      '../../app/api/collab/pty/_handlers/message-inject'
    );

    // Old frontend sends no rehydrate field at all
    const result = await handleRosterRespawnAction(
      { action: 'roster_respawn', channelId: 'ch-rehydrate-test', agentId: 'agent-rehydrate-test' },
      new Date().toISOString()
    );

    const body = await result.json();
    expect(body.success).toBe(true);

    for (const [, content] of writtenFiles) {
      expect(content).not.toContain('[REHYDRATE]');
    }
  });

  it('rehydrate block co-exists with task injection', async () => {
    // Set up a fake active task so task injection fires
    const { readJsonFile } = await import('@/lib/data-io');
    (readJsonFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tasks: [{
        channelId: 'ch-rehydrate-test',
        assigneeId: 'part-001',
        status: 'in_progress',
        id: 'task-123',
        title: 'Test Task',
        description: 'Do the thing',
      }],
      lastUpdated: '',
    });

    const { handleRosterRespawnAction } = await import(
      '../../app/api/collab/pty/_handlers/message-inject'
    );

    const result = await handleRosterRespawnAction(
      { action: 'roster_respawn', channelId: 'ch-rehydrate-test', agentId: 'agent-rehydrate-test', rehydrate: true },
      new Date().toISOString()
    );

    const body = await result.json();
    expect(body.success).toBe(true);

    // Find the file that has BOTH task and rehydrate blocks
    const combinedFile = [...writtenFiles.entries()].find(([, content]) =>
      content.includes('[REHYDRATE]')
    );
    expect(combinedFile).toBeDefined();
    // The rehydrate block should be present
    expect(combinedFile![1]).toContain('[REHYDRATE]');
    expect(combinedFile![1]).toContain('Rehydrate Context');
  });

  it('buildRehydrateBlock returns correctly for all input types', async () => {
    const { buildRehydrateBlock } = await import(
      '../../app/api/collab/pty/_handlers/message-inject'
    );

    // True → block
    const block = buildRehydrateBlock(true);
    expect(block).toContain('[REHYDRATE]');

    // False → null
    expect(buildRehydrateBlock(false)).toBeNull();

    // Undefined → null
    expect(buildRehydrateBlock(undefined)).toBeNull();
  });
});
