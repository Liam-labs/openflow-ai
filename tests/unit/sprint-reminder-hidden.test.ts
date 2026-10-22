/**
 * P3.1 TDD — hidden message format for stall reminders
 *
 * Verifies the stored CollabMessage has the correct shape:
 *   - from.id === 'system'
 *   - metadata.isHidden === true
 *   - content matches the locked template
 *   - @mention of recipient is present
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CollabChannelsData,
  CollabTasksData,
  CollabSprint,
  CollabChannel,
  CollabParticipant,
  CollabMessage,
  CollabTask,
} from '@/lib/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockAppendMessage } = vi.hoisted(() => ({
  mockAppendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn().mockResolvedValue({ tasks: [], sprints: [], phases: [], lastUpdated: '' }),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
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

import { runReminderTick, buildReminderContent } from '../../lib/sprint-reminder-tick';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minsAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
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

function makeTasksData(sprints: CollabSprint[], tasks: CollabTask[] = []): CollabTasksData {
  return { tasks, sprints, phases: [], lastUpdated: new Date().toISOString() };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildReminderContent', () => {
  it('includes @mention of recipient name', () => {
    const sprint = makeSprint();
    const recipient = makeParticipant({ name: 'Jack' });
    const now = new Date();
    const lastActivityMs = now.getTime() - 25 * 60_000;

    const content = buildReminderContent(sprint, [], recipient, lastActivityMs, now);

    expect(content).toContain('@Jack');
  });

  it('includes sprint name', () => {
    const sprint = makeSprint({ name: 'Sprint 61: Stall Reminders' });
    const recipient = makeParticipant();
    const now = new Date();
    const lastActivityMs = now.getTime() - 25 * 60_000;

    const content = buildReminderContent(sprint, [], recipient, lastActivityMs, now);

    expect(content).toContain('Sprint 61: Stall Reminders');
  });

  it('includes idle minutes (rounded down)', () => {
    const sprint = makeSprint();
    const recipient = makeParticipant();
    const now = new Date();
    const lastActivityMs = now.getTime() - 27.7 * 60_000; // 27.7 min → floors to 27

    const content = buildReminderContent(sprint, [], recipient, lastActivityMs, now);

    expect(content).toContain('27 minutes');
  });

  it('includes task counts', () => {
    const sprint = makeSprint();
    const recipient = makeParticipant();
    const now = new Date();
    const lastActivityMs = now.getTime() - 25 * 60_000;
    const tasks: CollabTask[] = [
      { id: 't-1', channelId: 'ch-1', sprintId: 'sprint-1', title: 'T1', status: 'in_progress', priority: 'normal', sortOrder: 0, createdBy: 'p-1', createdAt: minsAgo(60), updatedAt: minsAgo(30) },
      { id: 't-2', channelId: 'ch-1', sprintId: 'sprint-1', title: 'T2', status: 'done', priority: 'normal', sortOrder: 1, createdBy: 'p-1', createdAt: minsAgo(60), updatedAt: minsAgo(10) },
      { id: 't-3', channelId: 'ch-1', sprintId: 'sprint-1', title: 'T3', status: 'todo', priority: 'normal', sortOrder: 2, createdBy: 'p-1', createdAt: minsAgo(60), updatedAt: minsAgo(60) },
    ];

    const content = buildReminderContent(sprint, tasks, recipient, lastActivityMs, now);

    expect(content).toContain('3 tasks total');
    expect(content).toContain('1 in_progress');
  });

  it('includes call to action (sprint.reminderSnooze reference)', () => {
    const sprint = makeSprint();
    const recipient = makeParticipant();
    const now = new Date();
    const lastActivityMs = now.getTime() - 25 * 60_000;

    const content = buildReminderContent(sprint, [], recipient, lastActivityMs, now);

    expect(content).toContain('sprint.reminderSnooze');
  });
});

describe('runReminderTick — hidden message shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores message with metadata.isHidden === true', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.metadata?.isHidden).toBe(true);
  });

  it('stores message with from.id === "system"', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.from.id).toBe('system');
  });

  it('stores message with from.name === "DevFlow"', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.from.name).toBe('DevFlow');
  });

  it('stores message content with @mention of team lead', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.content).toContain('@Jack');
  });

  it('stores message content with sprint name', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint({ name: 'Sprint 61' })]);

    await runReminderTick(channelsData, tasksData, new Date());

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.content).toContain('Sprint 61');
  });

  it('message has channelId set correctly', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.channelId).toBe('ch-1');
  });

  it('message has mentions array containing recipient id', async () => {
    const channelsData = makeChannelsData([makeChannel()]);
    const tasksData = makeTasksData([makeSprint()]);

    await runReminderTick(channelsData, tasksData, new Date());

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.mentions).toBeDefined();
    expect(storedMsg.mentions).toContain('p-tl');
  });
});
