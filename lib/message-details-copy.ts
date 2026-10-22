import type { CollabMessage, CollabParticipant } from '@/lib/types';
import { formatAbsoluteTime } from '@/lib/chat-timestamp';

interface BuildArgs {
  msg: CollabMessage;
  channelName: string;
  channelId: string;
  participants: CollabParticipant[];
}

export function buildMessageDetailsText({ msg, channelName, channelId, participants }: BuildArgs): string {
  const deliveryMode = msg.metadata?.deliveryMode ?? 'broadcast';

  let recipientNames = 'all';
  if (msg.recipients && msg.recipients.length > 0) {
    const names = msg.recipients.map(id => {
      const p = participants.find(p => p.id === id);
      return p?.name ?? id;
    });
    recipientNames = names.join(', ');
  }

  const threadId = (msg as CollabMessage & { threadRootId?: string }).threadRootId
    ?? msg.replyTo?.id
    ?? 'none';

  return [
    'Message Details',
    '===============',
    '',
    'Routing',
    '-------',
    `From: ${msg.from.name}  (${msg.from.id})`,
    `Channel: ${channelName}  (${channelId})`,
    `Delivery Mode: ${deliveryMode}`,
    `Recipients: ${recipientNames}`,
    '',
    'Timing & IDs',
    '------------',
    `Time: ${formatAbsoluteTime(msg.timestamp)}`,
    `Timestamp: ${msg.timestamp}`,
    `ID: ${msg.id}`,
    `Thread: ${threadId}`,
    '',
    'Content',
    '-------',
    `Content: ${msg.content}`,
  ].join('\n');
}
