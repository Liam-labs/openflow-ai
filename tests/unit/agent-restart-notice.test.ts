import { describe, expect, it } from 'vitest';
import { buildRestartResumeText, formatShutdownTime, unansweredMentions } from '@/lib/agent-restart-notice';
import type { CollabMessage } from '@/lib/types';

describe('buildRestartResumeText', () => {
  it('addresses the agent, states the shutdown time and points at the handoff', () => {
    const text = buildRestartResumeText('Builder', '2026-09-28T01:40:17.000Z');
    expect(text.startsWith('@Builder ')).toBe(true);
    expect(text).toContain('restarted after an unexpected shutdown at');
    expect(text).toContain(formatShutdownTime('2026-09-28T01:40:17.000Z'));
    expect(text).toContain('logs/handoff.md');
    expect(text).toContain('Do not re-answer');
  });

  it('keeps an unparseable timestamp verbatim instead of printing Invalid Date', () => {
    expect(formatShutdownTime('not-a-date')).toBe('not-a-date');
    expect(buildRestartResumeText('Vala', 'not-a-date')).not.toContain('Invalid Date');
  });

  it('lists unanswered mentions when there are some, and omits the section when there are none (BUG-55)', () => {
    const plain = buildRestartResumeText('Builder', '2026-09-28T01:40:17.000Z', []);
    expect(plain).not.toContain('arrived just before you stopped');

    const withList = buildRestartResumeText('Builder', '2026-09-28T01:40:17.000Z', [
      { from: 'You', content: 'hi builder' },
    ]);
    expect(withList).toContain('arrived just before you stopped');
    // The sender is given as a name token plus the exact reply command, so "You" is not read as the pronoun (BUG-56).
    expect(withList).toContain('[You]');
    expect(withList).toContain('--to "You"');
    expect(withList).toContain('hi builder');
  });
});

// Minimal message factory — the detector only reads from.id/name, mentions, recipients, timestamp, metadata.client.kind.
const msg = (over: Partial<CollabMessage> & { timestamp: string }): CollabMessage =>
  ({ id: over.id ?? `m-${over.timestamp}`, channelId: 'c', content: '', ...over } as CollabMessage);

const PID = 'p-builder';

describe('unansweredMentions', () => {
  it('returns a mention the agent received but never posted after (the BUG-55 crash case)', () => {
    const messages = [
      msg({ timestamp: '2026-10-30T23:49:05Z', from: { id: 'p-ada', name: 'Ada', type: 'user' } as CollabMessage['from'], mentions: [PID], content: '@Builder hello' }),
      // agent crashed before posting anything — no message from PID
    ];
    const out = unansweredMentions(messages, PID);
    expect(out).toEqual([{ from: 'Ada', content: '@Builder hello' }]);
  });

  it('treats a mention as answered once the agent posts after it', () => {
    const messages = [
      msg({ timestamp: '2026-10-30T23:49:05Z', from: { id: 'p-ada', name: 'Ada', type: 'user' } as CollabMessage['from'], mentions: [PID], content: 'q1' }),
      msg({ timestamp: '2026-10-30T23:49:20Z', from: { id: PID, name: 'Builder', type: 'agent' } as CollabMessage['from'], content: 'answer' }),
    ];
    expect(unansweredMentions(messages, PID)).toEqual([]);
  });

  it('lists only mentions after the agent\'s last post, and counts recipients-targeting too', () => {
    const messages = [
      msg({ timestamp: '2026-10-30T23:40:00Z', from: { id: 'p-ada', name: 'Ada', type: 'user' } as CollabMessage['from'], mentions: [PID], content: 'old, already answered' }),
      msg({ timestamp: '2026-10-30T23:41:00Z', from: { id: PID, name: 'Builder', type: 'agent' } as CollabMessage['from'], content: 'replied' }),
      msg({ timestamp: '2026-10-30T23:42:00Z', from: { id: 'p-kai', name: 'Kai', type: 'agent' } as CollabMessage['from'], recipients: [PID], content: 'targeted follow-up' }),
    ];
    expect(unansweredMentions(messages, PID)).toEqual([{ from: 'Kai', content: 'targeted follow-up' }]);
  });

  it('ignores earlier restart notices and the agent\'s own messages', () => {
    const messages = [
      msg({ timestamp: '2026-10-30T23:49:00Z', from: { id: 'system', name: 'System', type: 'user' } as CollabMessage['from'], mentions: [PID], content: 'prior restart notice', metadata: { client: { kind: 'devflow.restart-resume' } } }),
      msg({ timestamp: '2026-10-30T23:49:30Z', from: { id: PID, name: 'Builder', type: 'agent' } as CollabMessage['from'], mentions: [PID], content: 'self' }),
    ];
    expect(unansweredMentions(messages, PID)).toEqual([]);
  });

  it('caps and orders the list, newest kept, oldest first', () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      msg({ timestamp: `2026-10-30T23:5${i}:00Z`, from: { id: 'p-ada', name: 'Ada', type: 'user' } as CollabMessage['from'], mentions: [PID], content: `q${i}` }),
    );
    const out = unansweredMentions(messages, PID, 3);
    expect(out.map(m => m.content)).toEqual(['q5', 'q6', 'q7']);
  });
});
