// A reply carries a short tag at the start of the text, e.g. "[re 1538c43d] ", so the person and the agent see the same thing.
// Removing the tag removes the reply link (ColabPanel drops replyingTo when the tag is gone).

const TAG_LENGTH = 8;
const LEADING_TAG = /^\[re [0-9a-f]{8}\] ?/i;

export function replyTag(messageId: string): string {
  return `[re ${messageId.slice(0, TAG_LENGTH)}]`;
}

export function shortReplyId(messageId: string): string {
  return messageId.slice(0, TAG_LENGTH);
}

export function hasReplyTag(text: string, messageId: string): boolean {
  return text.includes(replyTag(messageId));
}

export function stripReplyTag(text: string): string {
  return text.replace(LEADING_TAG, '');
}

/** Text for the input after clicking Reply: the tag, the sender's @mention, then whatever was already typed. */
export function withReplyTag(current: string, messageId: string, senderName: string): string {
  const mention = `@${senderName} `;
  const rest = stripReplyTag(current);
  return `${replyTag(messageId)} ${rest.startsWith(mention) ? rest : mention + rest}`;
}
