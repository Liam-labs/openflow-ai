import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollabChannel, CollabChannelsData, CollabParticipant } from '@/lib/types';

const { appendMessages } = vi.hoisted(() => ({
  appendMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/collab-message-io', () => ({ appendMessages }));

const { cleanupStaleParticipants } = await import('@/app/api/collab/_collab-shared');

const NOW = new Date('2026-10-08T12:00:00.000Z');
const STALE = '2026-10-08T10:00:00.000Z'; // 2 h old: past the 30-minute cleanup threshold
const FRESH = '2026-10-08T11:59:30.000Z';
const PROJECT = '/home/user/CMS-Case/Team/Weir';

function agent(overrides: Partial<CollabParticipant> = {}): CollabParticipant {
  return {
    id: 'weir-1', type: 'claude-terminal', name: 'Weir', source: 'collab-claude wrapper',
    joinedAt: STALE, lastSeen: STALE, projectPath: PROJECT, ...overrides,
  };
}

function channel(id: string, participants: CollabParticipant[], parentChannelId?: string): CollabChannel {
  return {
    id, name: id, participants, messages: [], settings: { autoRespond: false },
    createdAt: STALE, lastActivity: STALE, ...(parentChannelId ? { parentChannelId } : {}),
  } as CollabChannel;
}

const data = (...channels: CollabChannel[]): CollabChannelsData => ({ channels, lastUpdated: STALE });
const child = (d: CollabChannelsData) => d.channels.find(c => c.id === 'child')!;

describe('cleanup keeps inherited membership of a live parent agent', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); appendMessages.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it('keeps a stale child row whose parent has the same live agent, without touching timestamps', async () => {
    const d = data(channel('parent', [agent({ lastSeen: FRESH })]), channel('child', [agent()], 'parent'));
    expect(await cleanupStaleParticipants(d)).toBe(0);
    expect(child(d).participants).toHaveLength(1);
    expect(child(d).participants[0].lastSeen).toBe(STALE);
    expect(d.channels[0].participants[0].lastSeen).toBe(FRESH);
  });

  it('is independent of channel order', async () => {
    const d = data(channel('child', [agent()], 'parent'), channel('parent', [agent({ lastSeen: FRESH })]));
    expect(await cleanupStaleParticipants(d)).toBe(0);
    expect(child(d).participants).toHaveLength(1);
  });

  it('removes the row when the declared parent channel is missing', async () => {
    const d = data(channel('child', [agent()], 'parent'));
    expect(await cleanupStaleParticipants(d)).toBe(1);
    expect(child(d).participants).toHaveLength(0);
  });

  it('removes the row when the parent agent has a different ID or project path', async () => {
    const otherId = data(channel('parent', [agent({ id: 'weir-2', lastSeen: FRESH })]), channel('child', [agent()], 'parent'));
    expect(await cleanupStaleParticipants(otherId)).toBe(1);
    const otherPath = data(channel('parent', [agent({ projectPath: '/home/user/Other/Team/Weir', lastSeen: FRESH })]), channel('child', [agent()], 'parent'));
    expect(await cleanupStaleParticipants(otherPath)).toBe(1);
  });

  it('removes the row when the parent agent is offline, or the child row has no project path', async () => {
    const offline = data(channel('parent', [agent()]), channel('child', [agent()], 'parent'));
    expect(await cleanupStaleParticipants(offline)).toBe(2);
    const noPath = data(channel('parent', [agent({ projectPath: undefined, lastSeen: FRESH })]), channel('child', [agent({ projectPath: undefined })], 'parent'));
    expect(await cleanupStaleParticipants(noPath)).toBe(1);
    expect(child(noPath).participants).toHaveLength(0);
  });

  it('never matches by name and still removes ordinary stale rows in channels without a parent', async () => {
    const byName = data(channel('parent', [agent({ id: 'someone-else', lastSeen: FRESH })]), channel('child', [agent()], 'parent'));
    expect(await cleanupStaleParticipants(byName)).toBe(1);
    const plain = data(channel('solo', [agent()]));
    expect(await cleanupStaleParticipants(plain)).toBe(1);
  });
});
