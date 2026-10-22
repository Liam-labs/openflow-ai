/**
 * P5.1 TDD — dedup window + hold-until-online invariant
 *
 * Two behaviours:
 *   1. No second reminder within the 20-min dedup window
 *   2. lastReminderSentAt is NOT written when no recipient is found (hold-until-online)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CollabChannelsData,
  CollabTasksData,
  CollabSprint,
  CollabChannel,
  CollabParticipant,
} from '@/lib/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockWriteJsonFile, mockAppendMessage } = vi.hoisted(() => ({
  mockWriteJsonFile: vi.fn().mockResolvedValue(undefined),
  mockAppendMessage: vi.fn().mockResolvedValue(undefined),
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
  eventBus: { emitEvent: vi.fn() },
}));

vi.mock('@/lib/collab-delivery', () => ({
  deliverMessage: vi.fn(),
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
    updatedAt: minsAgo(25),
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
    lastSeen: minsAgo(2),
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

function makeTasksData(sprints: CollabSprint[]): CollabTasksData {
  return { tasks: [], sprints, phases: [], lastUpdated: new Date().toISOString() };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runReminderTick — dedup guard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not fire when a reminder was sent within the 20-min dedup window', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({ lastReminderSentAt: minsAgo(15) })]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('fires when last reminder was sent more than 20 min ago', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({ lastReminderSentAt: minsAgo(25) })]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(1);
    expect(mockAppendMessage).toHaveBeenCalledOnce();
  });

  it('does not fire when snooze is active (future until)', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({
      reminderSnoozeUntil: minsFromNow(60),
      reminderSnoozeReason: 'Waiting on review',
    })]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    expect(result.fired).toBe(0);
  });
});

describe('runReminderTick — hold-until-online invariant', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does NOT write lastReminderSentAt when no online recipient found', async () => {
    const offlineParticipant = makeParticipant({ lastSeen: minsAgo(15) }); // offline
    const channelsData = makeChannelsData([
      makeChannel({ participants: [offlineParticipant], teamLeadId: undefined }),
    ]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    // No message posted
    expect(mockAppendMessage).not.toHaveBeenCalled();

    // No disk write — sprint state must not be mutated
    expect(mockWriteJsonFile).not.toHaveBeenCalled();

    // In-memory sprint is also untouched
    const sprint = tasksData.sprints![0];
    expect(sprint.lastReminderSentAt).toBeUndefined();
    expect(sprint.reminderCount).toBeUndefined();
  });

  it('writes lastReminderSentAt only when a message is actually sent', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    expect(mockWriteJsonFile).toHaveBeenCalledOnce();
    const [, saved] = mockWriteJsonFile.mock.calls[0] as [string, CollabTasksData];
    const sprint = saved.sprints?.find(s => s.id === 'sprint-1');
    expect(sprint?.lastReminderSentAt).toBeDefined();
  });
});
