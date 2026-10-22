/**
 * Who counts as the account owner in a channel, and how their display name is applied
 * (lib/human-identity.ts). Slack, Teams and hearing participants are also type `user`.
 */
import { describe, expect, it } from 'vitest';
import {
  HUMAN_ROUTING_NAME,
  applyDisplayNameToHumans,
  humanParticipants,
  isHumanParticipant,
  mentionsHuman,
} from '@/lib/human-identity';
import type { CollabChannelsData, CollabParticipantType } from '@/lib/types';

const who = (type: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${type}-${name}`, type: type as CollabParticipantType, name, source: 's', joinedAt: '', lastSeen: '', ...extra });

describe('the account owner', () => {
  it('is a user participant with the routing name', () => {
    expect(HUMAN_ROUTING_NAME).toBe('Owner');
    expect(isHumanParticipant(who('user', 'Owner'))).toBe(true);
  });

  it('is not a Slack, Teams or hearing participant, which are type user too', () => {
    for (const name of ['Jane (Slack)', 'Bob (Teams)', 'Hearing companion', 'Judge (rehearsal)']) {
      expect(isHumanParticipant(who('user', name)), name).toBe(false);
    }
  });

  it('is not an agent that happens to share the name', () => {
    expect(isHumanParticipant(who('claude-terminal', 'Owner'))).toBe(false);
  });

  it('finds every one of their records in a channel', () => {
    const records = [who('user', 'Owner', { id: 'user-owner-doe' }), who('codex', 'Jack'), who('user', 'Owner', { id: 'browser-user-1' })];
    expect(humanParticipants(records).map(p => p.id)).toEqual(['user-owner-doe', 'browser-user-1']);
    expect(humanParticipants(undefined)).toEqual([]);
  });
});

describe('applying the display name', () => {
  const data = () => ({
    channels: [
      { participants: [who('user', 'Owner'), who('codex', 'Jack')] },
      { participants: [who('user', 'Owner', { displayName: 'Bob', id: 'b' }), who('user', 'Jane (Slack)')] },
    ],
  }) as unknown as Pick<CollabChannelsData, 'channels'>;

  it('stamps their records and counts only the ones it changed', () => {
    const file = data();
    expect(applyDisplayNameToHumans(file, 'Bob')).toBe(1);
    expect(file.channels.flatMap(c => c.participants.map(p => p.displayName))).toEqual(['Bob', undefined, 'Bob', undefined]);
    expect(applyDisplayNameToHumans(file, 'Bob')).toBe(0);
    expect(applyDisplayNameToHumans(file, 'Rob')).toBe(2);
  });

  it('never changes the routing name', () => {
    const file = data();
    applyDisplayNameToHumans(file, 'Somebody else');
    expect(file.channels[0].participants[0].name).toBe('Owner');
  });
});

describe('mentionsHuman', () => {
  const tag = `@${HUMAN_ROUTING_NAME}`;

  it('matches the owner tag as a whole word, in any case', () => {
    expect(mentionsHuman(`${tag} done`)).toBe(true);
    expect(mentionsHuman(`ping ${tag.toUpperCase()}, please`)).toBe(true);
    expect(mentionsHuman(`${tag}'s turn`)).toBe(true);
  });

  it('ignores a longer name, a bare name and no text', () => {
    expect(mentionsHuman(`${tag}x says hi`)).toBe(false);
    expect(mentionsHuman(HUMAN_ROUTING_NAME)).toBe(false);
    expect(mentionsHuman(undefined)).toBe(false);
  });
});
