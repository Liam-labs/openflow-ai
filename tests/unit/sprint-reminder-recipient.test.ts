/**
 * P5.1 TDD — pickReminderRecipient fallback hardening
 *
 * Verifies the roleId fallback: when teamLeadId is absent or offline,
 * any participant with the team-lead roleId is checked before falling
 * through to any-online or null (hold).
 */

import { describe, it, expect } from 'vitest';
import type { CollabChannel, CollabParticipant } from '../../lib/types';
import { pickReminderRecipient } from '../../lib/sprint-reminder-logic';

const TEAM_LEAD_ROLE_ID = '04eecdef-cc15-44f6-9d8c-366774c2a466';

const NOW = new Date();

function minsAgo(n: number): string {
  return new Date(NOW.getTime() - n * 60_000).toISOString();
}

function makeParticipant(overrides: Partial<CollabParticipant> = {}): CollabParticipant {
  return {
    id: 'p-1',
    type: 'claude',
    name: 'Agent',
    source: 'WSL',
    joinedAt: minsAgo(120),
    lastSeen: minsAgo(2), // online by default
    ...overrides,
  };
}

function makeChannel(overrides: Partial<CollabChannel> = {}): CollabChannel {
  return {
    id: 'ch-1',
    name: 'SG-1',
    createdAt: minsAgo(120),
    lastActivity: minsAgo(25),
    participants: [],
    messages: [],
    settings: { autoRespond: false },
    ...overrides,
  };
}

describe('pickReminderRecipient — roleId fallback (P5.1 hardening)', () => {
  it('returns null (hold) when TL is offline and no member is online', () => {
    const tl = makeParticipant({ id: 'tl-1', lastSeen: minsAgo(10) }); // offline
    const member = makeParticipant({ id: 'p-2', lastSeen: minsAgo(8) }); // offline
    const channel = makeChannel({ participants: [tl, member], teamLeadId: 'tl-1' });
    expect(pickReminderRecipient(channel, NOW)).toBeNull();
  });

  it('returns participant with team-lead roleId when teamLeadId is absent and roleId participant is online', () => {
    const member = makeParticipant({ id: 'p-2', lastSeen: minsAgo(2) }); // online, no special role
    const tlByRole = makeParticipant({ id: 'p-tl', lastSeen: minsAgo(2), roleId: TEAM_LEAD_ROLE_ID });
    const channel = makeChannel({ participants: [member, tlByRole] }); // no teamLeadId
    const result = pickReminderRecipient(channel, NOW);
    expect(result?.id).toBe('p-tl');
  });

  it('returns participant with team-lead roleId when teamLeadId is set but offline', () => {
    const offlineTl = makeParticipant({ id: 'tl-1', lastSeen: minsAgo(10) }); // offline
    const tlByRole = makeParticipant({ id: 'p-tl', lastSeen: minsAgo(2), roleId: TEAM_LEAD_ROLE_ID }); // online
    const channel = makeChannel({ participants: [offlineTl, tlByRole], teamLeadId: 'tl-1' });
    const result = pickReminderRecipient(channel, NOW);
    expect(result?.id).toBe('p-tl');
  });

  it('teamLeadId takes priority over roleId match when both online', () => {
    const tl = makeParticipant({ id: 'tl-1', lastSeen: minsAgo(2) }); // online
    const tlByRole = makeParticipant({ id: 'p-tl', lastSeen: minsAgo(2), roleId: TEAM_LEAD_ROLE_ID });
    const channel = makeChannel({ participants: [tl, tlByRole], teamLeadId: 'tl-1' });
    const result = pickReminderRecipient(channel, NOW);
    expect(result?.id).toBe('tl-1');
  });

  it('falls back to any online member when TL offline and no roleId match', () => {
    const tl = makeParticipant({ id: 'tl-1', lastSeen: minsAgo(10) }); // offline
    const member = makeParticipant({ id: 'p-2', lastSeen: minsAgo(2) }); // online, no role
    const channel = makeChannel({ participants: [tl, member], teamLeadId: 'tl-1' });
    const result = pickReminderRecipient(channel, NOW);
    expect(result?.id).toBe('p-2');
  });

  it('returns null when all participants are offline', () => {
    const p1 = makeParticipant({ id: 'p-1', lastSeen: minsAgo(10) });
    const p2 = makeParticipant({ id: 'p-2', lastSeen: minsAgo(10) });
    const channel = makeChannel({ participants: [p1, p2] });
    expect(pickReminderRecipient(channel, NOW)).toBeNull();
  });

  it('returns null when channel has no participants', () => {
    const channel = makeChannel({ participants: [] });
    expect(pickReminderRecipient(channel, NOW)).toBeNull();
  });

  it('does not select offline roleId participant — falls through to any-online', () => {
    const offlineTlByRole = makeParticipant({ id: 'p-tl', lastSeen: minsAgo(10), roleId: TEAM_LEAD_ROLE_ID }); // offline
    const onlineMember = makeParticipant({ id: 'p-2', lastSeen: minsAgo(2) }); // online
    const channel = makeChannel({ participants: [offlineTlByRole, onlineMember] });
    const result = pickReminderRecipient(channel, NOW);
    expect(result?.id).toBe('p-2');
  });
});
