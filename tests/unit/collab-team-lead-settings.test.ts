import { describe, expect, it, vi } from 'vitest';
import { handleUpdateSettings } from '@/app/api/collab/_handlers/settings';
import type { CollabChannelsData, CollabParticipant, CollabParticipantType } from '@/lib/types';

vi.mock('@/app/api/collab/_collab-shared', () => ({
  writeData: vi.fn().mockResolvedValue(undefined),
  invalidateUnreadCache: vi.fn(),
}));

function participant(id: string, type: CollabParticipantType): CollabParticipant {
  return {
    id,
    type,
    name: id,
    source: type === 'user' ? 'DevFlow UI' : 'WSL',
    joinedAt: '2026-08-05T08:00:00Z',
    lastSeen: '2026-08-05T08:00:00Z',
  };
}

function channelData(candidate: CollabParticipant): CollabChannelsData {
  return {
    channels: [{
      id: 'channel-1',
      name: 'Test Channel',
      createdAt: '2026-08-05T08:00:00Z',
      lastActivity: '2026-08-05T08:00:00Z',
      participants: [participant('owner', 'user'), candidate],
      messages: [],
      settings: { autoRespond: false },
    }],
    lastUpdated: '2026-08-05T08:00:00Z',
  };
}

describe('handleUpdateSettings — Team Lead assignment', () => {
  it.each<CollabParticipantType>([
    'claude',
    'claude-terminal',
    'claude-browser',
    'gemini',
    'gemini-powershell',
    'gemini-terminal',
    'grok',
    'codex',
  ])('accepts %s agents', async (type) => {
    const candidate = participant(`candidate-${type}`, type);
    const data = channelData(candidate);

    const response = await handleUpdateSettings(data, {
      action: 'update_settings',
      channelId: 'channel-1',
      teamLeadId: candidate.id,
    }, '2026-08-05T08:01:00Z');

    expect(response.status).toBe(200);
    expect(data.channels[0].teamLeadId).toBe(candidate.id);
  });

  it('rejects a human participant', async () => {
    const data = channelData(participant('candidate-codex', 'codex'));

    const response = await handleUpdateSettings(data, {
      action: 'update_settings',
      channelId: 'channel-1',
      teamLeadId: 'owner',
    }, '2026-08-05T08:01:00Z');

    expect(response.status).toBe(400);
    expect(data.channels[0].teamLeadId).toBeUndefined();
  });
});
