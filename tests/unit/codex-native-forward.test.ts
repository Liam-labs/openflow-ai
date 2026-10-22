import { describe, expect, it, vi } from 'vitest';

import { createCodexNativeReplyForwarder } from '@/lib/codex-native-forward';

describe('Codex Native outbound forwarding', () => {
  it('uses explicit mention handles to route a native reply to channel participants', async () => {
    const original = {
      id: 'origin-system', channelId: 'channel-1',
      from: { id: 'system', name: 'System', type: 'user' },
      content: 'Onboarding primer', timestamp: '2026-08-28T00:00:00.000Z',
    };
    const participant = { id: 'codex-native-1', name: 'Codex', type: 'codex' };
    const channel = {
      id: 'channel-1', name: 'Drone Hub',
      participants: [
        original.from,
        participant,
        { id: 'owner', name: 'Owner', type: 'user' },
        { id: 'jack', name: 'Jack', type: 'codex' },
      ],
    };
    const appendIfAbsent = vi.fn(async (_channelId, message) => ({ message, appended: true }));
    const forward = createCodexNativeReplyForwarder({
      transactOutbound: vi.fn(async (_input, operation) => {
        const resolution = {
          channelId: 'channel-1', participantId: participant.id, bindingId: 'binding-1',
          nativeThreadId: 'thread-1', originMessageId: original.id,
          replyToMessageId: original.id, outboundIdempotencyKey: 'session-1:turn-mentions',
        };
        return { resolution, result: await operation(resolution) };
      }),
      getChannel: vi.fn(async () => channel as never),
      findOriginal: vi.fn(async () => original as never),
      appendIfAbsent,
      prepareDelivery: vi.fn(), enqueueDelivery: vi.fn(), emitMessage: vi.fn(),
      deliverMessage: vi.fn(), touchChannel: vi.fn(),
      now: () => new Date('2026-08-28T00:01:00.000Z'),
    });

    await forward({
      nativeSessionId: 'session-1', turnId: 'turn-mentions',
      outboundCorrelationId: 'correlation-mentions',
      content: 'Hello @Owner and @Jack.',
    });

    expect(appendIfAbsent).toHaveBeenCalledWith('channel-1', expect.objectContaining({
      mentions: ['owner', 'jack'],
      recipients: ['owner', 'jack'],
      metadata: expect.objectContaining({ deliveryMode: 'targeted' }),
    }));
  });

  it('does not commit correlation when the participant is absent and succeeds after rejoin', async () => {
    const participant = { id: 'codex-native-1', name: 'Codex Native', type: 'codex' };
    const original = {
      id: 'origin-rejoin',
      channelId: 'channel-1',
      from: { id: 'owner', name: 'Owner', type: 'user' },
      content: 'Question',
      timestamp: '2026-08-11T00:00:00.000Z',
    };
    const channel = { id: 'channel-1', name: 'Bridge', participants: [original.from] };
    let commits = 0;
    const transactOutbound = vi.fn(async (_input, operation) => {
      const resolution = {
        channelId: 'channel-1',
        participantId: 'codex-native-1',
        bindingId: 'binding-1',
        nativeThreadId: 'thread-1',
        originMessageId: 'origin-rejoin',
        replyToMessageId: 'origin-rejoin',
        outboundIdempotencyKey: 'session-1:turn-1',
      };
      const result = await operation(resolution);
      commits += 1;
      return { resolution, result };
    });
    const appendIfAbsent = vi.fn(async (_channelId, message) => ({ message, appended: true }));
    const forward = createCodexNativeReplyForwarder({
      transactOutbound,
      getChannel: vi.fn(async () => channel as never),
      findOriginal: vi.fn(async () => original as never),
      appendIfAbsent,
      prepareDelivery: vi.fn(),
      enqueueDelivery: vi.fn(),
      emitMessage: vi.fn(),
      deliverMessage: vi.fn(),
      touchChannel: vi.fn(),
      now: () => new Date('2026-08-11T00:01:00.000Z'),
    } as never);

    await expect(forward({
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: 'Answer',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_PARTICIPANT_NOT_FOUND' });
    expect(commits).toBe(0);
    expect(appendIfAbsent).not.toHaveBeenCalled();

    channel.participants.push(participant as never);
    await expect(forward({
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: 'Answer',
    })).resolves.toMatchObject({ replyToMessageId: 'origin-rejoin' });
    expect(commits).toBe(1);
    expect(appendIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('keeps append failure retryable and deduplicates after transactional commit', async () => {
    const original = {
      id: 'origin-retry', channelId: 'channel-1',
      from: { id: 'owner', name: 'Owner', type: 'user' },
      content: 'Question', timestamp: '2026-08-11T00:00:00.000Z',
    };
    const participant = { id: 'codex-native-1', name: 'Codex Native', type: 'codex' };
    const channel = { id: 'channel-1', name: 'Bridge', participants: [original.from, participant] };
    let commits = 0;
    const transactOutbound = vi.fn(async (_input, operation) => {
      const resolution = {
        channelId: 'channel-1', participantId: participant.id, bindingId: 'binding-1',
        nativeThreadId: 'thread-1', originMessageId: original.id,
        replyToMessageId: original.id, outboundIdempotencyKey: 'session-1:turn-retry',
      };
      const result = await operation(resolution);
      commits += 1;
      return { resolution, result };
    });
    let appendAttempts = 0;
    const stored = new Map();
    const appendIfAbsent = vi.fn(async (_channelId, message) => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error('disk unavailable');
      const existing = stored.get(message.id);
      if (existing) return { message: existing, appended: false };
      stored.set(message.id, message);
      return { message, appended: true };
    });
    const forward = createCodexNativeReplyForwarder({
      transactOutbound,
      getChannel: vi.fn(async () => channel as never),
      findOriginal: vi.fn(async () => original as never),
      appendIfAbsent,
      prepareDelivery: vi.fn(), enqueueDelivery: vi.fn(), emitMessage: vi.fn(),
      deliverMessage: vi.fn(), touchChannel: vi.fn(),
      now: () => new Date('2026-08-11T00:01:00.000Z'),
    } as never);
    const input = {
      nativeSessionId: 'session-1', turnId: 'turn-retry',
      outboundCorrelationId: 'correlation-retry', content: 'Answer',
    };

    await expect(forward(input)).rejects.toThrow('disk unavailable');
    expect(commits).toBe(0);
    const delivered = await forward(input);
    const duplicate = await forward(input);
    expect(commits).toBe(2);
    expect(stored.size).toBe(1);
    expect(delivered.deduplicated).toBe(false);
    expect(duplicate).toMatchObject({ messageId: delivered.messageId, deduplicated: true });
  });
  it('routes to the original message and appends one deterministic reply across retries', async () => {
    const stored = new Map<string, Record<string, unknown>>();
    const emitted: string[] = [];
    const delivered: string[] = [];
    const enqueued: string[] = [];
    const original = {
      id: 'origin-1',
      channelId: 'channel-1',
      from: { id: 'owner', name: 'Owner', type: 'user' },
      content: 'Question for Codex',
      timestamp: '2026-08-09T00:00:00.000Z',
    };
    const channel = {
      id: 'channel-1',
      name: 'Bridge test',
      participants: [
        original.from,
        { id: 'codex-native-1', name: 'Codex Native', type: 'codex' },
      ],
    };
    const forward = createCodexNativeReplyForwarder({
      transactOutbound: vi.fn(async (_input, operation) => {
        const resolution = {
          channelId: 'channel-1',
          participantId: 'codex-native-1',
          bindingId: 'binding-1',
          nativeThreadId: 'thread-1',
          originMessageId: 'origin-1',
          replyToMessageId: 'origin-1',
          outboundIdempotencyKey: 'session-1:turn-1',
        };
        return { resolution, result: await operation(resolution) };
      }),
      getChannel: vi.fn(async () => channel as never),
      findOriginal: vi.fn(async () => original as never),
      appendIfAbsent: vi.fn(async (_channelId, message) => {
        const existing = stored.get(message.id);
        if (existing) return { message: existing, appended: false } as never;
        stored.set(message.id, message as unknown as Record<string, unknown>);
        return { message, appended: true };
      }),
      prepareDelivery: vi.fn(),
      enqueueDelivery: vi.fn(async (_sender, message) => { enqueued.push(message.id); }),
      emitMessage: vi.fn((_channel, message) => { emitted.push(message.id); }),
      deliverMessage: vi.fn((_sender, message) => { delivered.push(message.id); }),
      touchChannel: vi.fn(),
      now: () => new Date('2026-08-09T00:01:00.000Z'),
    });

    const input = {
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: 'correlation-1',
      content: 'Final answer',
    };
    const first = await forward(input);
    const retry = await forward(input);

    expect(stored.size).toBe(1);
    expect(first.messageId).toBe(retry.messageId);
    expect(first).toMatchObject({
      replyToMessageId: 'origin-1',
      outboundIdempotencyKey: 'session-1:turn-1',
      deduplicated: false,
    });
    expect(retry.deduplicated).toBe(true);
    expect([...stored.values()][0]).toMatchObject({
      from: { id: 'codex-native-1' },
      content: 'Final answer',
      recipients: ['owner'],
      replyTo: { id: 'origin-1' },
      metadata: {
        client: {
          kind: 'codex-native.outbound',
          outboundIdempotencyKey: 'session-1:turn-1',
          originMessageId: 'origin-1',
          nativeThreadId: 'thread-1',
        },
      },
    });
    expect(enqueued).toEqual([first.messageId, first.messageId]);
    expect(emitted).toEqual([first.messageId]);
    expect(delivered).toEqual([first.messageId]);
  });

  it('rejects empty and oversized replies before resolving routing', async () => {
    const transactOutbound = vi.fn();
    const forward = createCodexNativeReplyForwarder({ transactOutbound } as never);

    await expect(forward({ nativeSessionId: 's1', turnId: 't1', outboundCorrelationId: 'c1', content: ' ' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(forward({ nativeSessionId: 's1', turnId: 't1', outboundCorrelationId: 'c1', content: 'x'.repeat(100_001) }))
      .rejects.toMatchObject({ statusCode: 413 });
    await expect(forward({ nativeSessionId: 's1', turnId: 't1', outboundCorrelationId: 'c1', content: '€'.repeat(40_000) }))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(transactOutbound).not.toHaveBeenCalled();
  });
});
