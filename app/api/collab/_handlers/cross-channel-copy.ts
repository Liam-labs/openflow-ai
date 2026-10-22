/**
 * Human "also send to" for cross-channel conversations.
 *
 * When a person viewing a cross-channel message clicks its header, their next
 * message is posted locally as usual and also delivered to the originating
 * agent in its own channel through the existing Cross-Channel API, so that
 * agent's reply routes back here. Runs before /api/collab takes the channels
 * file lock, because the cross-channel action takes the same lock.
 */

import { message as agentMessage } from '@/app/api/agent/actions/collab';
import type { CollabChannelActionRequest, CollabChannelsData, CrossChannelCopyResult } from '@/lib/types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function sendCrossChannelCopy(
  body: CollabChannelActionRequest,
  data: CollabChannelsData,
): Promise<CrossChannelCopyResult | { invalid: string }> {
  const target = body.crossChannelTarget;
  if (!target || typeof target.channelId !== 'string' || typeof target.participantId !== 'string') {
    return { invalid: 'crossChannelTarget needs channelId and participantId' };
  }
  if (target.channelId === body.channelId) {
    return { invalid: 'crossChannelTarget must be a different channel' };
  }
  const targetChannel = data.channels.find(c => c.id === target.channelId);
  const targetParticipant = targetChannel?.participants.find(p => p.id === target.participantId);
  if (!targetChannel || !targetParticipant) {
    return { invalid: 'The cross-channel agent or channel no longer exists' };
  }

  const base = { channelId: targetChannel.id, channelName: targetChannel.name, participantName: targetParticipant.name };
  const text = (body.content ?? '').trim();
  if (!text) return { ...base, ok: false, error: 'Only text messages can be sent cross-channel' };

  // The receiving agent is addressed by ID; the @mention keeps the text readable there.
  const mention = new RegExp(`(^|\\s)@${escapeRegExp(targetParticipant.name)}\\b`);
  const content = mention.test(text) ? text : `@${targetParticipant.name} ${text}`;

  try {
    await agentMessage(
      {
        action: 'collab.cross_channel_message',
        sourceChannelId: body.channelId,
        sourceParticipantId: body.participantId,
        targetChannelId: targetChannel.id,
        targetParticipantId: targetParticipant.id,
        content,
      } as Parameters<typeof agentMessage>[0],
      { tokenId: 'collab-ui', tokenName: 'Collab UI', scope: 'write', createdBy: body.participantId ?? 'browser' },
    );
    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, ok: false, error: message.slice(0, 300) };
  }
}
