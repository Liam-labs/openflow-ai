/**
 * Sprint 39 T2.1: handleHeartbeat stores activityDetail on participant
 * and includes it in the collab:typing SSE event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleHeartbeat } from '@/app/api/collab/_handlers/settings';
import { eventBus } from '@/lib/event-bus';
import type { CollabChannelsData, CollabParticipant } from '@/lib/types';

// Mock writeData — settings.ts imports it from _collab-shared
vi.mock('@/app/api/collab/_collab-shared', () => ({
  writeData: vi.fn().mockResolvedValue(undefined),
  invalidateUnreadCache: vi.fn(),
}));

function makeParticipant(overrides: Partial<CollabParticipant> = {}): CollabParticipant {
  return {
    id: 'p-1',
    type: 'claude-terminal',
    name: 'Builder',
    source: 'WSL',
    joinedAt: '2026-04-12T10:00:00Z',
    lastSeen: '2026-04-12T10:00:00Z',
    ...overrides,
  };
}

function makeData(participants: CollabParticipant[] = [makeParticipant()]): CollabChannelsData {
  return {
    channels: [{
      id: 'ch-1',
      name: 'Test Channel',
      participants,
      lastActivity: '2026-04-12T10:00:00Z',
      createdAt: '2026-04-12T10:00:00Z',
    }],
  } as CollabChannelsData;
}

describe('handleHeartbeat — activityDetail', () => {
  let emittedEvents: Array<{ type: string; payload: unknown }> = [];

  beforeEach(() => {
    emittedEvents = [];
    eventBus.emitEvent = vi.fn<typeof eventBus.emitEvent>((type, payload) => {
      emittedEvents.push({ type, payload });
      return { id: 'test', type, data: payload, timestamp: new Date().toISOString() };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores activityDetail on participant when present in heartbeat', async () => {
    const data = makeData();
    const res = await handleHeartbeat(data, {
      action: 'heartbeat',
      channelId: 'ch-1',
      participantId: 'p-1',
      activityStatus: 'working',
      activityDetail: 'Reading file...',
    }, '2026-04-12T10:01:00Z');

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(data.channels[0].participants[0].activityDetail).toBe('Reading file...');
  });

  it('includes activityDetail in collab:typing SSE event', async () => {
    const data = makeData();
    await handleHeartbeat(data, {
      action: 'heartbeat',
      channelId: 'ch-1',
      participantId: 'p-1',
      activityStatus: 'working',
      activityDetail: 'Editing file...',
    }, '2026-04-12T10:01:00Z');

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].type).toBe('collab:typing');
    const payload = emittedEvents[0].payload as Record<string, unknown>;
    expect(payload.activityDetail).toBe('Editing file...');
    expect(payload.activityStatus).toBe('working');
    expect(payload.participantId).toBe('p-1');
  });

  it('sets activityDetail to null when not provided (backward compat)', async () => {
    const data = makeData();
    await handleHeartbeat(data, {
      action: 'heartbeat',
      channelId: 'ch-1',
      participantId: 'p-1',
      activityStatus: 'working',
    }, '2026-04-12T10:01:00Z');

    expect(data.channels[0].participants[0].activityDetail).toBeNull();
    const payload = emittedEvents[0].payload as Record<string, unknown>;
    expect(payload.activityDetail).toBeNull();
  });

  it('clears activityDetail when agent goes idle', async () => {
    const participant = makeParticipant({ activityDetail: 'Thinking...' });
    const data = makeData([participant]);

    await handleHeartbeat(data, {
      action: 'heartbeat',
      channelId: 'ch-1',
      participantId: 'p-1',
      activityStatus: 'idle',
    }, '2026-04-12T10:02:00Z');

    expect(data.channels[0].participants[0].activityDetail).toBeNull();
    const payload = emittedEvents[0].payload as Record<string, unknown>;
    expect(payload.activityDetail).toBeNull();
  });

  it('updates activityDetail on each heartbeat', async () => {
    const data = makeData();

    // First: Reading
    await handleHeartbeat(data, {
      action: 'heartbeat',
      channelId: 'ch-1',
      participantId: 'p-1',
      activityStatus: 'working',
      activityDetail: 'Reading file...',
    }, '2026-04-12T10:01:00Z');
    expect(data.channels[0].participants[0].activityDetail).toBe('Reading file...');

    // Second: Editing
    await handleHeartbeat(data, {
      action: 'heartbeat',
      channelId: 'ch-1',
      participantId: 'p-1',
      activityStatus: 'working',
      activityDetail: 'Editing file...',
    }, '2026-04-12T10:01:05Z');
    expect(data.channels[0].participants[0].activityDetail).toBe('Editing file...');
  });

  it('preserves all existing SSE event fields', async () => {
    const data = makeData();
    await handleHeartbeat(data, {
      action: 'heartbeat',
      channelId: 'ch-1',
      participantId: 'p-1',
      activityStatus: 'working',
      activityDetail: 'Searching...',
    }, '2026-04-12T10:01:00Z');

    const payload = emittedEvents[0].payload as Record<string, unknown>;
    expect(payload.channelId).toBe('ch-1');
    expect(payload.participantId).toBe('p-1');
    expect(payload.participantName).toBe('Builder');
    expect(payload.activityStatus).toBe('working');
    expect(payload.activityDetail).toBe('Searching...');
    expect(payload.activityUpdatedAt).toBe('2026-04-12T10:01:00Z');
  });
});
