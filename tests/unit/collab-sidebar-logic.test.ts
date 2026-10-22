import { describe, expect, it } from 'vitest';
import {
  getLatestVisibleMessagePreview,
  getLatestVisibleMessageTimestamp,
  getSidebarUnreadCount,
  groupChannelsForSidebar,
  channelsNeedingYou,
} from '@/lib/collab-sidebar-logic';
import {
  getCachedLastMessageAt,
  invalidateUnreadCache,
  setCachedUnreadCounts,
} from '@/app/api/collab/_collab-shared';

type TestParticipant = {
  id: string;
  name: string;
  type: string;
  unreadCount?: number;
};

type TestChannel = {
  id: string;
  name: string;
  createdAt: string;
  lastActivity: string;
  lastMessageAt?: string;
  pinnedAt?: string;
  parentChannelId?: string;
  participants: TestParticipant[];
};

const channel = (
  id: string,
  overrides: Partial<TestChannel> = {},
): TestChannel => ({
  id,
  name: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActivity: '2026-01-01T00:00:00.000Z',
  participants: [],
  ...overrides,
});

describe('getSidebarUnreadCount', () => {
  it('uses the server-resolved canonical browser identity', () => {
    const participants: TestParticipant[] = [
      { id: 'user-owner-doe', name: 'Owner', type: 'user', unreadCount: 12 },
      { id: 'roster-agent', name: 'Agent', type: 'codex', unreadCount: 0 },
    ];

    expect(getSidebarUnreadCount(participants, {
      resolvedParticipantId: 'user-owner-doe',
      browserParticipantId: 'browser-user-local',
      browserUsername: 'Owner',
    })).toBe(12);
  });

  it('falls back to the named browser user after an origin/localStorage change', () => {
    const participants: TestParticipant[] = [
      { id: 'user-owner-doe', name: 'Owner', type: 'user', unreadCount: 7 },
      { id: 'user-someone-else', name: 'Someone Else', type: 'user', unreadCount: 3 },
    ];

    expect(getSidebarUnreadCount(participants, {
      resolvedParticipantId: 'browser-user-new-origin',
      browserParticipantId: 'browser-user-new-origin',
      browserUsername: 'Owner',
    })).toBe(7);
  });

  it('does not borrow another user\'s unread count when identity cannot be resolved', () => {
    const participants: TestParticipant[] = [
      { id: 'user-someone-else', name: 'Someone Else', type: 'user', unreadCount: 9 },
    ];

    expect(getSidebarUnreadCount(participants, {
      resolvedParticipantId: 'browser-user-local',
      browserParticipantId: 'browser-user-local',
      browserUsername: 'Owner',
    })).toBe(0);
  });
});

describe('getLatestVisibleMessageTimestamp', () => {
  it('ignores system, silent, and hidden messages but treats cross-channel records as visible', () => {
    const messages = [
      { timestamp: '2026-07-18T09:00:00.000Z', from: { id: 'agent-a' } },
      { timestamp: '2026-07-18T10:00:00.000Z', from: { id: 'system' } },
      { timestamp: '2026-07-18T11:00:00.000Z', from: { id: 'agent-b' }, silent: true },
      { timestamp: '2026-07-18T12:00:00.000Z', from: { id: 'agent-c' }, metadata: { isHidden: true } },
      { timestamp: '2026-07-18T13:00:00.000Z', from: { id: 'agent-d' }, metadata: { crossChannel: { sourceChannelId: 'other' } } },
    ];

    expect(getLatestVisibleMessageTimestamp(messages)).toBe('2026-07-18T13:00:00.000Z');
  });
});

describe('getLatestVisibleMessagePreview', () => {
  const at = (hour: number) => `2026-07-18T${String(hour).padStart(2, '0')}:00:00.000Z`;

  it('reads "Sender: text" from the latest visible message, skipping system and hidden ones', () => {
    expect(getLatestVisibleMessagePreview([
      { timestamp: at(9), from: { id: 'a', name: 'Architect Carter' }, content: 'plan approved' },
      { timestamp: at(10), from: { id: 'system', name: 'System' }, content: 'flush' },
      { timestamp: at(11), from: { id: 'b', name: 'Jack' }, content: 'secret', metadata: { isHidden: true } },
    ])).toBe('Architect: plan approved');
  });

  it('drops the @mentions a message opens with', () => {
    expect(getLatestVisibleMessagePreview([
      { timestamp: at(9), from: { id: 'a', name: 'Developer' }, content: '@Owner \u2014 @Builder fixed and deployed.' },
    ])).toBe('Developer: fixed and deployed.');
  });

  it('flattens markdown and code, and cuts long text to one line', () => {
    const preview = getLatestVisibleMessagePreview([
      { timestamp: at(9), from: { id: 'a', name: 'Jack' }, content: '**Done**\n```sh\nnpm run build\n```\nsee [the report](http://x/y) ' + 'word '.repeat(40) },
    ])!;
    expect(preview.startsWith('Jack: Done code see the report word')).toBe(true);
    expect(preview).not.toMatch(/[\n`*]/);
    expect(Array.from(preview.replace('Jack: ', '')).length).toBeLessThanOrEqual(90);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('describes an attachment-only message and returns undefined when nothing is visible', () => {
    expect(getLatestVisibleMessagePreview([
      { timestamp: at(9), from: { id: 'a', name: 'Developer' }, content: '', images: [{}] },
    ])).toBe('Developer: sent an attachment');
    expect(getLatestVisibleMessagePreview([{ timestamp: at(9), from: { id: 'system' }, content: 'x' }])).toBeUndefined();
  });
});

describe('channel-list metadata cache', () => {
  it('caches and invalidates the latest visible message timestamp with unread counts', () => {
    const channelId = 'sidebar-cache-test';
    const lastMessageAt = '2026-07-18T09:00:00.000Z';

    setCachedUnreadCounts(channelId, new Map([['user-owner', 4]]), lastMessageAt);
    expect(getCachedLastMessageAt(channelId)).toBe(lastMessageAt);

    invalidateUnreadCache(channelId);
    expect(getCachedLastMessageAt(channelId)).toBeUndefined();
  });
});

describe('groupChannelsForSidebar', () => {
  it('keeps Commander separate, then orders pinned channels by newest pin', () => {
    const grouped = groupChannelsForSidebar([
      channel('old-pin', { pinnedAt: '2026-06-01T00:00:00.000Z' }),
      channel('commander'),
      channel('new-pin', { pinnedAt: '2026-07-01T00:00:00.000Z' }),
    ], 'commander');

    expect(grouped.commanderChannel?.id).toBe('commander');
    expect(grouped.parentChannels.map(item => item.id)).toEqual(['new-pin', 'old-pin']);
  });

  it('orders unpinned channels by latest visible message, not noisy lifecycle activity', () => {
    const grouped = groupChannelsForSidebar([
      channel('recent-message', {
        lastMessageAt: '2026-07-18T12:00:00.000Z',
        lastActivity: '2026-07-18T12:00:00.000Z',
      }),
      channel('recent-agent-rejoin', {
        lastMessageAt: '2026-07-17T12:00:00.000Z',
        lastActivity: '2026-07-18T13:00:00.000Z',
      }),
    ], 'commander');

    expect(grouped.parentChannels.map(item => item.id)).toEqual([
      'recent-message',
      'recent-agent-rejoin',
    ]);
  });

  it('orders subchannels by latest visible message and uses deterministic fallbacks', () => {
    const grouped = groupChannelsForSidebar([
      channel('parent'),
      channel('older-sub', {
        parentChannelId: 'parent',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
      channel('newer-sub', {
        parentChannelId: 'parent',
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
    ], 'commander');

    expect(grouped.subChannelsByParent.parent.map(item => item.id)).toEqual([
      'newer-sub',
      'older-sub',
    ]);
  });
});

describe('channelsNeedingYou', () => {
  const ch = (id: string, lastMessageAt?: string) => ({ id, name: id, createdAt: '2026-01-01T00:00:00Z', lastMessageAt });
  const channels = [ch('old', '2026-10-01T00:00:00Z'), ch('new', '2026-10-02T00:00:00Z'), ch('read', '2026-10-03T00:00:00Z'), ch('cmd', '2026-10-04T00:00:00Z')];

  it('lists only channels with unread messages, newest first, never Commander', () => {
    expect(channelsNeedingYou(channels, { old: 1, new: 3, read: 0, cmd: 5 }, 'cmd').map(c => c.id)).toEqual(['new', 'old']);
  });

  it('drops a channel once its unread count is cleared', () => {
    expect(channelsNeedingYou(channels, { new: 0 }, 'cmd')).toEqual([]);
  });
});
