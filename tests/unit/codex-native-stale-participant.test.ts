import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollabChannelsData, CollabParticipant } from '@/lib/types';
import {
  CODEX_NATIVE_PARTICIPANT_SOURCE,
  selectStaleParticipantsForCleanup,
} from '@/lib/collab-participant-cleanup';

const { appendMessages } = vi.hoisted(() => ({
  appendMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/collab-message-io', () => ({ appendMessages }));

const { cleanupStaleParticipants } = await import('@/app/api/collab/_collab-shared');

function participant(overrides: Partial<CollabParticipant> = {}): CollabParticipant {
  return {
    id: 'participant-1',
    type: 'codex',
    name: 'Codex Native',
    source: CODEX_NATIVE_PARTICIPANT_SOURCE,
    joinedAt: '2026-08-13T08:00:00.000Z',
    lastSeen: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

function channelsData(...participants: CollabParticipant[]): CollabChannelsData {
  return {
    channels: [{
      id: 'channel-1',
      name: 'Drone Hub',
      projectPath: '/home/user/Drone-Hub',
      participants,
      messages: [],
      settings: { autoRespond: false },
      createdAt: '2026-08-13T08:00:00.000Z',
      lastActivity: '2026-08-13T08:00:00.000Z',
    }],
    lastUpdated: '2026-08-13T08:00:00.000Z',
  };
}

describe('Codex Native stale participant cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    appendMessages.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it('keeps an idle Codex Desktop bridge participant connected indefinitely', async () => {
    const data = channelsData(participant());

    const removed = await cleanupStaleParticipants(data);

    expect(removed).toBe(0);
    expect(data.channels[0].participants).toHaveLength(1);
    expect(data.channels[0].participants[0].source).toBe(CODEX_NATIVE_PARTICIPANT_SOURCE);
    expect(appendMessages).not.toHaveBeenCalled();
  });

  it('keeps the canonical bridge out of the browser 10-minute cleanup', () => {
    const canonicalBridge = participant();
    const stale = selectStaleParticipantsForCleanup({
      participants: [canonicalBridge],
      rosterAgents: [],
      protectedParticipantIds: ['browser-user'],
      nowMs: Date.now(),
      staleAfterMs: 10 * 60 * 1000,
    });

    expect(stale).toEqual([]);
  });

  it('does not make every Codex participant durable in browser cleanup', () => {
    const ordinaryCodex = participant({
      id: 'ordinary-codex',
      name: 'Ordinary Codex',
      source: 'AgentChat',
    });
    const stale = selectStaleParticipantsForCleanup({
      participants: [ordinaryCodex],
      rosterAgents: [],
      protectedParticipantIds: ['browser-user'],
      nowMs: Date.now(),
      staleAfterMs: 10 * 60 * 1000,
    });

    expect(stale.map((item) => item.id)).toEqual(['ordinary-codex']);
  });

  it('still removes an unrelated stale non-roster Codex agent', async () => {
    const data = channelsData(participant({
      id: 'ordinary-codex',
      name: 'Ordinary Codex',
      source: 'AgentChat',
    }));

    const removed = await cleanupStaleParticipants(data);

    expect(removed).toBe(1);
    expect(data.channels[0].participants).toHaveLength(0);
    expect(appendMessages).toHaveBeenCalledOnce();
  });
});
