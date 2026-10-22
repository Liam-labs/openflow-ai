import { describe, it, expect } from 'vitest';
import { parseAtMentions } from '@/lib/collab-utils';
import type { CollabParticipant } from '@/lib/types';

const participants: CollabParticipant[] = [
  { id: 'p1', name: 'Daniel', type: 'agent', joinedAt: '', lastSeen: '' } as unknown as CollabParticipant,
  { id: 'p2', name: 'Builder',  type: 'agent', joinedAt: '', lastSeen: '' } as unknown as CollabParticipant,
];

describe('parseAtMentions — markdown trailing-char strip (Sprint 43 P1-T2)', () => {
  it('matches @Daniel** (bold suffix)', () => {
    expect(parseAtMentions('hey **@Daniel** check this', participants)).toEqual(['p1']);
  });

  it('matches @Daniel* (italic suffix)', () => {
    expect(parseAtMentions('*@Daniel* please look', participants)).toEqual(['p1']);
  });

  it('matches @Daniel_ (alt italic suffix)', () => {
    expect(parseAtMentions('_@Daniel_ ping', participants)).toEqual(['p1']);
  });

  it('matches @Daniel__ (alt bold suffix)', () => {
    expect(parseAtMentions('__@Daniel__ urgent', participants)).toEqual(['p1']);
  });

  it('still strips punctuation alongside markdown', () => {
    expect(parseAtMentions('hey **@Daniel**, look at this', participants)).toEqual(['p1']);
  });

  it('handles mixed mentions in the same message', () => {
    const ids = parseAtMentions('**@Daniel** and *@Builder*', participants);
    expect(ids.sort()).toEqual(['p1', 'p2']);
  });

  it('plain @Daniel still works (no regression)', () => {
    expect(parseAtMentions('@Daniel hello', participants)).toEqual(['p1']);
  });
});
