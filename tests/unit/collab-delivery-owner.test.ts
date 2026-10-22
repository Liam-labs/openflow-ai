import { describe, expect, it } from 'vitest';

import { resolveCurrentDeliveryOwnerId } from '@/lib/collab-delivery-owner';
import type { AgentRosterEntry, CollabChannelsData } from '@/lib/types';

const channels: CollabChannelsData = {
  channels: [{
    id: 'channel-1',
    name: 'Test',
    createdAt: '2026-08-04T00:00:00.000Z',
    lastActivity: '2026-08-04T00:00:00.000Z',
    participants: [{
      id: 'roster-jack',
      name: 'Jack',
      type: 'codex',
      source: 'collab-codex wrapper',
      pid: 333,
      deliveryProtocol: 'ledger-v1',
      joinedAt: '2026-08-04T00:00:00.000Z',
      lastSeen: '2026-08-04T00:00:00.000Z',
    }],
    messages: [],
    roster: {
      agents: [{
        id: 'agent-jack',
        name: 'Jack',
        participantId: 'roster-jack',
        channelId: 'channel-1',
        status: 'running',
        pid: 222,
        agentType: 'codex',
        deliveryProtocol: 'ledger-v1',
      } as unknown as AgentRosterEntry],
      lastUpdated: '2026-08-04T00:00:00.000Z',
    },
    settings: { autoRespond: false },
  }],
  lastUpdated: '2026-08-04T00:00:00.000Z',
};

describe('durable delivery owner fencing', () => {
  it('uses the current roster wrapper PID instead of the replaceable child PID', () => {
    expect(resolveCurrentDeliveryOwnerId(
      channels,
      'channel-1',
      'roster-jack',
    )).toBe('codex:roster-jack:222');
  });

  it('does not authorise an absent participant or a participant without a current PID', () => {
    expect(resolveCurrentDeliveryOwnerId(channels, 'channel-1', 'roster-stale')).toBeNull();
    const missingPid = structuredClone(channels);
    delete missingPid.channels[0].roster?.agents[0].pid;
    delete missingPid.channels[0].participants[0].pid;
    expect(resolveCurrentDeliveryOwnerId(missingPid, 'channel-1', 'roster-jack')).toBeNull();
  });
});
