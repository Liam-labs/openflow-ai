type MsgWithHidden = {
  content?: string;
  metadata?: {
    isHidden?: boolean;
    crossChannel?: {
      sourceChannelName?: string;
      deliveryChannelName?: string;
      senderName?: string;
      targetParticipantName?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

/** True when the stored content is an agent-facing cross-channel routing envelope. */
export function isCrossChannelTransportMessage(message: MsgWithHidden): boolean {
  return message.metadata?.crossChannel !== undefined;
}

/** Cross-channel messages are real chat; ordinary hidden records are not. */
export function isMessageHiddenFromHumans(message: MsgWithHidden): boolean {
  if (isCrossChannelTransportMessage(message)) return false;
  return message.metadata?.isHidden === true;
}

const ORIGINAL_MESSAGE_MARKER = '\nOriginal cross-channel message:\n';
const HUMAN_HEADER = /^\*\*(Cross-channel message · [^\n]*)\*\*\n\n/;

/**
 * Replace the verbose agent routing envelope with the compact human-facing
 * cross-channel record. The stored content remains untouched for agent delivery.
 */
export function formatCrossChannelMessageForHumans<T extends MsgWithHidden>(message: T): T {
  const route = message.metadata?.crossChannel;
  if (!route || typeof message.content !== 'string') return message;

  // Already compact: the server (history and live events) formats before the page does. Formatting again
  // would stack a second header on top of the first.
  if (HUMAN_HEADER.test(message.content)) return message;

  const markerIndex = message.content.indexOf(ORIGINAL_MESSAGE_MARKER);
  const originalContent = markerIndex >= 0
    ? message.content.slice(markerIndex + ORIGINAL_MESSAGE_MARKER.length)
    : message.content;
  const mentionedRecipient = originalContent.match(/@([A-Za-z0-9_-]+)/)?.[1];
  const sender = route.senderName || 'Unknown sender';
  const source = route.sourceChannelName || 'Unknown channel';
  const destination = route.deliveryChannelName || 'Unknown channel';
  const recipient = route.targetParticipantName || mentionedRecipient;
  const toLabel = recipient ? `${recipient} (${destination})` : destination;

  return {
    ...message,
    content: `**Cross-channel message · ${sender} (${source}) → ${toLabel}**\n\n${originalContent}`,
  };
}

/**
 * Filters a message list based on the showHidden flag.
 * When showHidden is false, messages with metadata.isHidden === true are excluded.
 */
export function filterHiddenMessages<T extends MsgWithHidden>(messages: T[], showHidden: boolean): T[] {
  return messages.filter(message => {
    // Cross-channel records are shown after their routing envelope is formatted
    // into a compact From -> To message for humans.
    if (isCrossChannelTransportMessage(message)) return true;
    return showHidden || message.metadata?.isHidden !== true;
  });
}

/**
 * Counts messages that have metadata.isHidden === true.
 */
export function countHiddenMessages<T extends MsgWithHidden>(messages: T[]): number {
  return messages.filter(message =>
    message.metadata?.isHidden === true && !isCrossChannelTransportMessage(message)
  ).length;
}

/**
 * The agent in another channel that sent this cross-channel message, so a human
 * viewing it can address that agent directly. Null when the message is not an
 * incoming cross-channel message for the channel being viewed.
 */
export function crossChannelReplyTarget(
  message: MsgWithHidden,
  viewingChannelId: string | undefined,
): { channelId: string; channelName: string; participantId: string; participantName: string } | null {
  const route = message.metadata?.crossChannel as
    | { sourceChannelId?: unknown; sourceChannelName?: unknown; senderId?: unknown; senderName?: unknown }
    | undefined;
  if (!route || typeof route.sourceChannelId !== 'string' || typeof route.senderId !== 'string') return null;
  if (route.sourceChannelId === viewingChannelId) return null;
  return {
    channelId: route.sourceChannelId,
    channelName: typeof route.sourceChannelName === 'string' ? route.sourceChannelName : 'another channel',
    participantId: route.senderId,
    participantName: typeof route.senderName === 'string' ? route.senderName : 'agent',
  };
}

/** Splits the compact human header produced by formatCrossChannelMessageForHumans from the body. */
export function splitCrossChannelHeader(content: string): { header: string; body: string } | null {
  const match = HUMAN_HEADER.exec(content);
  return match ? { header: match[1], body: content.slice(match[0].length) } : null;
}
