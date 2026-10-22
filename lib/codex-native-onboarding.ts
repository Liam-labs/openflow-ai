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
import { eventBus } from '@/lib/event-bus';
import type { CodexNativeBinding } from '@/lib/codex-native-store';
import type { CollabChannel, CollabMessage, CollabParticipant } from '@/lib/types';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';

import { getDevflowHome } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';
const ALL_ARCHIVES_CURSOR = '9999-12-31T23:59:59.999Z';

interface OnboardingDependencies {
  getChannel(channelId: string): Promise<CollabChannel | null>;
  hasMessage(channelId: string, messageId: string): Promise<boolean>;
  appendIfAbsent(
    channelId: string,
    message: CollabMessage,
  ): Promise<{ message: CollabMessage; appended: boolean }>;
  prepareDelivery(senderId: string, message: CollabMessage, channel: CollabChannel): unknown;
  enqueueDelivery(senderId: string, message: CollabMessage, channel: CollabChannel): Promise<unknown>;
  emitMessage(channel: CollabChannel, message: CollabMessage): void;
  deliverMessage(senderId: string, message: CollabMessage, channel: CollabChannel): unknown;
  now(): Date;
}

export interface CodexNativeOnboardingResult {
  primerCreated: boolean;
  introductionRequestCreated: boolean;
}

function deterministicMessageId(key: string): string {
  const bytes = createHash('sha256').update(key, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mentionToken(name: string): string {
  return /\s/.test(name) ? `@"${name.replace(/"/g, '')}"` : `@${name}`;
}

function participantKind(participant: CollabParticipant): 'user' | 'agent' {
  return participant.type === 'user' ? 'user' : 'agent';
}

async function hasMessageInHistory(channelId: string, messageId: string): Promise<boolean> {
  const active = await readChannelMessages(channelId);
  if (active.messages.some(message => message.id === messageId)) return true;
  const archived = await loadArchivedMessages(channelId, ALL_ARCHIVES_CURSOR);
  return archived.some(message => message.id === messageId);
}

const defaults: OnboardingDependencies = {
  getChannel: getChannelById,
  hasMessage: hasMessageInHistory,
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
  now: () => new Date(),
};

export function createCodexNativeOnboarder(
  overrides: Partial<OnboardingDependencies> = {},
) {
  const dependencies: OnboardingDependencies = { ...defaults, ...overrides };

  async function dispatch(
    channel: CollabChannel,
    message: CollabMessage,
  ): Promise<boolean> {
    dependencies.prepareDelivery('system', message, channel);
    const persisted = await dependencies.appendIfAbsent(channel.id, message);
    await dependencies.enqueueDelivery('system', persisted.message, channel);
    if (!persisted.appended) return false;
    dependencies.emitMessage(channel, persisted.message);
    dependencies.deliverMessage('system', persisted.message, channel);
    return true;
  }

  return async function onboard(
    binding: CodexNativeBinding,
  ): Promise<CodexNativeOnboardingResult> {
    const channel = await dependencies.getChannel(binding.channelId);
    if (!channel) return { primerCreated: false, introductionRequestCreated: false };

    const nativeParticipant = channel.participants.find(
      participant => participant.id === binding.participantId,
    );
    if (!nativeParticipant) return { primerCreated: false, introductionRequestCreated: false };

    const peers = channel.participants.filter(
      participant => participant.id !== nativeParticipant.id && participant.id !== 'system',
    );
    const agents = peers.filter(participant => participant.type !== 'user');
    const timestamp = dependencies.now().toISOString();
    const systemParticipant: CollabParticipant = {
      id: 'system',
      type: 'user',
      name: 'System',
      source: 'DevFlow',
      joinedAt: timestamp,
      lastSeen: timestamp,
    };

    const mentionMap = peers.length > 0
      ? peers.map(participant =>
        `- ${participant.name} (${participantKind(participant)}): ${mentionToken(participant.name)}`
      ).join('\n')
      : '- No other participants are currently present.';
    const introductionTargets = peers.map(participant => mentionToken(participant.name)).join(' ');
    const primer: CollabMessage = {
      // A reconnect to the same Desktop thread must not create another primer.
      // A genuinely different native chat gets its own onboarding turn.
      id: deterministicMessageId(
        `codex-native:onboarding:primer:${channel.id}:${nativeParticipant.id}:${binding.nativeThreadId}`,
      ),
      channelId: channel.id,
      from: systemParticipant,
      content: [
        `You are ${mentionToken(nativeParticipant.name)}, ${HUMAN_ROUTING_NAME}'s native Codex Desktop agent, now connected to the AgentChat channel "${channel.name}".`,
        '',
        'Use these exact mention handles whenever you address someone. Mentions control delivery, so include only the intended recipient or recipients:',
        mentionMap,
        '',
        `This native Codex chat does not inherit AgentChat's normal rules and skills. Before any task that needs ${HUMAN_ROUTING_NAME}'s account, sign-in, credential, API key, or authenticated browser session, load the canonical account-access instructions and resolve the exact account through the Model-neutral ${PRODUCT_NAME} MCP Gateway. Use gateway MCP tools when available; otherwise use the same contract through WSL:`,
        `\`wsl -- cat -- ${getDevflowHome()}/data/skills/account-access/SKILL.md\``,
        `\`wsl -- cat -- ${getDevflowHome()}/data/skills/onepassword/SKILL.md\``,
        `\`wsl -- ${getDevflowHome()}/scripts/devflow-gateway --help\``,
        'Never call the 1Password CLI directly or expose a password/token. The native browser harness changes only how the selected action runs; it does not replace account planning, exact resource selection, receipts, or approval boundaries.',
        '',
        peers.length > 0
          ? `If you have not already introduced yourself in this channel, do so now in one concise message addressed to ${introductionTargets}. Explain that you run natively in Codex Desktop and can use its native harnesses. If you already introduced yourself, do not repeat it. Do not send an acknowledgement-only reply.`
          : 'No reply is needed until another participant joins or messages you.',
      ].join('\n'),
      timestamp,
      mentions: [nativeParticipant.id],
      recipients: [nativeParticipant.id],
      system: true,
      metadata: {
        isHidden: true,
        deliveryMode: 'targeted',
        client: {
          kind: 'codex-native.onboarding.primer',
          bindingId: binding.bindingId,
        },
      },
    };
    const primerCreated = await dispatch(channel, primer);

    let introductionRequestCreated = false;
    if (agents.length > 0) {
      const introductionId = deterministicMessageId(
        `codex-native:onboarding:introductions:${channel.id}:${nativeParticipant.id}`,
      );
      if (!await dependencies.hasMessage(channel.id, introductionId)) {
        const agentMentions = agents.map(agent => mentionToken(agent.name)).join(' ');
        const introductionRequest: CollabMessage = {
          id: introductionId,
          channelId: channel.id,
          from: systemParticipant,
          content: `${agentMentions} — ${mentionToken(nativeParticipant.name)} has joined from ${HUMAN_ROUTING_NAME}'s native Codex Desktop chat. Introduce yourself once with your role, what you own, and how you can collaborate. Address your reply to ${mentionToken(nativeParticipant.name)}; keep it brief.`,
          timestamp,
          mentions: agents.map(agent => agent.id),
          recipients: agents.map(agent => agent.id),
          metadata: {
            deliveryMode: 'targeted',
            client: {
              kind: 'codex-native.onboarding.introduction-request',
              participantId: nativeParticipant.id,
            },
          },
        };
        introductionRequestCreated = await dispatch(channel, introductionRequest);
      }
    }

    return { primerCreated, introductionRequestCreated };
  };
}

export const onboardCodexNativeBinding = createCodexNativeOnboarder();
