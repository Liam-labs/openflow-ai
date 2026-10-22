/**
 * T3.2 — @mention to a STOPPED roster agent must stay TARGETED, not degrade to
 * a channel-wide broadcast.
 *
 * Bug: a killed agent is removed from channel.participants but persists in
 * channel.roster.agents (status='stopped'). parseAtMentions only matched
 * participants-by-name and roles->roster, never roster-agents-by-name, so an
 * @mention of a stopped agent resolved to []  ->  computeRecipients returned
 * undefined  ->  deliverMessage treated it as a broadcast and fanned out to
 * every agent (no-JSONL bystanders hit a re-delivery storm).
 *
 * RED (before fix): parseAtMentions returns [] for a stopped-agent mention;
 *                   computeRecipients returns undefined (broadcast).
 * GREEN (after fix): both resolve to the stopped agent's stable participantId.
 */

import { describe, it, expect } from 'vitest';
import { parseAtMentions } from '@/lib/collab-utils';
import { computeRecipients } from '@/lib/collab-delivery';
import type { CollabParticipant, CollabChannel, AgentRosterEntry } from '@/lib/types';

// Live participants — note: the stopped agent "Probe" is NOT here (killed agents
// are filtered out of channel.participants).
const participants: CollabParticipant[] = [
  { id: 'browser-user-1', name: 'Owner', type: 'user', joinedAt: '', lastSeen: '' } as unknown as CollabParticipant,
  { id: 'roster-sender', name: 'Reynolds', type: 'claude-terminal', joinedAt: '', lastSeen: '' } as unknown as CollabParticipant,
];

// Roster retains the stopped agent with its stable participantId.
const roster: AgentRosterEntry[] = [
  { id: 'a-sender', name: 'Reynolds', participantId: 'roster-sender', status: 'running' } as unknown as AgentRosterEntry,
  { id: 'a-probe', name: 'Probe', participantId: 'roster-probe', status: 'stopped' } as unknown as AgentRosterEntry,
];

const channel = {
  id: 'ch1',
  participants,
  roster: { agents: roster },
} as unknown as CollabChannel;

describe('T3.2 — stopped-agent @mention stays targeted', () => {
  it('parseAtMentions resolves a stopped roster agent by name to its participantId', () => {
    expect(parseAtMentions('@Probe you there?', participants, roster)).toEqual(['roster-probe']);
  });

  it('parseAtMentions is case-insensitive for the roster fallback', () => {
    expect(parseAtMentions('@probe ping', participants, roster)).toEqual(['roster-probe']);
  });

  it('computeRecipients returns a TARGETED list (not undefined) for a stopped-agent mention', () => {
    const recipients = computeRecipients('@Probe please ack on return', 'roster-sender', channel);
    expect(recipients).toBeDefined();
    expect(recipients).toContain('roster-probe');
    // the human user is always included so the channel UI renders it
    expect(recipients).toContain('browser-user-1');
  });

  it('regression: @mention of a LIVE participant still resolves to its id', () => {
    expect(parseAtMentions('@Reynolds hi', participants, roster)).toEqual(['roster-sender']);
  });

  it('regression: an unknown name still yields no targeted ids (genuine broadcast)', () => {
    expect(parseAtMentions('@nobody-here hello', participants, roster)).toEqual([]);
    expect(computeRecipients('@nobody-here hello', 'roster-sender', channel)).toBeUndefined();
  });
});
