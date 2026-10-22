/**
 * Resume notice for agents auto-respawned after an unclean exit.
 *
 * A respawned agent starts idle: nothing tells it that its previous session
 * died mid-task, so it waits for a prompt that never comes (Costa Vida,
 * 2026-09-28: agents relaunched at 04:50 sat idle until the owner noticed at 08:17).
 *
 * The notice travels the normal delivery path (channel message + inbox/SSE,
 * plus the durable ledger for ledger-v1 wrappers), so every runtime receives
 * it as its first message once its wrapper is ready.
 */

import { randomUUID } from 'crypto';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { appendMessageIfAbsent } from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { deliverMessage } from '@/lib/collab-delivery';
import { enqueueDurableDeliveries } from '@/lib/collab-delivery-ledger';
import type { CollabChannelsData, CollabMessage } from '@/lib/types';

export function formatShutdownTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', { timeZoneName: 'short' });
}

export function buildRestartResumeText(agentName: string, shutdownAt: string): string {
  return (
    `@${agentName} You were restarted after an unexpected shutdown at ${formatShutdownTime(shutdownAt)}. ` +
    'Your previous session ended mid-work and nothing else will prompt you. ' +
    'Resume your in-progress work now: read logs/handoff.md in your workspace and your in-progress board tasks, ' +
    'then continue from where you stopped. Do not re-answer channel messages you already handled.'
  );
}

/**
 * Post the resume notice to one respawned agent. Returns the message ID, or
 * null when the agent or its participant is no longer on the channel roster.
 */
export async function sendRestartResumeNotice(input: {
  channelId: string;
  agentId: string;
  shutdownAt: string;
}): Promise<string | null> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, {
    channels: [],
    lastUpdated: '',
  });
  const channel = data.channels.find(item => item.id === input.channelId);
  const agent = channel?.roster?.agents.find(item => item.id === input.agentId);
  if (!channel || !agent?.participantId) return null;

  const participant = channel.participants.find(item => item.id === agent.participantId);
  const now = new Date().toISOString();
  const message: CollabMessage = {
    id: `restart-resume-${randomUUID()}`,
    channelId: channel.id,
    from: {
      id: 'system',
      type: 'user',
      name: 'System',
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    },
    content: buildRestartResumeText(participant?.name || agent.name, input.shutdownAt),
    timestamp: now,
    mentions: [agent.participantId],
    recipients: [agent.participantId],
    metadata: {
      deliveryMode: 'targeted',
      client: { kind: 'devflow.restart-resume', agentId: agent.id, shutdownAt: input.shutdownAt },
    },
  };

  const canonical = await appendMessageIfAbsent(channel.id, message);
  await enqueueDurableDeliveries('system', canonical.message, channel);
  if (canonical.appended) {
    eventBus.emitEvent('collab:message', { channelId: channel.id, message: canonical.message });
    deliverMessage('system', canonical.message, channel);
  }
  return canonical.message.id;
}
