/**
 * P1.1 TDD — sprint.reminderSnooze + sprint.reminderUnsnooze API actions
 *
 * Tests the snooze/unsnooze lifecycle: set, clear, validate.
 * Data-IO is mocked so these run as pure unit tests with no disk access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CollabTasksData, CollabSprint, CollabTask } from '../../lib/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn().mockImplementation(
    (_path: string, fn: () => Promise<unknown>) => fn()
  ),
}));

vi.mock('@/lib/log-emitter', () => ({
  emitApiEvent: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { reminderSnooze, reminderUnsnooze } from '../../app/api/agent/actions/sprints';
import { update as tasksUpdate, claim as tasksClaim } from '../../app/api/agent/actions/tasks';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSprint(overrides: Partial<CollabSprint> = {}): CollabSprint {
  const now = new Date().toISOString();
  return {
    id: 'sprint-1',
    channelId: 'channel-1',
    name: 'Sprint 61',
    status: 'active',
    createdBy: 'participant-1',
    createdAt: now,
    updatedAt: now,
    sortOrder: 0,
    ...overrides,
  };
}

function makeTasksData(sprints: CollabSprint[]): CollabTasksData {
  return {
    tasks: [],
    sprints,
    phases: [],
    lastUpdated: new Date().toISOString(),
  };
}

function mockAuth() {
  return {
    requestId: 'req-1',
    tokenId: 'tok-1',
    tokenName: 'test',
    scope: 'write' as const,
    createdBy: 'test',
  };
}

function futureIso(minutes = 60): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function snoozeBody(fields: Record<string, unknown>) {
  return { action: 'sprints.reminderSnooze', ...fields };
}

function unsnoozeBody(fields: Record<string, unknown>) {
  return { action: 'sprints.reminderUnsnooze', ...fields };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('sprints.reminderSnooze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readJsonFile).mockResolvedValue(
      makeTasksData([makeSprint()])
    );
  });

  it('sets reminderSnoozeUntil and reminderSnoozeReason on the sprint', async () => {
    const until = futureIso(120);
    const result = await reminderSnooze(
      snoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1', until, reason: 'Waiting on client' }),
      mockAuth()
    );
    expect(result.sprint.reminderSnoozeUntil).toBe(until);
    expect(result.sprint.reminderSnoozeReason).toBe('Waiting on client');
  });

  it('throws 400 when reason is omitted (required for audit trail)', async () => {
    await expect(
      reminderSnooze(
        snoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1', until: futureIso(30) }),
        mockAuth()
      )
    ).rejects.toThrow('reason');
  });

  it('throws 400 when reason is an empty string', async () => {
    await expect(
      reminderSnooze(
        snoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1', until: futureIso(30), reason: '   ' }),
        mockAuth()
      )
    ).rejects.toThrow('reason');
  });

  it('persists the updated sprint to disk', async () => {
    const until = futureIso(60);
    await reminderSnooze(
      snoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1', until, reason: 'Blocked on external review' }),
      mockAuth()
    );
    expect(vi.mocked(writeJsonFile)).toHaveBeenCalledOnce();
    const [, saved] = vi.mocked(writeJsonFile).mock.calls[0] as [string, CollabTasksData];
    const savedSprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(savedSprint?.reminderSnoozeUntil).toBe(until);
  });

  it('throws 400 when sprintId is missing', async () => {
    await expect(
      reminderSnooze(snoozeBody({ channelId: 'channel-1', until: futureIso() }), mockAuth())
    ).rejects.toThrow('sprintId');
  });

  it('throws 400 when channelId is missing', async () => {
    await expect(
      reminderSnooze(snoozeBody({ sprintId: 'sprint-1', until: futureIso() }), mockAuth())
    ).rejects.toThrow('channelId');
  });

  it('throws 400 when until is missing', async () => {
    await expect(
      reminderSnooze(snoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1' }), mockAuth())
    ).rejects.toThrow('until');
  });

  it('throws 400 when until is not a valid ISO timestamp', async () => {
    await expect(
      reminderSnooze(
        snoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1', until: 'not-a-date' }),
        mockAuth()
      )
    ).rejects.toThrow();
  });

  it('throws when sprint is not found in the channel', async () => {
    await expect(
      reminderSnooze(
        snoozeBody({ sprintId: 'no-such-sprint', channelId: 'channel-1', until: futureIso(), reason: 'Blocked' }),
        mockAuth()
      )
    ).rejects.toThrow('not found');
  });

  it('throws when sprint belongs to a different channel', async () => {
    await expect(
      reminderSnooze(
        snoozeBody({ sprintId: 'sprint-1', channelId: 'wrong-channel', until: futureIso(), reason: 'Blocked' }),
        mockAuth()
      )
    ).rejects.toThrow('not found');
  });
});

describe('sprints.reminderUnsnooze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readJsonFile).mockResolvedValue(
      makeTasksData([
        makeSprint({
          reminderSnoozeUntil: futureIso(120),
          reminderSnoozeReason: 'Waiting on approval',
        }),
      ])
    );
  });

  it('clears reminderSnoozeUntil and reminderSnoozeReason', async () => {
    const result = await reminderUnsnooze(
      unsnoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1' }),
      mockAuth()
    );
    expect(result.sprint.reminderSnoozeUntil).toBeUndefined();
    expect(result.sprint.reminderSnoozeReason).toBeUndefined();
  });

  it('persists cleared snooze fields to disk', async () => {
    await reminderUnsnooze(
      unsnoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1' }),
      mockAuth()
    );
    expect(vi.mocked(writeJsonFile)).toHaveBeenCalledOnce();
    const [, saved] = vi.mocked(writeJsonFile).mock.calls[0] as [string, CollabTasksData];
    const savedSprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(savedSprint?.reminderSnoozeUntil).toBeUndefined();
    expect(savedSprint?.reminderSnoozeReason).toBeUndefined();
  });

  it('succeeds (no-op) when sprint is not currently snoozed', async () => {
    vi.mocked(readJsonFile).mockResolvedValue(
      makeTasksData([makeSprint()]) // no snooze fields
    );
    const result = await reminderUnsnooze(
      unsnoozeBody({ sprintId: 'sprint-1', channelId: 'channel-1' }),
      mockAuth()
    );
    expect(result.sprint.reminderSnoozeUntil).toBeUndefined();
  });

  it('throws 400 when sprintId is missing', async () => {
    await expect(
      reminderUnsnooze(unsnoozeBody({ channelId: 'channel-1' }), mockAuth())
    ).rejects.toThrow('sprintId');
  });

  it('throws 400 when channelId is missing', async () => {
    await expect(
      reminderUnsnooze(unsnoozeBody({ sprintId: 'sprint-1' }), mockAuth())
    ).rejects.toThrow('channelId');
  });

  it('throws when sprint is not found', async () => {
    await expect(
      reminderUnsnooze(unsnoozeBody({ sprintId: 'ghost', channelId: 'channel-1' }), mockAuth())
    ).rejects.toThrow('not found');
  });
});

// ─── Auto-clear snooze on task mutation (P5.1) ───────────────────────────────

function makeTask(overrides: Partial<CollabTask> = {}): CollabTask {
  return {
    id: 'task-1',
    channelId: 'channel-1',
    sprintId: 'sprint-1',
    title: 'Task A',
    status: 'todo',
    priority: 'normal',
    sortOrder: 0,
    createdBy: 'participant-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSnoozedTasksData(): CollabTasksData {
  return {
    tasks: [makeTask()],
    sprints: [makeSprint({
      reminderSnoozeUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      reminderSnoozeReason: 'Waiting on client',
    })],
    phases: [],
    lastUpdated: new Date().toISOString(),
  };
}

describe('snooze auto-clear on task mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readJsonFile).mockImplementation(async (filePath) => {
      if (String(filePath).includes('collab-channels')) {
        return {
          channels: [{
            id: 'channel-1',
            participants: [{ id: 'participant-1' }],
          }],
        } as never;
      }
      return makeSnoozedTasksData() as never;
    });
  });

  it('clears snooze fields when tasks.update is called for a task in the snoozed sprint', async () => {
    await tasksUpdate(
      { action: 'tasks.update', channelId: 'channel-1', taskId: 'task-1', participantId: 'participant-1', title: 'Updated title' },
      mockAuth()
    );
    expect(vi.mocked(writeJsonFile)).toHaveBeenCalledOnce();
    const [, saved] = vi.mocked(writeJsonFile).mock.calls[0] as [string, CollabTasksData];
    const sprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(sprint?.reminderSnoozeUntil).toBeUndefined();
    expect(sprint?.reminderSnoozeReason).toBeUndefined();
  });

  it('clears snooze fields when tasks.claim is called for a task in the snoozed sprint', async () => {
    await tasksClaim(
      { action: 'tasks.claim', channelId: 'channel-1', taskId: 'task-1', participantId: 'participant-1' },
      mockAuth()
    );
    expect(vi.mocked(writeJsonFile)).toHaveBeenCalledOnce();
    const [, saved] = vi.mocked(writeJsonFile).mock.calls[0] as [string, CollabTasksData];
    const sprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(sprint?.reminderSnoozeUntil).toBeUndefined();
    expect(sprint?.reminderSnoozeReason).toBeUndefined();
  });

  it('does not clear snooze when task has no sprintId', async () => {
    vi.mocked(readJsonFile).mockImplementation(async (filePath) => {
      if (String(filePath).includes('collab-channels')) {
        return {
          channels: [{
            id: 'channel-1',
            participants: [{ id: 'participant-1' }],
          }],
        } as never;
      }
      return {
        ...makeSnoozedTasksData(),
        tasks: [makeTask({ sprintId: undefined })],
      } as never;
    });
    await tasksUpdate(
      { action: 'tasks.update', channelId: 'channel-1', taskId: 'task-1', participantId: 'participant-1', title: 'No sprint' },
      mockAuth()
    );
    const [, saved] = vi.mocked(writeJsonFile).mock.calls[0] as [string, CollabTasksData];
    const sprint = saved.sprints?.find(s => s.id === 'sprint-1');
    // Snooze intact — task had no sprintId
    expect(sprint?.reminderSnoozeUntil).toBeDefined();
  });
});
