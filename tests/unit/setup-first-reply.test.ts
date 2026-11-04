/**
 * BUG-54: in a reused channel the first-run wizard must not count an earlier run's agent reply as an answer to this
 * run's hello. everyAgentAnswered / freshReplies only count agent messages whose id is NOT in the pre-run watermark.
 */
import { describe, it, expect } from 'vitest';
import { isFreshAgentReply, freshReplies, everyAgentAnswered, type FirstReplyMessage } from '@/lib/setup-first-reply';

const user = (id: string, name = 'You') => ({ id, from: { name, type: 'user' } });
const agent = (id: string, name: string) => ({ id, from: { name, type: 'agent' } });

// A reused channel: it already held an old Heimdall reply (m-old) and the person's old hello (h-old) before this run.
const PRIOR = new Set(['h-old', 'm-old']);
const reusedChannel: FirstReplyMessage[] = [
  user('h-old'),            // last run's hello
  agent('m-old', 'Heimdall'), // last run's reply — must NOT count this run
  user('h-new'),            // this run's hello
];

describe('isFreshAgentReply', () => {
  it('rejects the person and any message already present before the run', () => {
    expect(isFreshAgentReply(user('h-new'), PRIOR)).toBe(false);        // the person
    expect(isFreshAgentReply(agent('m-old', 'Heimdall'), PRIOR)).toBe(false); // old reply
    expect(isFreshAgentReply(agent('m-new', 'Heimdall'), PRIOR)).toBe(true);  // this run's reply
  });
});

describe('everyAgentAnswered', () => {
  it('is false when only an earlier run\'s reply is present (BUG-54)', () => {
    expect(everyAgentAnswered(reusedChannel, ['Heimdall'], PRIOR)).toBe(false);
  });

  it('becomes true once a fresh reply arrives', () => {
    const after = [...reusedChannel, agent('m-new', 'Heimdall')];
    expect(everyAgentAnswered(after, ['Heimdall'], PRIOR)).toBe(true);
  });

  it('needs every named agent to answer this run', () => {
    const msgs = [...reusedChannel, agent('a1', 'Heimdall')];           // only one of two
    expect(everyAgentAnswered(msgs, ['Heimdall', 'Builder'], PRIOR)).toBe(false);
    expect(everyAgentAnswered([...msgs, agent('a2', 'Builder')], ['Heimdall', 'Builder'], PRIOR)).toBe(true);
  });

  it('a fresh install (empty watermark) counts the first agent reply', () => {
    expect(everyAgentAnswered([user('h1'), agent('r1', 'Heimdall')], ['Heimdall'], new Set())).toBe(true);
  });
});

describe('freshReplies', () => {
  it('returns only this run\'s agent messages from the started agents', () => {
    const msgs = [...reusedChannel, agent('m-new', 'Heimdall'), agent('x', 'Stranger')];
    const out = freshReplies(msgs, ['Heimdall'], PRIOR);
    expect(out.map((m) => m.id)).toEqual(['m-new']);   // not m-old (prior), not Stranger (not started)
  });
});
