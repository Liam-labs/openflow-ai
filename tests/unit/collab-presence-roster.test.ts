import { describe, expect, it } from 'vitest';
import { participantPresence } from '@/lib/collab-presence';
import type { AgentRosterEntry, CollabChannel, CollabParticipant } from '@/lib/types';

const now = Date.parse('2026-10-15T17:50:00Z');
const fresh = '2026-10-15T17:43:00Z'; // 7 minutes old: inside the 15 minute window

function participant(id: string, lastSeen = fresh): CollabParticipant {
  return { id, name: 'Agent', type: 'claude', lastSeen } as CollabParticipant;
}
function channel(agents: Partial<AgentRosterEntry>[]): CollabChannel {
  return { id: 'c', participants: [], roster: { agents: agents as AgentRosterEntry[], lastUpdated: '' } } as unknown as CollabChannel;
}

describe('roster participant presence', () => {
  const id = '638e92e4-65b7-43a8-bdaf-f808ff2a3576';

  it.each(['stopped', 'crashed'])('is offline when the roster agent is %s despite a fresh lastSeen', status => {
    expect(participantPresence(participant('roster-638e92e4'), channel([{ id, status } as Partial<AgentRosterEntry>]), now)).toBe('offline');
  });

  it('stays online for a running roster agent with fresh lastSeen', () => {
    expect(participantPresence(participant('roster-638e92e4'), channel([{ id, status: 'running' } as Partial<AgentRosterEntry>]), now)).toBe('online');
  });

  it('still uses lastSeen when the roster agent is running but stale, or unknown', () => {
    const stale = '2026-10-15T17:00:00Z';
    expect(participantPresence(participant('roster-638e92e4', stale), channel([{ id, status: 'running' } as Partial<AgentRosterEntry>]), now)).toBe('offline');
    expect(participantPresence(participant('roster-deadbeef'), channel([{ id, status: 'stopped' } as Partial<AgentRosterEntry>]), now)).toBe('online');
    expect(participantPresence(participant('roster-638e92e4'), { id: 'c', participants: [] } as unknown as CollabChannel, now)).toBe('online');
  });

  it('matches an explicit participantId before the id prefix', () => {
    const agents = [
      { id, status: 'running', participantId: 'roster-other' },
      { id: 'ffffffff-0000', status: 'stopped', participantId: 'roster-638e92e4' },
    ] as Partial<AgentRosterEntry>[];
    expect(participantPresence(participant('roster-638e92e4'), channel(agents), now)).toBe('offline');
    expect(participantPresence(participant('roster-other'), channel(agents), now)).toBe('online');
  });

  it('leaves non-roster participants on the lastSeen rule', () => {
    expect(participantPresence(participant('human-1'), channel([{ id, status: 'stopped' } as Partial<AgentRosterEntry>]), now)).toBe('online');
  });
});
