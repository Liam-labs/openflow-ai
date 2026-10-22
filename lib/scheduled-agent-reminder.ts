/**
 * Exact, channel-scoped delivery for Scheduled Jobs.
 *
 * Unlike tmux-send, the target is an immutable (channelId, participantId)
 * pair. Codex uses its durable ledger, including stopped seats. Claude uses
 * an acknowledged inbox append on the host running the exact wrapper.
 */

import { randomUUID } from 'crypto';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { appendMessageIfAbsent } from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { deliverMessage } from '@/lib/collab-delivery';
import { enqueueDurableDeliveries, prepareDurableDelivery } from '@/lib/collab-delivery-ledger';
import { sendScheduledClaudeReminder } from '@/lib/scheduled-claude-reminder';
import type { AgentRosterEntry, CollabChannel, CollabChannelsData, CollabMessage } from '@/lib/types';
import { PRODUCT_NAME } from '@/lib/brand';

export interface ScheduledAgentTarget {
  channel: CollabChannel;
  agent: AgentRosterEntry;
}

export interface ScheduledAgentReminderResult {
  messageId: string;
  deliveryRecordId?: string;
  deliveryTransport?: 'host-inbox';
  deliveryHost?: string;
  queuedAt?: string;
  channelId: string;
  participantId: string;
  recipientName: string;
  deliveryState: string;
  runtimeState: string;
  queuedWhileStopped: boolean;
}

export function resolveScheduledAgentTarget(
  data: CollabChannelsData,
  channelId: string,
  participantId: string,
): ScheduledAgentTarget {
  const channel = data.channels.find(item => item.id === channelId);
  if (!channel) throw new Error(`Scheduled reminder channel not found: ${channelId}`);

  const agent = channel.roster?.agents.find(item => item.participantId === participantId);
  if (!agent) {
    throw new Error(`Scheduled reminder participant ${participantId} is not in channel ${channelId}`);
  }
  const codex = agent.agentType === 'codex' && agent.deliveryProtocol === 'ledger-v1';
  const claude = (agent.agentType === 'claude' || !agent.agentType) && agent.useCollabWrapper;
  if (!codex && !claude) {
    throw new Error(
      `Scheduled reminder target ${participantId} does not support ledger-v1 Codex or Claude wrapper delivery`,
    );
  }
  return { channel, agent };
}

export async function sendScheduledAgentReminder(input: {
  channelId: string;
  participantId: string;
  text: string;
  jobId: string;
  executionId: string;
}): Promise<ScheduledAgentReminderResult> {
  const text = input.text.trim();
  if (!text) throw new Error('Scheduled reminder text is required');

  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, {
    channels: [],
    lastUpdated: '',
  });
  const { channel, agent } = resolveScheduledAgentTarget(data, input.channelId, input.participantId);
  const now = new Date().toISOString();
  const participant = channel.participants.find(item => item.id === input.participantId);
  const message: CollabMessage = {
    id: `scheduled-reminder-${input.executionId || randomUUID()}`,
    channelId: channel.id,
    from: {
      id: 'system',
      type: 'user',
      name: `${PRODUCT_NAME} Scheduled Jobs`,
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    },
    content: `@${participant?.name || agent.name} ${text}`,
    timestamp: now,
    mentions: [input.participantId],
    recipients: [input.participantId],
    metadata: {
      deliveryMode: 'targeted',
      client: {
        kind: 'devflow.scheduled-agent-reminder',
        jobId: input.jobId,
        executionId: input.executionId,
      },
    },
  };

  if (agent.agentType !== 'codex') {
    return sendScheduledClaudeReminder(message, channel, agent);
  }

  const recipients = prepareDurableDelivery('system', message, channel);
  if (recipients.length !== 1 || recipients[0] !== input.participantId) {
    throw new Error(`Scheduled reminder could not establish exact durable target ${input.participantId}`);
  }

  const canonical = await appendMessageIfAbsent(channel.id, message);
  const records = await enqueueDurableDeliveries('system', canonical.message, channel);
  const record = records.find(item => item.participantId === input.participantId);
  if (!record) throw new Error(`Scheduled reminder durable record was not created for ${input.participantId}`);

  if (canonical.appended) {
    eventBus.emitEvent('collab:message', { channelId: channel.id, message: canonical.message });
    deliverMessage('system', canonical.message, channel);
  }

  const runtimeState = participant?.status || agent.status;
  return {
    messageId: canonical.message.id,
    deliveryRecordId: record.id,
    channelId: channel.id,
    participantId: input.participantId,
    recipientName: participant?.name || agent.name,
    deliveryState: record.state,
    runtimeState,
    queuedWhileStopped: agent.status !== 'running',
  };
}
