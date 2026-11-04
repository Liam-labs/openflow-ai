/**
 * When the first agent joins a channel with no team lead, it is told it is the lead. That is an instruction for the agent,
 * so it is delivered to the agent but kept out of the person's chat feed (fresh-user test, 4 Nov: it showed above Jack's opening).
 */
import { describe, it, expect, vi } from 'vitest';
import type { CollabChannelsData, CollabChannelActionRequest } from '@/lib/types';

vi.mock('@/lib/collab-channel-store', () => ({ saveChannels: vi.fn(async () => undefined) }));
// The message store is replaced by memory, so the test never touches real channel files.
const store = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock('@/lib/collab-message-io', async (orig) => ({
  ...(await orig<object>()),
  appendMessages: vi.fn(async (_id: string, msgs: unknown[]) => { store.messages.push(...msgs); }),
  getMessagesPaginated: vi.fn(async () => ({ messages: store.messages, hasMore: false, oldestTimestamp: undefined })),
}));

import { handleJoin } from '@/app/api/collab/_handlers/lifecycle';

describe('team lead appointment message', () => {
  it('is hidden from the feed but still addressed to the new lead', async () => {
    const now = '2026-11-04T10:00:00.000Z';
    const data = { channels: [{ id: 'c1', name: 'Setup', description: '', participants: [], messages: [], createdAt: now, lastActivity: now, settings: {} }] } as unknown as CollabChannelsData;
    const body = { action: 'join', channelId: 'c1', participant: { id: 'agent-1', type: 'claude-terminal', name: 'Jack', source: 'wrapper' } } as unknown as CollabChannelActionRequest;
    const res = await handleJoin(data, body, now);
    expect((await res.json()).success).toBe(true);
    const ch = data.channels[0] as unknown as { teamLeadId?: string; messages: { content: string; recipients?: string[]; metadata?: { isHidden?: boolean; deliveryMode?: string } }[] };
    expect(ch.teamLeadId).toBe('agent-1');
    const lead = ch.messages.find((m) => m.content.startsWith('You are the Team Lead'));
    expect(lead).toBeTruthy();
    expect(lead!.metadata).toMatchObject({ isHidden: true, deliveryMode: 'targeted' });
    expect(lead!.recipients).toEqual(['agent-1']);
  });
});
