import { createHash } from 'crypto';

import {
  appendMessageIfAbsent,
  getChannelById,
  loadArchivedMessages,
  readChannelMessages,
} from '@/lib/collab-message-io';
import { deliverMessage as deliverCollabMessage } from '@/lib/collab-delivery';
import {
  enqueueDurableDeliveries,
  prepareDurableDelivery,
} from '@/lib/collab-delivery-ledger';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { eventBus } from '@/lib/event-bus';
import { codexNativeStore } from '@/lib/codex-native-store';
import { parseAtMentions } from '@/lib/collab-utils';
import type {
  CodexNativeResolveOutboundInput,
  CodexNativeOutboundResolution,
} from '@/lib/codex-native-store';
import type { CollabChannel, CollabMessage } from '@/lib/types';

const MAX_REPLY_LENGTH = 100_000;
const ALL_ARCHIVES_CURSOR = '9999-12-31T23:59:59.999Z';

export interface CodexNativeForwardInput extends CodexNativeResolveOutboundInput {
  content: string;
}

export interface CodexNativeForwardResult {
  messageId: string;
  replyToMessageId: string;
  outboundIdempotencyKey: string;
  deduplicated: boolean;
}

export class CodexNativeForwardError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CodexNativeForwardError';
  }
}

interface ForwardDependencies {
  transactOutbound<T>(
    input: CodexNativeResolveOutboundInput,
    operation: (resolution: CodexNativeOutboundResolution) => Promise<T>,
  ): Promise<{ resolution: CodexNativeOutboundResolution; result: T }>;
  getChannel(channelId: string): Promise<CollabChannel | null>;
  findOriginal(channelId: string, messageId: string): Promise<CollabMessage | undefined>;
  appendIfAbsent(
    channelId: string,
    message: CollabMessage,
  ): Promise<{ message: CollabMessage; appended: boolean }>;
  prepareDelivery(senderId: string, message: CollabMessage, channel: CollabChannel): unknown;
  enqueueDelivery(senderId: string, message: CollabMessage, channel: CollabChannel): Promise<unknown>;
  emitMessage(channel: CollabChannel, message: CollabMessage): void;
  deliverMessage(senderId: string, message: CollabMessage, channel: CollabChannel): unknown;
  touchChannel(channelId: string, participantId: string, timestamp: string): Promise<void>;
  now(): Date;
}

function deterministicMessageId(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function findOriginalMessage(
  channelId: string,
  messageId: string,
): Promise<CollabMessage | undefined> {
  const active = await readChannelMessages(channelId);
  const current = active.messages.find(message => message.id === messageId);
  if (current) return current;
  const archived = await loadArchivedMessages(channelId, ALL_ARCHIVES_CURSOR);
  return archived.find(message => message.id === messageId);
}

async function touchChannel(
  channelId: string,
  participantId: string,
  timestamp: string,
): Promise<void> {
  await mutateChannels('codex-native-forward:touch-channel', async data => {
    const channel = data.channels.find(item => item.id === channelId);
    if (!channel) return;
    channel.lastActivity = timestamp;
    const participant = channel.participants.find(item => item.id === participantId);
    if (participant) participant.lastSeen = timestamp;
    await saveChannels(data);
  });
}

const defaults: ForwardDependencies = {
  transactOutbound: (input, operation) => codexNativeStore.transactOutbound(input, operation),
  getChannel: getChannelById,
  findOriginal: findOriginalMessage,
  appendIfAbsent: appendMessageIfAbsent,
  prepareDelivery: prepareDurableDelivery,
  enqueueDelivery: enqueueDurableDeliveries,
  emitMessage(channel, message) {
    eventBus.emitEvent('collab:message', {
      channelId: channel.id,
      message,
      participants: channel.participants,
    });
  },
  deliverMessage: deliverCollabMessage,
  touchChannel,
  now: () => new Date(),
};

export function createCodexNativeReplyForwarder(
  overrides: Partial<ForwardDependencies> = {},
) {
  const dependencies: ForwardDependencies = { ...defaults, ...overrides };

  return async function forward(input: CodexNativeForwardInput): Promise<CodexNativeForwardResult> {
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) {
      throw new CodexNativeForwardError(
        'Codex Native reply content is required',
        'CODEX_NATIVE_REPLY_INVALID',
        400,
      );
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_REPLY_LENGTH) {
      throw new CodexNativeForwardError(
        'Codex Native reply content is too large',
        'CODEX_NATIVE_REPLY_TOO_LARGE',
        413,
      );
    }

    const transaction = await dependencies.transactOutbound({
      nativeSessionId: input.nativeSessionId,
      turnId: input.turnId,
      outboundCorrelationId: input.outboundCorrelationId,
    }, async (resolution) => {
      const [channel, original] = await Promise.all([
        dependencies.getChannel(resolution.channelId),
        dependencies.findOriginal(resolution.channelId, resolution.replyToMessageId),
      ]);
      if (!channel) {
        throw new CodexNativeForwardError(
          'AgentChat channel for Codex Native reply is not currently available',
          'CODEX_NATIVE_CHANNEL_NOT_FOUND',
          409,
        );
      }
      const participant = channel.participants.find(item => item.id === resolution.participantId);
      if (!participant) {
        throw new CodexNativeForwardError(
          'Codex Native participant is not currently present in the bound channel',
          'CODEX_NATIVE_PARTICIPANT_NOT_FOUND',
          409,
        );
      }
      if (!original) {
        throw new CodexNativeForwardError(
          'Original AgentChat message for Codex Native reply is not currently available',
          'CODEX_NATIVE_ORIGIN_NOT_FOUND',
          409,
        );
      }

      const timestamp = dependencies.now().toISOString();
      const explicitRecipients = parseAtMentions(
        content,
        channel.participants,
        channel.roster?.agents,
      ).filter(participantId => participantId !== participant.id);
      const recipients = explicitRecipients.length > 0
        ? explicitRecipients
        : (original.from.id === participant.id ? undefined : [original.from.id]);
      const message: CollabMessage = {
        id: deterministicMessageId(resolution.outboundIdempotencyKey),
        channelId: resolution.channelId,
        from: participant,
        content,
        timestamp,
        mentions: explicitRecipients.length > 0 ? explicitRecipients : undefined,
        recipients,
        replyTo: {
          id: original.id,
          from: original.from,
          content: original.content.slice(0, 150),
        },
        metadata: {
          deliveryMode: recipients ? 'targeted' : 'broadcast',
          client: {
            kind: 'codex-native.outbound',
            outboundIdempotencyKey: resolution.outboundIdempotencyKey,
            originMessageId: resolution.originMessageId,
            nativeThreadId: resolution.nativeThreadId,
          },
        },
      };
      dependencies.prepareDelivery(participant.id, message, channel);
      const persisted = await dependencies.appendIfAbsent(channel.id, message);
      return { channel, participant, persisted, timestamp };
    });
    const { resolution } = transaction;
    const { channel, participant, persisted, timestamp } = transaction.result;
    await dependencies.enqueueDelivery(participant.id, persisted.message, channel);
    await dependencies.touchChannel(channel.id, participant.id, timestamp);
    if (persisted.appended) {
      dependencies.emitMessage(channel, persisted.message);
      dependencies.deliverMessage(participant.id, persisted.message, channel);
    }

    return {
      messageId: persisted.message.id,
      replyToMessageId: resolution.replyToMessageId,
      outboundIdempotencyKey: resolution.outboundIdempotencyKey,
      deduplicated: !persisted.appended,
    };
  };
}

export const forwardCodexNativeReply = createCodexNativeReplyForwarder();
