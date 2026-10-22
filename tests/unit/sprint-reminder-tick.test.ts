/**
 * P3.1 TDD — runReminderTick (tick engine)
 *
 * Tests the core tick loop: which sprints get reminders, when they're held,
 * and that sprint state (lastReminderSentAt, reminderCount) is updated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CollabChannelsData,
  CollabTasksData,
  CollabSprint,
  CollabChannel,
  CollabPhase,
  CollabTask,
  CollabParticipant,
  CollabMessage,
} from '@/lib/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockWriteJsonFile, mockAppendMessage, mockEmitEvent, mockDeliverMessage } = vi.hoisted(() => ({
  mockWriteJsonFile: vi.fn().mockResolvedValue(undefined),
  mockAppendMessage: vi.fn().mockResolvedValue(undefined),
  mockEmitEvent: vi.fn(),
  mockDeliverMessage: vi.fn(),
}));

vi.mock('@/lib/data-io', () => ({
  // The tick re-reads the task store under the lock; default to the data it was given.
  readJsonFile: vi.fn((_path: string, fallback: unknown) => Promise.resolve(structuredClone(fallback))),
  writeJsonFile: mockWriteJsonFile,
  withFileLock: vi.fn().mockImplementation(
    (_path: string, fn: () => Promise<unknown>) => fn()
  ),
}));

vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: mockAppendMessage,
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: { emitEvent: mockEmitEvent },
}));

vi.mock('@/lib/collab-delivery', () => ({
  deliverMessage: mockDeliverMessage,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { runReminderTick } from '../../lib/sprint-reminder-tick';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minsAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

function minsFromNow(n: number): string {
  return new Date(Date.now() + n * 60_000).toISOString();
}

function makeSprint(overrides: Partial<CollabSprint> = {}): CollabSprint {
  return {
    id: 'sprint-1',
    channelId: 'ch-1',
    name: 'Sprint 61',
    status: 'active',
    createdBy: 'p-1',
    createdAt: minsAgo(120),
    updatedAt: minsAgo(25), // stale — 25 min ago
    sortOrder: 0,
    ...overrides,
  };
}

function makeParticipant(overrides: Partial<CollabParticipant> = {}): CollabParticipant {
  return {
    id: 'p-tl',
    type: 'claude',
    name: 'Jack',
    source: 'WSL',
    joinedAt: minsAgo(120),
    lastSeen: minsAgo(2), // online
    ...overrides,
  };
}

function makeChannel(overrides: Partial<CollabChannel> = {}): CollabChannel {
  return {
    id: 'ch-1',
    name: 'SG-1',
    createdAt: minsAgo(120),
    lastActivity: minsAgo(25),
    participants: [makeParticipant()],
    messages: [],
    settings: { autoRespond: false },
    teamLeadId: 'p-tl',
    ...overrides,
  };
}

function makeChannelsData(channels: CollabChannel[]): CollabChannelsData {
  return { channels, lastUpdated: new Date().toISOString() };
}

function makeTasksData(
  sprints: CollabSprint[],
  phases: CollabPhase[] = [],
  tasks: CollabTask[] = [],
): CollabTasksData {
  return {
    tasks,
    sprints,
    phases,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runReminderTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires reminder for stale active sprint with online recipient', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].sprintId).toBe('sprint-1');
    expect(result.results[0].recipientId).toBe('p-tl');
  });

  it('appends a message to the channel', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    expect(mockAppendMessage).toHaveBeenCalledOnce();
    expect(mockAppendMessage.mock.calls[0][0]).toBe('ch-1');
  });

  it('emits collab:message SSE event', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    expect(mockEmitEvent).toHaveBeenCalledWith('collab:message', expect.objectContaining({
      channelId: 'ch-1',
    }));
  });

  it('calls deliverMessage for recipient routing', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    expect(mockDeliverMessage).toHaveBeenCalledOnce();
  });

  it('sets sprint.lastReminderSentAt after firing', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const [, saved] = mockWriteJsonFile.mock.calls[0] as [string, CollabTasksData];
    const sprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(sprint?.lastReminderSentAt).toBeDefined();
  });

  it('keeps task changes made while the reminder was being sent', async () => {
    const task = { id: 't-1', channelId: 'ch-1', title: 'Card', status: 'in_progress', priority: 'normal',
      createdBy: 'p-1', createdAt: minsAgo(60), updatedAt: minsAgo(30), sprintId: 'sprint-1' } as CollabTask;
    const tasksData = makeTasksData([makeSprint()], [], [task]);
    // Meanwhile (between the tick's read and its write) the card was completed with a receipt.
    const { readJsonFile } = await import('@/lib/data-io');
    vi.mocked(readJsonFile).mockImplementationOnce(async () => ({
      ...structuredClone(tasksData),
      tasks: [{ ...task, status: 'done', updatedAt: minsAgo(0) }],
      completionReceipts: { r: { taskId: 't-1' } },
    }) as never);

    await runReminderTick(makeChannelsData([makeChannel()]), tasksData, new Date());

    const [, saved] = mockWriteJsonFile.mock.calls[0] as [string, CollabTasksData];
    expect(saved.tasks[0].status).toBe('done');
    expect(saved.completionReceipts).toBeDefined();
    expect(saved.sprints?.[0].reminderCount).toBe(1);
  });

  it('increments reminderCount after firing (undefined → 1)', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const [, saved] = mockWriteJsonFile.mock.calls[0] as [string, CollabTasksData];
    const sprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(sprint?.reminderCount).toBe(1);
  });

  it('increments reminderCount from existing value', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({ reminderCount: 3 })]);

    await runReminderTick(channelsData, tasksData, new Date());

    const [, saved] = mockWriteJsonFile.mock.calls[0] as [string, CollabTasksData];
    const sprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(sprint?.reminderCount).toBe(4);
  });

  it('does not fire when sprint status is not active', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({ status: 'completed' })]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('does not fire when snooze is active', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({
      reminderSnoozeUntil: minsFromNow(60),
      reminderSnoozeReason: 'Waiting on review',
    })]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('does not fire when sprint was updated recently (task activity)', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const recentTask: CollabTask = {
      id: 't-1',
      channelId: 'ch-1',
      sprintId: 'sprint-1',
      title: 'Active task',
      status: 'in_progress',
      priority: 'normal',
      sortOrder: 0,
      createdBy: 'p-tl',
      createdAt: minsAgo(60),
      updatedAt: minsAgo(5), // touched 5 min ago
    };
    const tasksData = makeTasksData([makeSprint({ updatedAt: minsAgo(25) })], [], [recentTask]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('does not fire when last reminder was sent too recently', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({
      lastReminderSentAt: minsAgo(10), // sent 10 min ago — dedup guard
    })]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('holds reminder (no fire) when no online recipient', async () => {
    const offlineParticipant = makeParticipant({ lastSeen: minsAgo(15) }); // offline
    const channelsData = makeChannelsData([makeChannel({ participants: [offlineParticipant], teamLeadId: 'p-tl' })]);
    const tasksData = makeTasksData([makeSprint()]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('skips channels with no active sprints', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([]); // no sprints

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('handles multiple channels independently', async () => {
    const ch2: CollabChannel = {
      ...makeChannel(),
      id: 'ch-2',
      name: 'SG-2',
      teamLeadId: 'p-tl-2',
      participants: [makeParticipant({ id: 'p-tl-2', name: 'Carter' })],
    };
    const channelsData = makeChannelsData([makeChannel(), ch2]);
    const tasksData = makeTasksData([
      makeSprint(),
      { ...makeSprint(), id: 'sprint-2', channelId: 'ch-2' },
    ]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(2);
    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not fire for sprint in a different channel than the channel being processed', async () => {
    const channelsData = makeChannelsData([makeChannel()]); // only ch-1
    const tasksData = makeTasksData([
      makeSprint(), // ch-1 — should fire
      { ...makeSprint(), id: 'sprint-orphan', channelId: 'ch-999' }, // ch-999 — no channel data
    ]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(1);
  });
});
