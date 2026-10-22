import { describe, it, expect } from 'vitest';
import {
  filterHiddenMessages,
  countHiddenMessages,
  formatCrossChannelMessageForHumans,
  crossChannelReplyTarget,
  splitCrossChannelHeader,
} from '../../lib/hidden-messages';

type Msg = { id: string; content?: string; metadata?: { isHidden?: boolean; crossChannel?: Record<string, unknown>; [key: string]: unknown } };

const msg = (id: string, isHidden?: boolean): Msg => ({
  id,
  metadata: isHidden !== undefined ? { isHidden } : undefined,
});

describe('filterHiddenMessages', () => {
  it('returns all messages when showHidden is true', () => {
    const msgs = [msg('a', true), msg('b', false), msg('c')];
    expect(filterHiddenMessages(msgs, true)).toEqual(msgs);
  });

  it('removes messages where isHidden === true when showHidden is false', () => {
    const msgs = [msg('a', true), msg('b', false), msg('c')];
    const result = filterHiddenMessages(msgs, false);
    expect(result).toHaveLength(2);
    expect(result.map(m => m.id)).toEqual(['b', 'c']);
  });

  it('keeps messages with no metadata when showHidden is false', () => {
    const msgs = [msg('a'), msg('b', false)];
    expect(filterHiddenMessages(msgs, false)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(filterHiddenMessages([], false)).toEqual([]);
    expect(filterHiddenMessages([], true)).toEqual([]);
  });

  it('returns all messages when none are hidden', () => {
    const msgs = [msg('a', false), msg('b'), msg('c', false)];
    expect(filterHiddenMessages(msgs, false)).toHaveLength(3);
  });

  it('removes multiple hidden messages', () => {
    const msgs = [msg('a', true), msg('b', true), msg('c', false), msg('d', true)];
    const result = filterHiddenMessages(msgs, false);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c');
  });

  it('keeps cross-channel messages visible even when a legacy record is marked hidden', () => {
    const transport: Msg = { id: 'transport', metadata: { crossChannel: { sourceChannelId: 'source' } } };
    const legacyTransport: Msg = { id: 'legacy', metadata: { isHidden: true, crossChannel: { sourceChannelId: 'source' } } };
    const visible = msg('visible');

    expect(filterHiddenMessages([transport, legacyTransport, visible], false)).toEqual([transport, legacyTransport, visible]);
    expect(filterHiddenMessages([transport, legacyTransport, visible], true)).toEqual([transport, legacyTransport, visible]);
  });
});

describe('formatCrossChannelMessageForHumans', () => {
  it('strips the routing envelope and renders a compact from/to record', () => {
    const transport: Msg = {
      id: 'transport',
      content: '[Cross-channel delivery via the DevFlow Cross-Channel API]\n\nReply routing: internal\nOriginal cross-channel message:\n@Riley API test',
      metadata: {
        crossChannel: {
          senderName: 'Builder',
          sourceChannelName: 'SG-1',
          deliveryChannelName: 'Commander',
        },
      },
    };

    expect(formatCrossChannelMessageForHumans(transport).content).toBe(
      '**Cross-channel message · Builder (SG-1) → Riley (Commander)**\n\n@Riley API test',
    );
  });

  it('is idempotent: a message the server already formatted gets one header, not two', () => {
    const transport: Msg = {
      id: 'transport',
      content: '[envelope]\nOriginal cross-channel message:\n@Architect done',
      metadata: { crossChannel: { senderName: 'Dave', sourceChannelName: 'Zoho Books Integration', deliveryChannelName: 'LedgerOS' } },
    };
    const once = formatCrossChannelMessageForHumans(transport);
    const twice = formatCrossChannelMessageForHumans(once);
    expect(twice.content).toBe(once.content);
    expect(once.content.match(/Cross-channel message ·/g)).toHaveLength(1);
  });
});

describe('countHiddenMessages', () => {
  it('returns 0 for empty array', () => {
    expect(countHiddenMessages([])).toBe(0);
  });

  it('returns 0 when no messages are hidden', () => {
    expect(countHiddenMessages([msg('a', false), msg('b')])).toBe(0);
  });

  it('counts messages where isHidden === true', () => {
    const msgs = [msg('a', true), msg('b', true), msg('c', false), msg('d')];
    expect(countHiddenMessages(msgs)).toBe(2);
  });

  it('counts all messages when all are hidden', () => {
    const msgs = [msg('a', true), msg('b', true)];
    expect(countHiddenMessages(msgs)).toBe(2);
  });

  it('does not advertise cross-channel transport as revealable hidden chat', () => {
    const transport: Msg = {
      id: 'transport',
      metadata: { isHidden: true, crossChannel: { sourceChannelId: 'source' } },
    };
    expect(countHiddenMessages([transport, msg('hidden', true)])).toBe(1);
  });
});

describe('cross-channel reply target', () => {
  const incoming: Msg = {
    id: 'x',
    content: '[envelope]\nOriginal cross-channel message:\n@Dave invoice found',
    metadata: { crossChannel: {
      sourceChannelId: 'acm', sourceChannelName: 'ACME Portal', deliveryChannelName: 'Signal',
      senderId: 'jack-acm', senderName: 'Dave', targetParticipantName: 'Dave',
    } },
  };

  it('addresses the sending agent in its own channel', () => {
    expect(crossChannelReplyTarget(incoming, 'signal')).toEqual({
      channelId: 'acm', channelName: 'ACME Portal', participantId: 'jack-acm', participantName: 'Dave',
    });
  });

  it('is not offered in the source channel or for ordinary messages', () => {
    expect(crossChannelReplyTarget(incoming, 'acm')).toBeNull();
    expect(crossChannelReplyTarget(msg('plain'), 'signal')).toBeNull();
  });

  it('splits the human header from the body of a formatted message', () => {
    const formatted = formatCrossChannelMessageForHumans(incoming);
    expect(splitCrossChannelHeader(formatted.content!)).toEqual({
      header: 'Cross-channel message · Dave (ACME Portal) → Dave (Signal)',
      body: '@Dave invoice found',
    });
    expect(splitCrossChannelHeader('**Bold** text')).toBeNull();
  });
});
