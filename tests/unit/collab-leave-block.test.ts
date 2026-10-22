import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/data-io', () => ({ readJsonFile: vi.fn(), writeJsonFile: vi.fn() }));
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: vi.fn() }, emitCollabError: vi.fn() }));
vi.mock('@/lib/collab-message-io', () => ({
  getMessagesPaginated: vi.fn(), appendMessages: vi.fn(), deleteChannelMessages: vi.fn(),
}));
vi.mock('@/teams-integration/lib/teams-auto-sync', () => ({ onChannelCreated: vi.fn(), onChannelDeleted: vi.fn() }));
vi.mock('@/slack-integration/lib/slack-auto-sync', () => ({ onChannelCreated: vi.fn(), onChannelDeleted: vi.fn() }));
vi.mock('@/lib/channels-registry', () => ({
  onChannelCreated: vi.fn(), onChannelArchived: vi.fn(), onChannelRestored: vi.fn(), onChannelDeleted: vi.fn(),
}));
vi.mock('@/lib/frozen-detection-jsonl', () => ({ enrichParticipantsJsonlMtime: vi.fn() }));
vi.mock('@/app/api/collab/_collab-shared', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeData: vi.fn(),
}));

import { handleLeave } from '@/app/api/collab/_handlers/lifecycle';
import type { CollabChannelsData } from '@/lib/types';

function data(): CollabChannelsData {
  return {
    lastUpdated: '',
    channels: [{
      id: 'seo', name: 'SEO Engine', createdAt: '', lastActivity: '', messages: [],
      settings: { autoRespond: false },
      participants: [{ id: 'svc-1', name: 'Engine Report Review', type: 'agent', joinedAt: '', lastSeen: '' }],
      roster: { lastUpdated: '', agents: [] },
    }],
  } as unknown as CollabChannelsData;
}

describe('handleLeave blocking', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes an idle service poster without blocking when block is false', async () => {
    const d = data();
    const res = await handleLeave(d, { action: 'leave', channelId: 'seo', participantId: 'svc-1', block: false }, 'now');
    expect(res.status).toBe(200);
    expect(d.channels[0].participants).toHaveLength(0);
    expect(d.channels[0].blockedParticipantIds ?? []).toHaveLength(0);
  });

  it('still blocks a non-user on an explicit or default leave', async () => {
    for (const block of [true, undefined]) {
      const d = data();
      await handleLeave(d, { action: 'leave', channelId: 'seo', participantId: 'svc-1', block }, 'now');
      expect(d.channels[0].blockedParticipantIds).toContain('svc-1');
      expect(d.channels[0].blockedParticipantIds).toContain('name:Engine Report Review');
    }
  });
});
