import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { needsBroadcastWarning } from '@/lib/broadcast-warning';

const base = { mentionCount: 0, agentCount: 3, alreadyConfirmed: false, isReply: false, isMobile: false };

describe('needsBroadcastWarning', () => {
  it('warns for a plain message in a channel with several agents', () => {
    expect(needsBroadcastWarning(base)).toBe(true);
  });
  it('does not warn when only one agent can hear it, as in the Setup channel with Jack', () => {
    expect(needsBroadcastWarning({ ...base, agentCount: 1 })).toBe(false);
    expect(needsBroadcastWarning({ ...base, agentCount: 0 })).toBe(false);
  });
  it('does not warn when someone is mentioned, it was confirmed, it is a reply, or on a phone', () => {
    for (const over of [{ mentionCount: 1 }, { alreadyConfirmed: true }, { isReply: true }, { isMobile: true }]) {
      expect(needsBroadcastWarning({ ...base, ...over })).toBe(false);
    }
  });
});

describe('role text in message headers', () => {
  it('prefers the roster entry\'s display label (Jack shows Assistant, not Researcher)', () => {
    const source = readFileSync('components/ColabChatView.tsx', 'utf-8');
    expect(source).toContain('const roleText = ra?.roleLabel || role?.name;');
  });
});
