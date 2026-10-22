import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabChannel, CollabChannelsData, CollabMessage, CollabParticipant } from '@/lib/types';

const mocks = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock('@/app/api/collab/_collab-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/collab/_collab-shared')>();
  return { ...actual, writeData: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('@/lib/collab-message-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/collab-message-io')>();
  return {
    ...actual,
    readChannelMessages: vi.fn(async () => ({ messages: mocks.messages })),
    appendChannelMessages: vi.fn().mockResolvedValue(undefined),
    getMessagesPaginated: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  };
});

import { computeUnreadCounts } from '@/app/api/collab/_collab-shared';
import { handleMarkRead } from '@/app/api/collab/_handlers/settings';
import { handleJoin } from '@/app/api/collab/_handlers/lifecycle';
import {
  dedupeAllChannelParticipants,
  dedupeParticipants,
  mergeParticipantRecords,
} from '@/lib/collab-participants';

const PETE = 'user-owner-doe';

function peteRecord(over: Partial<CollabParticipant>): CollabParticipant {
  return {
    id: PETE,
    type: 'user',
    name: 'Owner',
    source: 'DevFlow Browser',
    joinedAt: '2026-10-13T12:53:40.992Z',
    lastSeen: '2026-10-14T09:00:00.000Z',
    ...over,
  };
}

/** The live shape: the channel creator's record plus a later join with the same id. */
function duplicatePete(): CollabParticipant[] {
  return [
    peteRecord({ lastRead: '2026-10-14T07:38:09.418Z', color: '#10B981', status: 'online' }),
    peteRecord({
      source: 'DevFlow',
      joinedAt: '2026-10-13T13:08:34.313Z',
      lastSeen: '2026-10-13T13:08:34.332Z',
      color: '#8B5CF6',
      status: 'offline',
    }),
  ];
}

function message(id: number, timestamp: string): CollabMessage {
  return {
    id: `m${id}`,
    channelId: 'c1',
    from: { id: 'agent-1', type: 'claude', name: 'Agent', source: 'WSL', joinedAt: timestamp, lastSeen: timestamp },
    content: `message ${id}`,
    timestamp,
  };
}

function makeData(participants: CollabParticipant[]): CollabChannelsData {
  const channel: CollabChannel = {
    id: 'c1',
    name: 'Test',
    createdAt: '2026-10-13T12:53:40.992Z',
    lastActivity: '2026-10-13T12:53:40.992Z',
    participants,
    messages: [],
    settings: { autoRespond: false },
  };
  return { channels: [channel], lastUpdated: '2026-10-14T09:00:00.000Z' };
}

describe('dedupeParticipants', () => {
  it('leaves a channel without duplicates untouched', () => {
    const channel = makeData([peteRecord({}), { ...peteRecord({}), id: 'other' }]).channels[0];
    const before = channel.participants;
    expect(dedupeParticipants(channel)).toBe(0);
    expect(channel.participants).toBe(before);
  });

  it('merges same-id records: latest lastRead and lastSeen, earliest joinedAt', () => {
    const channel = makeData(duplicatePete()).channels[0];
    expect(dedupeParticipants(channel)).toBe(1);
    expect(channel.participants).toHaveLength(1);
    const [merged] = channel.participants;
    expect(merged.lastRead).toBe('2026-10-14T07:38:09.418Z');
    expect(merged.lastSeen).toBe('2026-10-14T09:00:00.000Z');
    expect(merged.joinedAt).toBe('2026-10-13T12:53:40.992Z');
    expect(merged.color).toBe('#10B981');
  });

  it('keeps the first position and the first record object', () => {
    const first = peteRecord({ lastRead: '2026-10-14T07:00:00Z' });
    const other = { ...peteRecord({}), id: 'other' };
    const channel = makeData([first, other, peteRecord({ lastRead: '2026-10-14T08:00:00Z' })]).channels[0];
    dedupeParticipants(channel);
    expect(channel.participants.map(p => p.id)).toEqual([PETE, 'other']);
    expect(channel.participants[0]).toBe(first);
    expect(first.lastRead).toBe('2026-10-14T08:00:00Z');
  });

  it('fills fields missing from the preferred record and keeps away status', () => {
    const merged = mergeParticipantRecords(
      peteRecord({ lastSeen: '2026-10-14T09:00:00Z' }),
      peteRecord({ lastSeen: '2026-10-14T08:00:00Z', color: '#123456', status: 'away', projectPath: '/p' }),
    );
    expect(merged.color).toBe('#123456');
    expect(merged.projectPath).toBe('/p');
    expect(merged.status).toBe('away');
  });

  it('dedupes every channel in a data file', () => {
    const data = makeData(duplicatePete());
    data.channels.push({ ...makeData(duplicatePete()).channels[0], id: 'c2' });
    expect(dedupeAllChannelParticipants(data)).toBe(2);
    expect(data.channels.every(c => c.participants.length === 1)).toBe(true);
  });
});

describe('mark_read with a duplicate participant id', () => {
  beforeEach(() => {
    mocks.messages = [
      message(1, '2026-10-14T07:00:00.000Z'),
      message(2, '2026-10-14T08:00:00.000Z'),
      message(3, '2026-10-14T09:00:00.000Z'),
    ];
  });

  it('shows 0 unread after reading, and the count stays 0 on later refreshes', async () => {
    const data = makeData(duplicatePete());
    const channel = data.channels[0];
    const msgs = mocks.messages as CollabMessage[];

    // Without the fix the second record (lastRead null, counted from joinedAt) wins.
    computeUnreadCounts(channel, msgs);
    expect(channel.participants.filter(p => p.id === PETE)).toHaveLength(2);

    const response = await handleMarkRead(data, {
      action: 'mark_read',
      channelId: 'c1',
      participantId: PETE,
    }, '2026-10-14T09:30:00.000Z');
    expect(response.status).toBe(200);

    expect(channel.participants.filter(p => p.id === PETE)).toHaveLength(1);
    computeUnreadCounts(channel, msgs);
    expect(channel.participants[0].unreadCount).toBe(0);

    // A new message arrives later: only that message is unread, not the whole backlog.
    const later = [...msgs, message(4, '2026-10-14T10:00:00.000Z')];
    computeUnreadCounts(channel, later);
    expect(channel.participants[0].unreadCount).toBe(1);
  });
});

describe('join with an id that already exists', () => {
  it('updates the existing record instead of adding a duplicate', async () => {
    const data = makeData([peteRecord({ lastRead: '2026-10-14T07:38:09.418Z' })]);
    const response = await handleJoin(data, {
      action: 'join',
      channelId: 'c1',
      participant: { id: PETE, name: 'Owner', type: 'user', source: 'DevFlow' },
    }, '2026-10-14T09:10:00.000Z');
    expect(response.status).toBe(200);
    const records = data.channels[0].participants.filter(p => p.id === PETE);
    expect(records).toHaveLength(1);
    expect(records[0].lastRead).toBe('2026-10-14T07:38:09.418Z');
  });

  it('merges a legacy browser-user record into the canonical record it is upgraded to', async () => {
    const legacy = peteRecord({ id: 'browser-user-abc', lastRead: '2026-10-14T07:38:09.418Z' });
    const canonical = peteRecord({
      source: 'DevFlow',
      joinedAt: '2026-10-13T13:08:34.313Z',
      lastSeen: '2026-10-13T13:08:34.332Z',
    });
    const data = makeData([legacy, canonical]);
    const response = await handleJoin(data, {
      action: 'join',
      channelId: 'c1',
      participant: { id: PETE, name: 'Owner', type: 'user', source: 'DevFlow Browser' },
    }, '2026-10-14T09:10:00.000Z', {
      email: 'owner@example.com',
      canonicalParticipantId: PETE,
      canonicalName: 'Owner',
    });
    expect(response.status).toBe(200);
    const records = data.channels[0].participants.filter(p => p.id === PETE);
    expect(records).toHaveLength(1);
    expect(data.channels[0].participants.some(p => p.id === 'browser-user-abc')).toBe(false);
    expect(records[0].lastRead).toBe('2026-10-14T07:38:09.418Z');
  });
});
