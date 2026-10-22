import { describe, expect, it } from 'vitest';
import { computeUnreadCounts } from '@/app/api/collab/_collab-shared';
import type { CollabChannel, CollabMessage, CollabParticipant } from '@/lib/types';

const joinedAt = '2026-09-04T19:00:00.000Z';

function participant(id: string, type: CollabParticipant['type']): CollabParticipant {
  return {
    id,
    name: id,
    type,
    source: 'test',
    joinedAt,
    lastSeen: joinedAt,
  };
}

function message(
  id: string,
  metadata?: CollabMessage['metadata'],
): CollabMessage {
  return {
    id,
    channelId: 'channel-target',
    from: participant('roster-sender', 'codex'),
    content: id,
    timestamp: '2026-09-04T20:00:00.000Z',
    recipients: ['roster-recipient', 'browser-user-owner'],
    metadata,
  };
}

describe('human visibility for agent transport records', () => {
  it('counts compact cross-channel records but not hidden messages as unread for a human', () => {
    const human = participant('browser-user-owner', 'user');
    const agent = participant('roster-recipient', 'codex');
    const channel = {
      id: 'channel-target',
      name: 'Target',
      createdAt: joinedAt,
      participants: [human, agent],
    } as CollabChannel;

    computeUnreadCounts(channel, [
      message('visible'),
      message('hidden', { isHidden: true }),
      message('cross-channel', {
        crossChannel: {
          sourceChannelId: 'channel-source',
          sourceChannelName: 'Source',
          deliveryChannelId: 'channel-target',
          deliveryChannelName: 'Target',
          senderId: 'roster-sender',
          senderName: 'Sender',
          replyTargetParticipantId: 'roster-sender',
        },
      }),
    ]);

    expect(human.unreadCount).toBe(2);
    expect(agent.unreadCount).toBe(3);
  });
});
