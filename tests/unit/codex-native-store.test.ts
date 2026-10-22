import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CollabMessage } from '@/lib/types';
import {
  CodexNativeStoreError,
  createCodexNativeStore,
} from '@/lib/codex-native-store';
import type { CodexNativeResolveOutboundInput } from '@/lib/codex-native-store';

const tempDirs: string[] = [];

function message(
  id: string,
  recipients: string[] | undefined,
  fromId = 'sender',
  timestamp = `2026-08-09T00:00:0${id.at(-1) ?? '0'}.000Z`,
): CollabMessage {
  return {
    id,
    channelId: 'channel-1',
    from: {
      id: fromId,
      name: 'Sender',
      type: 'user',
      source: 'test',
      joinedAt: '2026-08-09T00:00:00.000Z',
      lastSeen: '2026-08-09T00:00:00.000Z',
    },
    content: `content:${id}`,
    timestamp,
    recipients,
  };
}

async function harness(messages: CollabMessage[] = [], maxDeliveries = 512) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-'));
  tempDirs.push(dir);
  let id = 0;
  const store = createCodexNativeStore({
    filePath: path.join(dir, 'state.json'),
    maxDeliveries,
    now: () => new Date(`2026-08-09T00:00:${String(id).padStart(2, '0')}.000Z`),
    randomId: () => `claim-${++id}`,
    readMessages: async (channelId) => ({
      channelId,
      messages,
      lastUpdated: '2026-08-09T00:00:00.000Z',
    }),
  });
  return store;
}

async function completeOutbound(
  store: Awaited<ReturnType<typeof harness>>,
  input: CodexNativeResolveOutboundInput,
) {
  const transaction = await store.transactOutbound(input, async () => undefined);
  return transaction.resolution;
}

const bindingInput = {
  channelId: 'channel-1',
  participantId: 'codex-native-1',
  bindingId: 'binding-1',
  nativeSessionId: 'session-1',
  nativeThreadId: 'thread-1',
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Codex Native durable binding and inbox store', () => {
  it('defaults old callers to restricted and persists an explicit live permission change', async () => {
    const store = await harness([]);
    const binding = await store.bind(bindingInput);

    expect(binding.permissionMode).toBe('restricted');
    await expect(store.setPermissionMode(
      'channel-1',
      'codex-native-1',
      'full-access',
    )).resolves.toMatchObject({ permissionMode: 'full-access' });
    await expect(store.getBinding('channel-1', 'codex-native-1')).resolves.toMatchObject({
      permissionMode: 'full-access',
    });
  });

  it('lists only active bindings for the automatic delivery monitor', async () => {
    const store = await harness([]);
    const binding = await store.bind(bindingInput);

    await expect(store.listActiveBindings()).resolves.toEqual([binding]);
    await store.unbind(binding);
    await expect(store.listActiveBindings()).resolves.toEqual([]);
  });

  it('exposes only the binding-scoped unresolved delivery for crash reconciliation', async () => {
    const store = await harness([message('m1', ['codex-native-1'])]);
    await store.bind(bindingInput);
    await store.listPending({ ...bindingInput, limit: 1 });

    await expect(store.getInFlight(bindingInput)).resolves.toBeNull();
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm1' });
    await expect(store.getInFlight(bindingInput)).resolves.toEqual(claimed);
    await store.releaseClaim({ ...bindingInput, originMessageId: 'm1' });
    await expect(store.getInFlight(bindingInput)).resolves.toBeNull();
  });

  it('passes attachment metadata to the native inbox without copying base64 payloads', async () => {
    const origin = message('m1', ['codex-native-1']);
    origin.images = [{
      data: 'data:text/markdown;base64,Zm9v',
      name: 'plan.md',
      type: 'text/markdown',
      size: 3,
      url: '/api/collab/images/m1-0.md',
    }];
    const store = await harness([origin]);
    await store.bind(bindingInput);

    const [pending] = await store.listPending({ ...bindingInput, limit: 1 });

    expect(pending.attachments).toEqual([{
      name: 'plan.md',
      type: 'text/markdown',
      size: 3,
      url: '/api/collab/images/m1-0.md',
    }]);
    expect(JSON.stringify(pending)).not.toContain('data:text/markdown;base64');
  });

  it('issues a one-time pairing code while persisting only its hash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-pairing-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'state.json');
    const ids = ['pairing-1', 'PAIR-CODE-1'];
    const store = createCodexNativeStore({
      filePath,
      now: () => new Date('2026-08-09T00:00:00.000Z'),
      randomId: () => ids.shift() ?? 'unexpected-id',
      readMessages: async (channelId) => ({ channelId, messages: [], lastUpdated: '' }),
    });

    const ticket = await store.createPairing('channel-1', 'codex-native-1', 'full-access');

    expect(ticket).toMatchObject({
      pairingId: 'pairing-1',
      pairingCode: 'PAIR-CODE-1',
      channelId: 'channel-1',
      participantId: 'codex-native-1',
      permissionMode: 'full-access',
      expiresAt: '2026-08-09T00:10:00.000Z',
    });
    const persisted = await fs.readFile(filePath, 'utf8');
    expect(persisted).not.toContain('PAIR-CODE-1');
    expect(JSON.parse(persisted).pairings[0]).toMatchObject({
      pairingId: 'pairing-1',
      channelId: 'channel-1',
      participantId: 'codex-native-1',
      permissionMode: 'full-access',
    });
  });

  it('redeems a pairing code once into the exact native-chat binding', async () => {
    const ids = ['pairing-1', 'PAIR-CODE-1', 'binding-1'];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-pairing-'));
    tempDirs.push(dir);
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => new Date('2026-08-09T00:00:00.000Z'),
      randomId: () => ids.shift() ?? 'unexpected-id',
      readMessages: async (channelId) => ({ channelId, messages: [], lastUpdated: '' }),
    });
    await store.createPairing('channel-1', 'codex-native-1', 'full-access');

    const binding = await store.redeemPairing({
      pairingCode: 'PAIR-CODE-1',
      nativeSessionId: 'session-1',
      nativeThreadId: 'thread-1',
    });

    expect(binding).toMatchObject({
      channelId: 'channel-1',
      participantId: 'codex-native-1',
      bindingId: 'binding-1',
      nativeSessionId: 'session-1',
      nativeThreadId: 'thread-1',
      permissionMode: 'full-access',
    });
    await expect(store.redeemPairing({
      pairingCode: 'PAIR-CODE-1',
      nativeSessionId: 'session-2',
      nativeThreadId: 'thread-2',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_PAIRING_INVALID', statusCode: 404 });
  });

  it('binds a selected native chat and cancels its fallback pairing atomically', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-selected-'));
    tempDirs.push(dir);
    const ids = ['pairing-1', 'PAIR-CODE-1'];
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => new Date('2026-08-09T00:00:00.000Z'),
      randomId: () => ids.shift() ?? 'unexpected-id',
      readMessages: async (channelId) => ({ channelId, messages: [], lastUpdated: '' }),
    });
    await store.createPairing('channel-1', 'codex-native-1');

    const binding = await store.bindSelected(bindingInput);

    expect(binding).toMatchObject(bindingInput);
    await expect(store.getPairing('channel-1', 'codex-native-1')).resolves.toBeNull();
    await expect(store.getBinding('channel-1', 'codex-native-1')).resolves.toEqual(binding);
  });

  it('reclaims an obsolete same-channel binding when a replacement liaison selects a chat', async () => {
    const store = await harness();
    await store.bind(bindingInput);
    const replacement = {
      ...bindingInput,
      participantId: 'codex-native-2',
      bindingId: 'binding-2',
    };

    await expect(store.bindSelected(replacement)).resolves.toMatchObject(replacement);
    await expect(store.getBinding('channel-1', 'codex-native-1')).resolves.toBeNull();
    await expect(store.getBinding('channel-1', 'codex-native-2')).resolves.toMatchObject(replacement);
  });

  it('never lets explicit selection take a native chat from another AgentChat channel', async () => {
    const store = await harness();
    await store.bind(bindingInput);

    await expect(store.bindSelected({
      ...bindingInput,
      channelId: 'channel-2',
      participantId: 'codex-native-2',
      bindingId: 'binding-2',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_BINDING_CONFLICT', statusCode: 409 });
    await expect(store.getBinding('channel-1', 'codex-native-1')).resolves.not.toBeNull();
  });

  it('refuses to replace a same-channel liaison while its native turn is claimed', async () => {
    const store = await harness([message('m1', ['codex-native-1'])]);
    await store.bind(bindingInput);
    await store.listPending({ ...bindingInput, limit: 10 });
    await store.claim({ ...bindingInput, originMessageId: 'm1' });

    await expect(store.bindSelected({
      ...bindingInput,
      participantId: 'codex-native-2',
      bindingId: 'binding-2',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_CLAIM_CONFLICT', statusCode: 409 });
    await expect(store.getBinding('channel-1', 'codex-native-1')).resolves.not.toBeNull();
    await expect(store.getBinding('channel-1', 'codex-native-2')).resolves.toBeNull();
  });

  it('expires pairing codes and never creates a binding from them', async () => {
    let clock = new Date('2026-08-09T00:00:00.000Z');
    const ids = ['pairing-1', 'PAIR-CODE-1'];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-pairing-'));
    tempDirs.push(dir);
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => clock,
      randomId: () => ids.shift() ?? 'unexpected-id',
      readMessages: async (channelId) => ({ channelId, messages: [], lastUpdated: '' }),
    });
    await store.createPairing('channel-1', 'codex-native-1');
    clock = new Date('2026-08-09T00:10:01.000Z');

    await expect(store.redeemPairing({
      pairingCode: 'PAIR-CODE-1',
      nativeSessionId: 'session-1',
      nativeThreadId: 'thread-1',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_PAIRING_EXPIRED', statusCode: 410 });
    expect(await store.getBinding('channel-1', 'codex-native-1')).toBeNull();
  });

  it('requires explicit unbind before a liaison can bind a different native chat', async () => {
    const store = await harness();
    const first = await store.bind(bindingInput);

    expect(await store.getBinding('channel-1', 'codex-native-1')).toEqual(first);
    await expect(store.bind({
      ...bindingInput,
      bindingId: 'binding-2',
      nativeThreadId: 'thread-2',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_BINDING_CONFLICT', statusCode: 409 });

    await store.unbind(bindingInput);
    expect(await store.getBinding('channel-1', 'codex-native-1')).toBeNull();

    const rebound = await store.bind({
      ...bindingInput,
      bindingId: 'binding-2',
      nativeThreadId: 'thread-2',
    });
    expect(rebound.nativeThreadId).toBe('thread-2');
  });

  it('abandons an unresolved native turn when the liaison is explicitly disconnected', async () => {
    const store = await harness([message('m1', ['codex-native-1'])]);
    await store.bind(bindingInput);
    await store.listPending({ ...bindingInput, limit: 10 });
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm1' });
    if (!claimed.outboundCorrelationId) throw new Error('outbound correlation missing');

    await expect(store.disconnect('channel-1', 'codex-native-1')).resolves.toMatchObject({
      bindingId: 'binding-1',
      unboundAt: expect.any(String),
    });
    expect(await store.getBinding('channel-1', 'codex-native-1')).toBeNull();

    await expect(store.transactOutbound({
      nativeSessionId: bindingInput.nativeSessionId,
      turnId: 'late-turn',
      outboundCorrelationId: claimed.outboundCorrelationId,
    }, async () => undefined)).rejects.toMatchObject({
      code: 'CODEX_NATIVE_OUTBOUND_NOT_FOUND',
      statusCode: 404,
    });

    const reboundInput = {
      ...bindingInput,
      bindingId: 'binding-2',
      nativeSessionId: 'session-2',
      nativeThreadId: 'thread-2',
    };
    await store.bind(reboundInput);
    await expect(store.listPending({ ...reboundInput, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ originMessageId: 'm1', state: 'waiting' }),
    ]);
  });

  it('still refuses disconnect while a native reply commit is in progress', async () => {
    const store = await harness([message('m1', ['codex-native-1'])]);
    await store.bind(bindingInput);
    await store.listPending({ ...bindingInput, limit: 10 });
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm1' });
    if (!claimed.outboundCorrelationId) throw new Error('outbound correlation missing');

    await expect(store.transactOutbound({
      nativeSessionId: bindingInput.nativeSessionId,
      turnId: 'turn-1',
      outboundCorrelationId: claimed.outboundCorrelationId,
    }, async () => {
      throw new Error('simulated forwarding failure');
    })).rejects.toThrow('simulated forwarding failure');

    await expect(store.disconnect('channel-1', 'codex-native-1')).rejects.toMatchObject({
      code: 'CODEX_NATIVE_CLAIM_CONFLICT',
      statusCode: 409,
    });
    expect(await store.getBinding('channel-1', 'codex-native-1')).not.toBeNull();
  });

  it('lists only messages explicitly targeted to the bound liaison', async () => {
    const store = await harness([
      message('m1', ['codex-native-1']),
      message('m2', undefined),
      message('m3', ['someone-else']),
      message('m4', ['codex-native-1'], 'codex-native-1'),
    ]);
    await store.bind(bindingInput);

    const pending = await store.listPending({
      ...bindingInput,
      limit: 10,
    });

    expect(pending).toEqual([
      expect.objectContaining({
        originMessageId: 'm1',
        content: 'content:m1',
        state: 'waiting',
        idempotencyKey: 'm1:thread-1',
      }),
    ]);
  });

  it('skips a deleted waiting origin before applying the pending limit', async () => {
    const messages = [
      message('m1', ['codex-native-1'], 'sender', '2026-08-09T00:00:01.000Z'),
    ];
    const store = await harness(messages);
    await store.bind(bindingInput);
    await expect(store.listPending({ ...bindingInput, limit: 1 })).resolves.toEqual([
      expect.objectContaining({ originMessageId: 'm1' }),
    ]);

    messages.splice(
      0,
      messages.length,
      message('m2', ['codex-native-1'], 'sender', '2026-08-09T00:00:02.000Z'),
    );

    await expect(store.listPending({ ...bindingInput, limit: 1 })).resolves.toEqual([
      expect.objectContaining({ originMessageId: 'm2' }),
    ]);
  });

  it('preserves a targeted backlog message sent before the initial native bind', async () => {
    const store = await harness([
      message('backlog-1', ['codex-native-1'], 'sender', '2026-08-08T23:59:59.000Z'),
    ]);

    await store.bind(bindingInput);

    await expect(store.listPending({ ...bindingInput, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        originMessageId: 'backlog-1',
        state: 'waiting',
      }),
    ]);
  });

  it('preserves a targeted message sent while the native chat is unbound', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-'));
    tempDirs.push(dir);
    const messages: CollabMessage[] = [];
    let clock = new Date('2026-08-09T00:00:00.000Z');
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => clock,
      randomId: () => 'claim-1',
      readMessages: async (channelId) => ({
        channelId,
        messages,
        lastUpdated: clock.toISOString(),
      }),
    });

    await store.bind(bindingInput);
    clock = new Date('2026-08-09T00:01:00.000Z');
    await store.unbind(bindingInput);
    messages.push(
      message('unbound-1', ['codex-native-1'], 'sender', '2026-08-09T00:02:00.000Z'),
    );
    clock = new Date('2026-08-09T00:03:00.000Z');
    const reboundInput = {
      ...bindingInput,
      bindingId: 'binding-2',
      nativeSessionId: 'session-2',
      nativeThreadId: 'thread-2',
    };
    await store.bind(reboundInput);

    await expect(store.listPending({ ...reboundInput, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        originMessageId: 'unbound-1',
        state: 'waiting',
      }),
    ]);
  });

  it('delivers current-binding messages before preserved historical backlog', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-'));
    tempDirs.push(dir);
    const messages = [
      message('backlog-1', ['codex-native-1'], 'sender', '2026-08-08T23:59:59.000Z'),
    ];
    let clock = new Date('2026-08-09T00:00:00.000Z');
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => clock,
      readMessages: async (channelId) => ({
        channelId,
        messages,
        lastUpdated: clock.toISOString(),
      }),
    });

    await store.bind(bindingInput);
    messages.push(
      message('onboarding-1', ['codex-native-1'], 'system', '2026-08-09T00:00:00.001Z'),
      message('current-1', ['codex-native-1'], 'sender', '2026-08-09T00:00:01.000Z'),
    );
    clock = new Date('2026-08-09T00:00:02.000Z');

    await expect(store.listPending({ ...bindingInput, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ originMessageId: 'onboarding-1' }),
      expect.objectContaining({ originMessageId: 'current-1' }),
      expect.objectContaining({ originMessageId: 'backlog-1' }),
    ]);
    await expect(store.listPending({
      ...bindingInput,
      limit: 10,
      currentBindingOnly: true,
    })).resolves.toEqual([
      expect.objectContaining({ originMessageId: 'onboarding-1' }),
      expect.objectContaining({ originMessageId: 'current-1' }),
    ]);
  });

  it('does not replay a resolved origin after rebinding to a new native thread', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-'));
    tempDirs.push(dir);
    const messages = [message('m1', ['codex-native-1'])];
    let clock = new Date('2026-08-09T00:00:00.000Z');
    let claimId = 0;
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => clock,
      randomId: () => `claim-${++claimId}`,
      readMessages: async (channelId) => ({
        channelId,
        messages,
        lastUpdated: clock.toISOString(),
      }),
    });

    await store.bind(bindingInput);
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm1' });
    if (!claimed.outboundCorrelationId) throw new Error('outbound correlation missing');
    await completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: claimed.outboundCorrelationId,
    });

    clock = new Date('2026-08-09T00:01:00.000Z');
    await store.unbind(bindingInput);
    messages.push(message('m2', ['codex-native-1'], 'sender', '2026-08-09T00:02:00.000Z'));
    clock = new Date('2026-08-09T00:03:00.000Z');
    const reboundInput = {
      ...bindingInput,
      bindingId: 'binding-2',
      nativeSessionId: 'session-2',
      nativeThreadId: 'thread-2',
    };
    await store.bind(reboundInput);

    await expect(store.listPending({ ...reboundInput, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ originMessageId: 'm2', state: 'waiting' }),
    ]);
  });

  it('moves one unresolved origin to the rebound thread without duplicating its record', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'state.json');
    const messages = [message('m1', ['codex-native-1'])];
    let clock = new Date('2026-08-09T00:00:00.000Z');
    const store = createCodexNativeStore({
      filePath,
      now: () => clock,
      readMessages: async (channelId) => ({
        channelId,
        messages,
        lastUpdated: clock.toISOString(),
      }),
    });

    await store.bind(bindingInput);
    await store.listPending({ ...bindingInput, limit: 10 });
    clock = new Date('2026-08-09T00:01:00.000Z');
    await store.unbind(bindingInput);
    clock = new Date('2026-08-09T00:02:00.000Z');
    const reboundInput = {
      ...bindingInput,
      bindingId: 'binding-2',
      nativeSessionId: 'session-2',
      nativeThreadId: 'thread-2',
    };
    await store.bind(reboundInput);

    await expect(store.listPending({ ...reboundInput, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        originMessageId: 'm1',
        idempotencyKey: 'm1:thread-2',
        state: 'waiting',
      }),
    ]);
    const state = JSON.parse(await fs.readFile(filePath, 'utf8')) as { deliveries: unknown[] };
    expect(state.deliveries).toHaveLength(1);
  });

  it('fails closed instead of pruning a resolved origin that is still in canonical history', async () => {
    const messages = [message('m1', ['codex-native-1'])];
    const store = await harness(messages, 1);
    await store.bind(bindingInput);
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm1' });
    if (!claimed.outboundCorrelationId) throw new Error('outbound correlation missing');
    await completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: claimed.outboundCorrelationId,
    });

    await store.unbind(bindingInput);
    messages.push(message('m2', ['codex-native-1']));
    const reboundInput = {
      ...bindingInput,
      bindingId: 'binding-2',
      nativeSessionId: 'session-2',
      nativeThreadId: 'thread-2',
    };
    await store.bind(reboundInput);

    await expect(store.listPending({ ...reboundInput, limit: 10 }))
      .rejects.toMatchObject({ code: 'CODEX_NATIVE_QUEUE_FULL', statusCode: 409 });
  });

  it('atomically claims and Stop-confirms each native reply once', async () => {
    const store = await harness([
      message('m1', ['codex-native-1']),
      message('m2', ['codex-native-1']),
    ]);
    await store.bind(bindingInput);
    const ordered = await store.listPending({ ...bindingInput, limit: 10 });
    expect(ordered.map((item) => item.originMessageId)).toEqual(['m1', 'm2']);

    const [left, right] = await Promise.all([
      store.claim({ ...bindingInput, originMessageId: 'm1' }),
      store.claim({ ...bindingInput, originMessageId: 'm1' }),
    ]);
    expect(left.outboundCorrelationId).toBe(right.outboundCorrelationId);
    expect(left.outboundCorrelationId).toBeDefined();

    await expect(store.claim({ ...bindingInput, originMessageId: 'm2' }))
      .rejects.toMatchObject({ code: 'CODEX_NATIVE_CLAIM_CONFLICT', statusCode: 409 });

    const resolved = await completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: left.outboundCorrelationId!,
    });
    expect(resolved).toMatchObject({
      channelId: 'channel-1',
      participantId: 'codex-native-1',
      originMessageId: 'm1',
      replyToMessageId: 'm1',
      outboundIdempotencyKey: 'session-1:turn-1',
    });
    expect(await completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: left.outboundCorrelationId!,
    })).toEqual(resolved);

    const secondClaim = await store.claim({ ...bindingInput, originMessageId: 'm2' });
    expect(secondClaim).toMatchObject({
      originMessageId: 'm2',
      state: 'claimed',
    });
    if (!secondClaim.outboundCorrelationId) {
      throw new Error('second claim metadata missing');
    }

    await expect(completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-2',
      outboundCorrelationId: left.outboundCorrelationId!,
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_OUTBOUND_NOT_FOUND', statusCode: 404 });
    await expect(completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-2',
      outboundCorrelationId: secondClaim.outboundCorrelationId,
    })).resolves.toMatchObject({
      originMessageId: 'm2',
      replyToMessageId: 'm2',
      outboundIdempotencyKey: 'session-1:turn-2',
    });
    await expect(completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-1',
      outboundCorrelationId: secondClaim.outboundCorrelationId,
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_OUTBOUND_NOT_FOUND', statusCode: 404 });
  });

  it('requires the exact claimed correlation instead of consuming session FIFO', async () => {
    const store = await harness([message('m1', ['codex-native-1'])]);
    await store.bind(bindingInput);
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm1' });
    if (!claimed.outboundCorrelationId) throw new Error('claim metadata missing');

    await expect(completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'unrelated-turn',
      outboundCorrelationId: 'unrelated-correlation',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_OUTBOUND_NOT_FOUND', statusCode: 404 });
    await expect(completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'intended-turn',
      outboundCorrelationId: claimed.outboundCorrelationId,
    })).resolves.toMatchObject({
      originMessageId: 'm1',
      outboundIdempotencyKey: 'session-1:intended-turn',
    });
  });

  it('uses the correlated Stop transaction itself as native-turn confirmation', async () => {
    const store = await harness([message('m1', ['codex-native-1'])]);
    await store.bind(bindingInput);
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm1' });
    if (!claimed.outboundCorrelationId) throw new Error('claim metadata missing');

    await expect(completeOutbound(store, {
      nativeSessionId: 'session-1',
      turnId: 'turn-confirmed',
      outboundCorrelationId: claimed.outboundCorrelationId,
    })).resolves.toMatchObject({ originMessageId: 'm1' });
    await expect(store.getDeliveryStatus({ ...bindingInput, originMessageId: 'm1' }))
      .resolves.toMatchObject({ state: 'acked', confirmed: true });
  });

  it('keeps a correlated Stop retryable across a delayed append retry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-confirmation-'));
    tempDirs.push(dir);
    const messages = [message('m-confirm', ['codex-native-1'])];
    let clock = new Date('2026-08-11T00:00:00.000Z');
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => clock,
      randomId: (() => {
        let id = 0;
        return () => `token-${++id}`;
      })(),
      readMessages: async (channelId) => ({
        channelId,
        messages,
        lastUpdated: clock.toISOString(),
      }),
    });
    await store.bind(bindingInput);
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm-confirm' });
    if (!claimed.outboundCorrelationId) throw new Error('correlation missing');

    await expect(store.transactOutbound({
      nativeSessionId: 'session-1',
      turnId: 'turn-confirm',
      outboundCorrelationId: claimed.outboundCorrelationId,
    }, async () => {
      throw new Error('append failed');
    })).rejects.toThrow('append failed');
    await expect(store.getDeliveryStatus({
      ...bindingInput,
      originMessageId: 'm-confirm',
    })).resolves.toMatchObject({ state: 'claimed', confirmed: false });
    const wrongTurnOperation = vi.fn(async () => 'must-not-run');
    await expect(store.transactOutbound({
      nativeSessionId: 'session-1',
      turnId: 'different-turn',
      outboundCorrelationId: claimed.outboundCorrelationId,
    }, wrongTurnOperation)).rejects.toMatchObject({
      code: 'CODEX_NATIVE_OUTBOUND_NOT_FOUND',
      statusCode: 404,
    });
    expect(wrongTurnOperation).not.toHaveBeenCalled();

    clock = new Date('2026-08-11T00:01:01.000Z');
    await expect(store.getDeliveryStatus({
      ...bindingInput,
      originMessageId: 'm-confirm',
    })).resolves.toMatchObject({ state: 'claimed', confirmed: false });
    await expect(store.listPending({ ...bindingInput, limit: 10 })).resolves.toEqual([]);
    await expect(store.releaseClaim({
      ...bindingInput,
      originMessageId: 'm-confirm',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_CLAIM_CONFLICT', statusCode: 409 });
    await expect(store.transactOutbound({
      nativeSessionId: 'session-1',
      turnId: 'turn-confirm',
      outboundCorrelationId: claimed.outboundCorrelationId,
    }, async () => 'appended')).resolves.toMatchObject({ result: 'appended' });
    await expect(store.getDeliveryStatus({
      ...bindingInput,
      originMessageId: 'm-confirm',
    })).resolves.toMatchObject({ state: 'acked', confirmed: true });
  });

  it('never releases a long-running native turn from elapsed time alone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-cancelled-'));
    tempDirs.push(dir);
    const messages = [message('m-cancelled', ['codex-native-1'])];
    let clock = new Date('2026-08-11T00:00:00.000Z');
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      now: () => clock,
      randomId: () => 'cancelled-correlation',
      readMessages: async (channelId) => ({
        channelId,
        messages,
        lastUpdated: clock.toISOString(),
      }),
    });
    await store.bind(bindingInput);
    const claimed = await store.claim({ ...bindingInput, originMessageId: 'm-cancelled' });
    expect(claimed.claimExpiresAt).toBeUndefined();

    clock = new Date('2026-08-11T00:01:01.000Z');
    await expect(store.getDeliveryStatus({
      ...bindingInput,
      originMessageId: 'm-cancelled',
    })).resolves.toMatchObject({ state: 'claimed', confirmed: false });
    await expect(store.listPending({ ...bindingInput, limit: 10 })).resolves.toEqual([]);

    await expect(store.releaseClaim({
      ...bindingInput,
      originMessageId: 'm-cancelled',
    })).resolves.toMatchObject({ state: 'waiting', confirmed: false });
    await expect(store.releaseClaim({
      ...bindingInput,
      originMessageId: 'm-cancelled',
    })).resolves.toMatchObject({ state: 'waiting', confirmed: false });
    await expect(store.listPending({ ...bindingInput, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ originMessageId: 'm-cancelled', state: 'waiting' }),
    ]);
  });

  it('forces the capability store and containing directory to private modes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-parent-'));
    tempDirs.push(dir);
    const stateDirectory = path.join(dir, 'state');
    const filePath = path.join(stateDirectory, 'state.json');
    const store = createCodexNativeStore({ filePath });

    await store.bind(bindingInput);

    expect((await fs.stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('creates every atomic capability-state temp with explicit private permissions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-private-temp-'));
    tempDirs.push(dir);
    const stateDirectory = path.join(dir, 'state');
    const filePath = path.join(stateDirectory, 'state.json');
    const observedTemps: Array<{ path: string; mode: number }> = [];
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(filePath)) {
        observedTemps.push({
          path: String(source),
          mode: (await fs.stat(source)).mode & 0o777,
        });
      }
      await originalRename(source, destination);
    });
    const previousUmask = process.umask(0o000);

    try {
      await createCodexNativeStore({ filePath }).bind(bindingInput);
    } finally {
      process.umask(previousUmask);
      renameSpy.mockRestore();
    }

    expect(observedTemps.length).toBeGreaterThan(0);
    expect(observedTemps.every((item) => path.dirname(item.path) === stateDirectory)).toBe(true);
    expect(observedTemps.every((item) => item.mode === 0o600)).toBe(true);
  });

  it('rejects a symlinked capability store without following or chmodding its target', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-symlink-'));
    tempDirs.push(dir);
    const stateDirectory = path.join(dir, 'state');
    const target = path.join(dir, 'outside.json');
    const filePath = path.join(stateDirectory, 'state.json');
    await fs.mkdir(stateDirectory, { mode: 0o700 });
    await fs.writeFile(target, '{"outside":true}', { mode: 0o644 });
    await fs.symlink(target, filePath);
    const store = createCodexNativeStore({ filePath });

    await expect(store.getBinding('channel-1', 'codex-native-1'))
      .rejects.toMatchObject({ code: 'CODEX_NATIVE_STORAGE_FAILED', statusCode: 500 });
    expect(await fs.readFile(target, 'utf8')).toBe('{"outside":true}');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
  });

  it('fails closed instead of dropping unacknowledged messages when the bounded store is full', async () => {
    const store = await harness([
      message('m1', ['codex-native-1']),
      message('m2', ['codex-native-1']),
    ], 1);
    await store.bind(bindingInput);

    await expect(store.listPending({ ...bindingInput, limit: 10 }))
      .rejects.toBeInstanceOf(CodexNativeStoreError);
    await expect(store.listPending({ ...bindingInput, limit: 10 }))
      .rejects.toMatchObject({ code: 'CODEX_NATIVE_QUEUE_FULL', statusCode: 409 });
  });

  it('rejects unsafe or unbounded routing identifiers', async () => {
    const store = await harness();
    await expect(store.bind({
      ...bindingInput,
      nativeThreadId: 'x'.repeat(201),
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_INVALID_INPUT', statusCode: 400 });
  });

  it('validates channel routing before attempting any message-file read', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-store-'));
    tempDirs.push(dir);
    const readMessages = vi.fn();
    const store = createCodexNativeStore({
      filePath: path.join(dir, 'state.json'),
      readMessages,
    });

    await expect(store.listPending({
      ...bindingInput,
      channelId: '../../outside',
    })).rejects.toMatchObject({ code: 'CODEX_NATIVE_INVALID_INPUT', statusCode: 400 });
    expect(readMessages).not.toHaveBeenCalled();
  });
});
