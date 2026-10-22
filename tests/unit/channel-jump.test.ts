import { describe, expect, it } from 'vitest';
import { buildJumpEntries, filterJumpEntries } from '@/components/collab/ChannelJump';
import type { CollabChannel } from '@/components/colab-types';

const ch = (id: string, name: string, extra: Partial<CollabChannel> = {}) => ({
  id, name, createdAt: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-01T00:00:00.000Z', participants: [], messages: [], ...extra,
}) as CollabChannel;
const groups = [{ id: 'work', name: 'Work' }, { id: 'life', name: 'Life' }];
const channels = [
  ch('a', 'AcmeMedia Web', { lastMessageAt: '2026-10-01T00:00:00.000Z' }),
  ch('b', 'Life Admin', { settings: { category: 'life' } as CollabChannel['settings'], lastMessageAt: '2026-10-02T00:00:00.000Z' }),
  ch('c', 'CMS - Case', { pinnedAt: '2026-09-01T00:00:00.000Z' }),
  ch('d', 'CMS practice', { parentChannelId: 'c' }),
  ch('cmd', 'Commander'),
];

describe('channel jump', () => {
  const entries = buildJumpEntries(channels, groups, { a: 3 }, 'cmd');

  it('says where each channel lives and ranks unread first, then newest', () => {
    expect(entries.map(e => e.channel.id).slice(0, 2)).toEqual(['a', 'b']);
    const where = Object.fromEntries(entries.map(e => [e.channel.id, e.where]));
    expect(where).toMatchObject({ a: 'Work', b: 'Life', c: 'Pinned', cmd: 'Commander' });
    expect(where.d).toBe('Pinned · in CMS - Case');
  });

  it('needs every word, matches the group name too, and prefers name-start matches', () => {
    expect(filterJumpEntries(entries, '').length).toBe(5);
    expect(filterJumpEntries(entries, 'cms').map(e => e.channel.id).sort()).toEqual(['c', 'd']);
    expect(filterJumpEntries(entries, 'life').map(e => e.channel.id)).toEqual(['b']);
    expect(filterJumpEntries(entries, 'admin life').map(e => e.channel.id)).toEqual(['b']);
    expect(filterJumpEntries(entries, 'web nothing')).toEqual([]);
    expect(filterJumpEntries(entries, 'case')[0].channel.id).toBe('c');
  });
});
