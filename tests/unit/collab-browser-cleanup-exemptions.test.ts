import { describe, expect, it } from 'vitest';

import { selectStaleParticipantsForCleanup } from '@/lib/collab-participant-cleanup';
import type { CollabChannel, CollabParticipant } from '@/lib/types';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const STALE = '2026-10-08T10:00:00.000Z';
const FRESH = '2026-10-08T11:59:30.000Z';
const PROJECT = '/home/user/CMS-Case/Team/Weir';
const TEN_MIN = 10 * 60 * 1000;

const hearingClient = (overrides: Partial<CollabParticipant> = {}): CollabParticipant => ({
  id: 'hearing-client-weir-rehearsal', type: 'user', name: 'Hearing companion', source: 'Hearing companion',
  joinedAt: STALE, lastSeen: STALE, ...overrides,
});
const weir = (overrides: Partial<CollabParticipant> = {}): CollabParticipant => ({
  id: 'weir-1', type: 'claude-terminal', name: 'Weir', source: 'collab-claude wrapper',
  joinedAt: STALE, lastSeen: STALE, projectPath: PROJECT, ...overrides,
});
const parent = (...participants: CollabParticipant[]) => ({
  id: 'parent', name: 'CMS', participants, messages: [], settings: { autoRespond: false }, createdAt: STALE, lastActivity: STALE,
}) as CollabChannel;
const select = (participants: CollabParticipant[], parentChannel?: CollabChannel) =>
  selectStaleParticipantsForCleanup({ participants, parentChannel, nowMs: NOW, staleAfterMs: TEN_MIN }).map(p => p.id);

describe('browser 10-minute cleanup exemptions (probe04)', () => {
  it('never removes the commissioned hearing client, however long it has been idle', () => {
    expect(select([hearingClient()])).toEqual([]);
  });

  it('removes look-alikes that do not carry the exact hearing client identity', () => {
    expect(select([
      hearingClient({ id: 'hearing-x', name: 'Hearing companion' }),
      hearingClient({ id: 'hearing-client-2', name: 'Someone' }),
      hearingClient({ id: 'hearing-client-3', source: 'other' }),
      hearingClient({ id: 'hearing-client-4', type: 'claude-terminal' }),
    ])).toEqual(['hearing-x', 'hearing-client-2', 'hearing-client-3', 'hearing-client-4']);
  });

  it("keeps Owner's canonical identity while idle, but still ages out throwaway browser rows", () => {
    const user = (id: string, type = 'user'): CollabParticipant =>
      ({ id, type, name: 'Owner', source: 'DevFlow', joinedAt: STALE, lastSeen: STALE } as CollabParticipant);
    expect(select([
      user('user-owner-doe'),
      user('browser-user-abc'),
      user('user-owner-doe-agent', 'claude-terminal'),
      user('user-Owner Doe'),
    ])).toEqual(['browser-user-abc', 'user-owner-doe-agent', 'user-Owner Doe']);
  });

  it('keeps an inherited row while the same agent is live in the parent, and removes it once it is not', () => {
    expect(select([weir()], parent(weir({ lastSeen: FRESH })))).toEqual([]);
    expect(select([weir()], parent(weir()))).toEqual(['weir-1']);
    expect(select([weir()], parent(weir({ lastSeen: FRESH, projectPath: '/home/user/Other' })))).toEqual(['weir-1']);
    expect(select([weir()], null)).toEqual(['weir-1']);
  });
});
