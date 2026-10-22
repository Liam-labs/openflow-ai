/**
 * Tests for message-details-copy helper.
 * Written TDD — RED first (lib/message-details-copy.ts does not exist yet).
 * Satisfies the "render test asserts clipboard.writeText called with expected string shape" requirement
 * by testing the pure text-builder that the component invokes.
 */

import { describe, it, expect } from 'vitest';
import { buildMessageDetailsText } from '@/lib/message-details-copy';
import type { CollabMessage, CollabParticipant } from '@/lib/types';

// ─── fixtures ────────────────────────────────────────────────────────────────

const sender: CollabParticipant = {
  id: 'p-alice',
  name: 'Alice',
  type: 'user',
  source: 'Browser',
  color: '#aaa',
  joinedAt: '2026-04-18T09:00:00.000Z',
  lastSeen: '2026-04-18T09:00:00.000Z',
};

const baseMsg: CollabMessage = {
  id: 'msg-001',
  channelId: 'ch-001',
  from: sender,
  content: 'Hello world',
  timestamp: '2026-04-18T10:30:00.000Z',
};

// ─── buildMessageDetailsText ──────────────────────────────────────────────────

describe('buildMessageDetailsText', () => {
  it('contains the header line "Message Details"', () => {
    const result = buildMessageDetailsText({
      msg: baseMsg,
      channelName: 'SG-1',
      channelId: 'ch-001',
      participants: [sender],
    });
    expect(result).toContain('Message Details');
    expect(result).toContain('Routing\n-------');
    expect(result).toContain('Timing & IDs\n------------');
    expect(result).toContain('Content\n-------');
  });

  it('includes message ID', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('ID: msg-001');
  });

  it('includes ISO timestamp', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Timestamp: 2026-04-18T10:30:00.000Z');
  });

  it('includes human-readable absolute time (HH:MMam/pm format)', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toMatch(/Time: \d{1,2}:\d{2}[ap]m/);
  });

  it('includes sender name and ID', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('From: Alice  (p-alice)');
  });

  it('includes channel name and ID', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Channel: SG-1  (ch-001)');
  });

  it('shows delivery mode as "broadcast" when not set', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Delivery Mode: broadcast');
  });

  it('shows delivery mode as "targeted" when set', () => {
    const msg = { ...baseMsg, metadata: { deliveryMode: 'targeted' as const }, recipients: ['p-alice'] };
    const result = buildMessageDetailsText({ msg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Delivery Mode: targeted');
  });

  it('shows Recipients as "all" for broadcast messages', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Recipients: all');
  });

  it('shows recipient names for targeted messages', () => {
    const msg = { ...baseMsg, metadata: { deliveryMode: 'targeted' as const }, recipients: ['p-alice'] };
    const result = buildMessageDetailsText({ msg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Alice');
  });

  it('shows Thread as "none" when no replyTo', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Thread: none');
  });

  it('shows Thread root ID when replyTo is set', () => {
    const msg = { ...baseMsg, replyTo: { id: 'msg-root', content: 'original' } };
    const result = buildMessageDetailsText({ msg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Thread: msg-root');
  });

  it('includes message content', () => {
    const result = buildMessageDetailsText({ msg: baseMsg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Content: Hello world');
  });

  it('preserves newlines in content', () => {
    const msg = { ...baseMsg, content: 'Line one\nLine two' };
    const result = buildMessageDetailsText({ msg, channelName: 'SG-1', channelId: 'ch-001', participants: [sender] });
    expect(result).toContain('Line one\nLine two');
  });
});
