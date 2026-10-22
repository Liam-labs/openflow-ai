/**
 * /invite slash command — integration layer
 *
 * Called from the messaging handler after a message is stored.
 * Parses the message, finds the matching agent, and dispatches the invite.
 */

import { randomUUID } from 'crypto';
import type { CollabChannel, CollabMessage } from './types';
import { parseInviteCommand, findAgentByCapability, dispatchInvite } from './invite-router';
import { appendMessage } from './collab-message-io';
import { readRolesData } from './collab-delivery';

function makeSystemMessage(channelId: string, content: string): CollabMessage {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    channelId,
    from: { id: 'system', type: 'user' as const, name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
    content,
    timestamp: now,
  };
}

export async function processInviteSlashCommand(
  content: string,
  senderName: string,
  channel: CollabChannel
): Promise<void> {
  const parsed = parseInviteCommand(content);
  if (!parsed) return;

  const roles = await readRolesData();
  const agents = channel.roster?.agents ?? [];
  const agent = findAgentByCapability(parsed.capability, agents, roles);

  if (!agent) {
    await appendMessage(
      channel.id,
      makeSystemMessage(channel.id, `No agent found with capability "${parsed.capability}". Check available agents with /roster.`)
    );
    return;
  }

  await dispatchInvite(agent, channel.id, channel.name, parsed.task);

  const taskInfo = parsed.task ? `, task: ${parsed.task}` : '';
  await appendMessage(
    channel.id,
    makeSystemMessage(channel.id, `${agent.name} invited by ${senderName} via /invite${taskInfo}`)
  );
}
