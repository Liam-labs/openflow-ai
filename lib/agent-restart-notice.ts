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
import { appendMessageIfAbsent, readChannelMessages } from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { deliverMessage } from '@/lib/collab-delivery';
import { enqueueDurableDeliveries } from '@/lib/collab-delivery-ledger';
import type { CollabChannelsData, CollabMessage } from '@/lib/types';

export function formatShutdownTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', { timeZoneName: 'short' });
}

export interface UnansweredMention {
  from: string;
  content: string;
}

/** One message's text as a single trimmed line, so the notice stays short. */
function oneLine(content: string, max = 160): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/**
 * The messages that mention or target this agent but that it never posted after — i.e. @mentions it had not answered
 * when it died. A message delivered seconds before a crash is marked "delivered", so nothing re-delivers it and the
 * restarted agent never learns of it (BUG-55). We detect it from the transcript instead of the delivery log: a mention
 * with no later post from the agent is unanswered. The agent's own messages and earlier restart notices are ignored.
 * Newest `max` only, oldest first, so the notice is short and in order.
 */
export function unansweredMentions(
  messages: CollabMessage[],
  participantId: string,
  max = 5,
): UnansweredMention[] {
  let lastOwnPostAt = '';
  for (const m of messages) {
    if (m.from?.id === participantId && m.timestamp > lastOwnPostAt) lastOwnPostAt = m.timestamp;
  }
  const hits = messages.filter(m => {
    if (m.from?.id === participantId) return false;                 // not the agent's own messages
    const targeted = m.mentions?.includes(participantId) || m.recipients?.includes(participantId);
    if (!targeted) return false;
    const kind = (m.metadata?.client as { kind?: string } | undefined)?.kind;
    if (kind === 'devflow.restart-resume') return false;            // not a previous restart notice
    return m.timestamp > lastOwnPostAt;                             // the agent has not posted since this message
  });
  hits.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return hits.slice(-max).map(m => ({ from: m.from?.name || 'Someone', content: oneLine(m.content) }));
}

export function buildRestartResumeText(agentName: string, shutdownAt: string, unanswered: UnansweredMention[] = []): string {
  let text =
    `@${agentName} You were restarted after an unexpected shutdown at ${formatShutdownTime(shutdownAt)}. ` +
    'Your previous session ended mid-work and nothing else will prompt you. ' +
    'Resume your in-progress work now: read logs/handoff.md in your workspace and your in-progress board tasks, ' +
    'then continue from where you stopped. Do not re-answer channel messages you already handled.';
  if (unanswered.length > 0) {
    text +=
      '\n\nThese messages arrived just before you stopped and were probably never answered. ' +
      'Answer each one you have not already handled. The name in brackets is who to reply to — use it exactly:';
    // Give the exact reply command so the sender's name is read as a name, not prose. On a fresh install the person's
    // display name is literally "You", which an agent can misread as the pronoun and reply to the wrong place (BUG-56).
    for (const m of unanswered) text += `\n- [${m.from}] (reply with: --to "${m.from}"): ${m.content}`;
  }
  return text;
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
  // @mentions delivered just before the crash are marked delivered, so nothing re-delivers them. Name any the agent
  // never answered in the notice so it can pick them up (BUG-55).
  const { messages } = await readChannelMessages(channel.id);
  const unanswered = unansweredMentions(messages, agent.participantId);
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
    content: buildRestartResumeText(participant?.name || agent.name, input.shutdownAt, unanswered),
    timestamp: now,
    mentions: [agent.participantId],
    recipients: [agent.participantId],
    metadata: {
      deliveryMode: 'targeted',
      // An instruction for the agent, not a message for the person: delivered, but kept out of the chat feed (the "Show system messages"
      // toggle still reveals it). Otherwise a restarted Setup chat opens on a long block the user never wrote.
      isHidden: true,
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
