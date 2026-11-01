import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  DELIVERY_PROTOCOL,
  MAX_DELIVERY_ATTEMPTS,
  claimDelivery,
  enqueueDurableDeliveries,
  getDeliveryRecords,
  releaseDelivery,
  renewDelivery,
  requeueDelivery,
  quarantineChannelNonTerminalDeliveries,
  quarantineStalePendingDeliveries,
  settleTimedOutDelivery,
  transitionDelivery,
} from '@/lib/collab-delivery-ledger';
import type { CollabChannel, CollabMessage, CollabParticipant } from '@/lib/types';

let appDataDir = '';

function participant(overrides: Partial<CollabParticipant>): CollabParticipant {
  return {
    id: 'participant',
    name: 'Participant',
    type: 'codex',
    source: 'test',
    joinedAt: '2026-07-19T00:00:00.000Z',
    lastSeen: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function fixture(): { channel: CollabChannel; message: CollabMessage } {
  const sender = participant({ id: 'user-owner', name: 'Owner', type: 'user' });
  const durable = participant({
    id: 'roster-architect',
    name: 'Architect',
    deliveryProtocol: DELIVERY_PROTOCOL,
  });
  const legacyCodex = participant({ id: 'roster-jack', name: 'Jack' });
  const claude = participant({
    id: 'roster-reynolds',
    name: 'Reynolds',
    type: 'claude',
    deliveryProtocol: DELIVERY_PROTOCOL,
  });
  const channel = {
    id: 'channel-1',
    name: 'SG-1',
    createdAt: '2026-07-19T00:00:00.000Z',
    lastActivity: '2026-07-19T00:00:00.000Z',
    participants: [sender, durable, legacyCodex, claude],
    messages: [],
    settings: { autoRespond: false },
  } satisfies CollabChannel;
  const message = {
    id: 'message-1',
    channelId: channel.id,
    from: sender,
    content: '@Architect durable hello',
    timestamp: '2026-07-19T00:00:01.000Z',
    recipients: [durable.id],
    metadata: { deliveryMode: 'targeted' },
  } satisfies CollabMessage;
  return { channel, message };
}

beforeEach(async () => {
  appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-delivery-ledger-'));
  process.env.DEVFLOW_APP_DATA_DIR = appDataDir;
});

afterEach(async () => {
  delete process.env.DEVFLOW_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true });
});

describe('durable collab delivery ledger', () => {
  it('uses the three-attempt operational retry ceiling', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(3);
  });

  it('creates one server record only for an opted-in Codex recipient', async () => {
    const { channel, message } = fixture();

    const created = await enqueueDurableDeliveries(message.from.id, message, channel);
    const records = await getDeliveryRecords({ channelId: channel.id });

    expect(created).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      channelId: channel.id,
      participantId: 'roster-architect',
      messageId: message.id,
      state: 'pending',
    });
    expect(records[0].token).toBe(
      '[[collab-delivery:roster-architect:message-1]]'
    );
    expect(message.metadata?.durableDelivery).toBe(DELIVERY_PROTOCOL);
  });

  it('allows only one wrapper to win an atomic claim', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);

    const claims = await Promise.all([
      claimDelivery({ channelId: channel.id, participantId: 'roster-architect', ownerId: 'wrapper-a' }),
      claimDelivery({ channelId: channel.id, participantId: 'roster-architect', ownerId: 'wrapper-b' }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.state).toBe('leased');
  });

  it('suppresses reinjection only after exact ingestion acknowledgement', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    const claim = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-a',
    });
    expect(claim).not.toBeNull();

    const submitted = await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'submitted',
    });
    expect(submitted.state).toBe('submitted');

    const ingested = await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'ingested',
      transcriptPath: '/tmp/owned-rollout.jsonl',
      transcriptByte: 123,
    });
    expect(ingested.state).toBe('ingested');
    expect((await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'ingested',
      transcriptPath: '/tmp/owned-rollout.jsonl',
      transcriptByte: 123,
    })).state).toBe('ingested');
    expect(await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-b',
    })).toBeNull();

    const handled = await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'handled',
    });
    expect(handled.state).toBe('handled');
    expect((await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'handled',
    })).state).toBe('handled');
  });

  it('stores handled records as slim tombstones without the message body', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    const claim = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-a',
    });
    expect(claim!.message.content).toBe(message.content);
    for (const state of ['submitted', 'ingested', 'handled'] as const) {
      await transitionDelivery({
        recordId: claim!.id,
        leaseId: claim!.lease!.id,
        ownerId: 'wrapper-a',
        state,
        ...(state === 'ingested' ? { transcriptPath: '/tmp/owned-rollout.jsonl', transcriptByte: 1 } : {}),
      });
    }
    const [record] = await getDeliveryRecords({ recordId: claim!.id, includeHandled: true });
    expect(record.state).toBe('handled');
    expect(record.message).toMatchObject({ id: message.id, timestamp: message.timestamp, content: '' });
    expect(record.message.from.id).toBe(message.from.id);
    expect(await fs.readFile(path.join(appDataDir, 'collab-delivery-ledger.json'), 'utf-8')).not.toContain(message.content);
  });

  it('reclaims a submitted delivery after its lease expires', async () => {
    // Only Date is controlled: filesystem operations and lock timers remain real.
    const start = new Date('2026-07-19T00:00:02.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    try {
      const { channel, message } = fixture();
      await enqueueDurableDeliveries(message.from.id, message, channel);
      const first = await claimDelivery({
        channelId: channel.id,
        participantId: 'roster-architect',
        ownerId: 'wrapper-a',
        leaseMs: 100,
      });
      await transitionDelivery({
        recordId: first!.id,
        leaseId: first!.lease!.id,
        ownerId: 'wrapper-a',
        state: 'submitted',
      });
      vi.setSystemTime(new Date(start.getTime() + 110));

      const reclaimed = await claimDelivery({
        channelId: channel.id,
        participantId: 'roster-architect',
        ownerId: 'wrapper-b',
      });

      expect(reclaimed?.state).toBe('leased');
      expect(reclaimed?.lease?.ownerId).toBe('wrapper-b');
      expect(reclaimed?.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews a submitted lease while a delayed Codex turn awaits transcript ingestion', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    const claim = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-a',
      leaseMs: 1_000,
    });
    await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'submitted',
    });
    const before = Date.parse(claim!.lease!.expiresAt);

    const renewed = await renewDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      leaseMs: 30_000,
    });

    expect(renewed.state).toBe('submitted');
    expect(Date.parse(renewed.lease!.expiresAt)).toBeGreaterThan(before);
  });

  it('quarantines an unproven legacy timeout without replay or false success', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    const claim = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-a',
    });
    await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'submitted',
    });

    const settled = await settleTimedOutDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      reason: 'jsonl_ingestion_timeout',
    });

    expect(settled.state).toBe('dead_letter');
    expect(settled.recoveryReason).toBe('jsonl_ingestion_timeout_dead_letter');
    expect(settled.deadLetteredAt).toBeTruthy();
    expect(await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-a',
    })).toBeNull();
  });

  it('supports explicit dup-over-drop requeue after child loss post-ingestion', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    const claim = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-a',
    });
    await transitionDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      state: 'ingested',
    });

    const pending = await requeueDelivery({
      recordId: claim!.id,
      leaseId: claim!.lease!.id,
      ownerId: 'wrapper-a',
      reason: 'child_exit_before_handled',
    });

    expect(pending.state).toBe('pending');
    expect(pending.recoveryReason).toBe('child_exit_before_handled');
  });

  it('quarantines a record at the retry ceiling for any failure reason', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);

    // Simulate the replay loop: claim + release MAX_DELIVERY_ATTEMPTS times
    // with an arbitrary failure reason. Each cycle
    // increments attempts and stamps the recovery reason.
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      const claim = await claimDelivery({
        channelId: channel.id,
        participantId: 'roster-architect',
        ownerId: `wrapper-${i}`,
      });
      expect(claim, `claim ${i} should succeed`).not.toBeNull();
      await releaseDelivery({
        recordId: claim!.id,
        leaseId: claim!.lease!.id,
        ownerId: `wrapper-${i}`,
        reason: 'future_unknown_failure',
      });
    }

    // The next claim attempt quarantines the record without claiming it.
    const exhausted = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-final',
    });
    expect(exhausted).toBeNull();

    // Verify the record was quarantined, never reported handled.
    const records = await getDeliveryRecords({
      channelId: channel.id,
      participantId: 'roster-architect',
      includeHandled: true,
    });
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe('dead_letter');
    expect(records[0].attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(records[0].recoveryReason).toBe('future_unknown_failure_dead_letter');
    expect(records[0].deadLetteredAt).toBeTruthy();
  });

  it('allows the final attempt at the retry ceiling', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);

    // Two failed attempts remain below the ceiling.
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i++) {
      const claim = await claimDelivery({
        channelId: channel.id,
        participantId: 'roster-architect',
        ownerId: `wrapper-${i}`,
      });
      await releaseDelivery({
        recordId: claim!.id,
        leaseId: claim!.lease!.id,
        ownerId: `wrapper-${i}`,
        reason: 'jsonl_ingestion_timeout',
      });
    }

    // The third and final attempt is still claimable.
    const claim = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-4',
    });
    expect(claim).not.toBeNull();
    expect(claim!.state).toBe('leased');
    expect(claim!.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  it('retires poisoned FIFO heads and claims the next valid record in one call', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      const claim = await claimDelivery({
        channelId: channel.id,
        participantId: 'roster-architect',
        ownerId: `wrapper-${i}`,
      });
      await releaseDelivery({
        recordId: claim!.id,
        leaseId: claim!.lease!.id,
        ownerId: `wrapper-${i}`,
        reason: 'tmux_send_failed',
      });
    }

    const nextMessage = { ...message, id: 'message-2', timestamp: '2026-07-19T00:00:02.000Z' };
    await enqueueDurableDeliveries(message.from.id, nextMessage, channel);
    const next = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-next',
    });

    expect(next?.messageId).toBe('message-2');
    const records = await getDeliveryRecords({ includeHandled: true });
    expect(records.find(record => record.messageId === 'message-1')?.state).toBe('dead_letter');
  });

  it('fails closed and preserves a corrupt ledger', async () => {
    const ledgerPath = path.join(appDataDir, 'collab-delivery-ledger.json');
    await fs.writeFile(ledgerPath, '{not-json', 'utf-8');
    const { channel, message } = fixture();

    await expect(enqueueDurableDeliveries(message.from.id, message, channel)).rejects.toBeTruthy();
    expect(await fs.readFile(ledgerPath, 'utf-8')).toBe('{not-json');
  });

  it('quarantines stale pending records instead of replaying old backlog', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    await new Promise(resolve => setTimeout(resolve, 5));

    const quarantined = await quarantineStalePendingDeliveries(1);

    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      state: 'dead_letter',
      recoveryReason: 'stale_pending_expired',
    });
  });

  it('keeps a live busy recipient queue pending until the live backstop', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    await new Promise(resolve => setTimeout(resolve, 5));

    const live = () => true;
    expect(await quarantineStalePendingDeliveries(1, { isRecipientLive: live })).toHaveLength(0);
    const claimed = await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'codex:roster-architect:1',
    });
    expect(claimed).toMatchObject({ messageId: message.id, attempts: 1 });
  });

  it('quarantines a live recipient queue past the live backstop', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    await new Promise(resolve => setTimeout(resolve, 5));

    const quarantined = await quarantineStalePendingDeliveries(1, {
      isRecipientLive: () => true,
      liveMaxAgeMs: 1,
    });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].recoveryReason).toBe('stale_pending_expired');
  });

  it('quarantines one channel non-terminal queue without touching another channel', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    await enqueueDurableDeliveries(message.from.id, {
      ...message,
      id: 'message-2',
    }, channel);
    await claimDelivery({
      channelId: channel.id,
      participantId: 'roster-architect',
      ownerId: 'wrapper-a',
    });
    const otherChannel = { ...channel, id: 'channel-2' };
    await enqueueDurableDeliveries(message.from.id, {
      ...message,
      id: 'other-message',
      channelId: otherChannel.id,
    }, otherChannel);

    const quarantined = await quarantineChannelNonTerminalDeliveries(
      channel.id,
      'operator_signal_queue_reset',
    );

    expect(quarantined).toHaveLength(2);
    expect(quarantined.every(record => record.state === 'dead_letter')).toBe(true);
    expect(quarantined.every(record => record.recoveryReason === 'operator_signal_queue_reset')).toBe(true);
    await expect(getDeliveryRecords({ channelId: otherChannel.id }))
      .resolves.toEqual([expect.objectContaining({ state: 'pending' })]);
  });

  it('retains recent terminal tombstones beyond the compaction cap so reconciliation cannot replay them', async () => {
    const { channel, message } = fixture();
    const now = new Date().toISOString();
    const protectedMessage = { ...message, id: 'protected-message', timestamp: now };
    const ledgerPath = path.join(appDataDir, 'collab-delivery-ledger.json');
    const records = Array.from({ length: 2_001 }, (_, index) => {
      const current = index === 0
        ? protectedMessage
        : { ...message, id: `terminal-${index}`, timestamp: now };
      return {
        id: `${channel.id}:roster-architect:${current.id}`,
        channelId: channel.id,
        participantId: 'roster-architect',
        messageId: current.id,
        protocol: DELIVERY_PROTOCOL,
        token: `[[collab-delivery:roster-architect:${current.id}]]`,
        state: 'handled',
        message: current,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        handledAt: now,
      };
    });
    await fs.writeFile(ledgerPath, JSON.stringify({ version: 1, records, lastUpdated: now }), 'utf8');

    await enqueueDurableDeliveries(message.from.id, {
      ...message,
      id: 'trigger-compaction',
      timestamp: now,
    }, channel);
    const replay = await enqueueDurableDeliveries(message.from.id, protectedMessage, channel);

    expect(replay).toHaveLength(1);
    expect(replay[0].state).toBe('handled');
    const protectedRecords = (await getDeliveryRecords({ includeHandled: true }))
      .filter(record => record.messageId === protectedMessage.id);
    expect(protectedRecords).toHaveLength(1);
  });
});

describe('queued message bundling', () => {
  async function queue(contents: string[]) {
    const { channel, message } = fixture();
    for (const [index, content] of contents.entries()) {
      await enqueueDurableDeliveries(message.from.id, {
        ...message,
        id: `message-${index + 1}`,
        content,
        mentions: ['roster-architect'],
        timestamp: `2026-07-19T00:00:0${index + 1}.000Z`,
      }, channel);
    }
    return channel;
  }
  const claimFor = (channelId: string, ownerId = 'wrapper-a', leaseMs?: number) =>
    claimDelivery({ channelId, participantId: 'roster-architect', ownerId, leaseMs });

  it('carries every queued message in one turn and settles them with the carrier', async () => {
    const channel = await queue(['first', 'second', 'third, which corrects second']);
    const claim = await claimFor(channel.id);
    expect(claim?.messageId).toBe('message-1');
    expect(claim?.message.content).toContain('first');
    expect(claim?.message.content).toContain('2 more messages arrived while you were busy');
    expect(claim?.message.content).toContain('[Channel message from Owner in this channel]: second\n(@you)');
    expect(claim?.message.content.indexOf('second')).toBeLessThan(claim!.message.content.indexOf('third'));
    expect(claim?.message.timestamp).toBe('2026-07-19T00:00:03.000Z');
    const folded = (await getDeliveryRecords({ channelId: channel.id })).filter(record => record.state === 'bundled');
    expect(folded.map(record => record.messageId)).toEqual(['message-2', 'message-3']);
    expect(await claimFor(channel.id, 'wrapper-b')).toBeNull();

    for (const state of ['submitted', 'ingested', 'handled'] as const) {
      await transitionDelivery({ recordId: claim!.id, leaseId: claim!.lease!.id, ownerId: 'wrapper-a', state });
    }
    const records = await getDeliveryRecords({ channelId: channel.id });
    expect(records.map(record => record.state)).toEqual(['handled', 'handled', 'handled']);
    expect(await claimFor(channel.id)).toBeNull();
  });

  it('returns folded messages to the queue and restores the carrier when it is replayed', async () => {
    const channel = await queue(['first', 'second']);
    const claim = await claimFor(channel.id, 'wrapper-a', 100);
    expect(claim?.message.content).toContain('second');
    await requeueDelivery({
      recordId: claim!.id, leaseId: claim!.lease!.id, ownerId: 'wrapper-a', reason: 'child_died_before_submit',
    });
    const afterRequeue = await getDeliveryRecords({ channelId: channel.id });
    expect(afterRequeue.map(record => record.state)).toEqual(['pending', 'pending']);
    expect(afterRequeue[0].message.content).toBe('first');
    expect(afterRequeue[0].bundle).toBeUndefined();

    const again = await claimFor(channel.id, 'wrapper-b', 100);
    expect(again?.messageId).toBe('message-1');
    expect(again?.message.content).toContain('1 more message arrived');
    await new Promise(resolve => setTimeout(resolve, 110));
    const afterExpiry = await claimFor(channel.id, 'wrapper-c');
    expect(afterExpiry?.messageId).toBe('message-1');
    expect(afterExpiry?.message.content.match(/second/g)).toHaveLength(1);
  });

  it('dead-letters folded messages with their carrier', async () => {
    const channel = await queue(['first', 'second']);
    const claim = await claimFor(channel.id);
    await settleTimedOutDelivery({ recordId: claim!.id, leaseId: claim!.lease!.id, ownerId: 'wrapper-a', reason: 'jsonl_ingestion_timeout' });
    const records = await getDeliveryRecords({ channelId: channel.id });
    expect(records.map(record => record.state)).toEqual(['dead_letter', 'dead_letter']);
    expect(records[1].recoveryReason).toMatch(/^bundled_with:/);
  });

  it('never folds voice turns', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, { ...message, id: 'message-1', content: 'first' }, channel);
    await enqueueDurableDeliveries(message.from.id, {
      ...message, id: 'voice-1', content: 'spoken', timestamp: '2026-07-19T00:00:02.000Z',
      metadata: { voice: { kind: 'riley.voice.turn' } },
    } as CollabMessage, channel);
    const claim = await claimFor(channel.id);
    expect(claim?.message.content).toBe('first');
    expect((await getDeliveryRecords({ channelId: channel.id }))[1].state).toBe('pending');
  });
});

describe('delivery ledger snapshot cache', () => {
  const ledgerPath = () => path.join(appDataDir, 'collab-delivery-ledger.json');
  const claimInput = { channelId: 'channel-1', participantId: 'roster-architect', ownerId: 'wrapper-a' };

  it('answers an idle claim without rewriting the ledger', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    expect((await claimDelivery(claimInput))?.state).toBe('leased');
    const before = await fs.stat(ledgerPath());

    // A recipient with nothing queued: the common idle poll.
    expect(await claimDelivery({ ...claimInput, participantId: 'roster-reynolds', ownerId: 'wrapper-b' })).toBeNull();

    const after = await fs.stat(ledgerPath());
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('sees records written to the file by another process', async () => {
    const { channel, message } = fixture();
    await enqueueDurableDeliveries(message.from.id, message, channel);
    expect(await getDeliveryRecords({ channelId: 'channel-1' })).toHaveLength(1);

    const store = JSON.parse(await fs.readFile(ledgerPath(), 'utf-8'));
    const copy = { ...store.records[0], id: 'external-record', messageId: 'message-2' };
    store.records.push(copy);
    const tmp = `${ledgerPath()}.external`;
    await fs.writeFile(tmp, JSON.stringify(store), 'utf-8');
    await fs.rename(tmp, ledgerPath());

    const records = await getDeliveryRecords({ channelId: 'channel-1' });
    expect(records.map(record => record.id)).toContain('external-record');
    expect((await getDeliveryRecords({ recordId: 'external-record' }))[0]?.messageId).toBe('message-2');
  });
});
