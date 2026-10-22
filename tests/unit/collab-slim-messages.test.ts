import { describe, expect, it } from 'vitest';
import { toSlimMessages } from '@/app/api/collab/_collab-shared';
import type { CollabMessage, CollabParticipant } from '@/lib/types';

function participant(id: string, name: string): CollabParticipant {
  return {
    id,
    name,
    color: '#8B5CF6',
    type: 'agent',
    source: 'test',
    status: 'online',
    joinedAt: '2026-10-18T00:00:00.000Z',
    lastSeen: '2026-10-18T00:00:00.000Z',
  };
}

function message(id: string, from: CollabParticipant): CollabMessage {
  return {
    id,
    channelId: 'chan-1',
    from,
    content: 'hello',
    timestamp: '2026-10-18T00:00:00.000Z',
  } as CollabMessage;
}

describe('toSlimMessages', () => {
  const member = participant('member-1', 'Jack');
  const outsider = participant('roster-b22beefa', 'Riley');

  it('slims a channel member to fromId only', () => {
    const [slim] = toSlimMessages([message('m1', member)], [member]);
    expect(slim).toMatchObject({ id: 'm1', fromId: 'member-1' });
    expect('from' in slim).toBe(false);
  });

  it('keeps the full sender for a non-member so the real name survives', () => {
    const [kept] = toSlimMessages([message('m2', outsider)], [member]) as CollabMessage[];
    expect(kept.from).toEqual(outsider);
    expect(kept.from.name).toBe('Riley');
    expect('fromId' in kept).toBe(false);
  });

  it('keeps every sender in full when no participant list is given (nothing can be rebuilt)', () => {
    const out = toSlimMessages([message('m1', member), message('m2', outsider)]) as CollabMessage[];
    expect(out.map(m => m.from.name)).toEqual(['Jack', 'Riley']);
  });

  it('matches a member by the whole id, never by a prefix or a longer id', () => {
    const lookalikes = [participant('member-10', 'Jack (other)'), participant('member', 'Jack (short)'), participant('MEMBER-1', 'Jack (case)')];
    for (const sender of lookalikes) {
      const [kept] = toSlimMessages([message('m3', sender)], [member]) as CollabMessage[];
      expect(kept.from.name).toBe(sender.name);
    }
  });

  it('a cross-channel sender whose id is an old pty-session id keeps the real name', () => {
    const jack = participant('pty-fbb41dff-3219-498f-b5d6-f88fa6c085e7', 'Jack');
    const [kept] = toSlimMessages([message('m4', jack)], [participant('roster-c41987cd', 'Architect'), participant('roster-1c9667be', 'Jack')]) as CollabMessage[];
    expect(kept.from.name).toBe('Jack');
    expect('fromId' in kept).toBe(false);
  });

  it('leaves the messages it was given untouched', () => {
    const original = message('m5', member);
    toSlimMessages([original], [member]);
    expect(original.from).toBe(member);
  });

  it('handles a mixed batch', () => {
    const out = toSlimMessages([message('m1', member), message('m2', outsider)], [member]);
    expect('from' in out[0]).toBe(false);
    expect((out[1] as CollabMessage).from.name).toBe('Riley');
  });
});
