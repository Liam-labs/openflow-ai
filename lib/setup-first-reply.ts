/**
 * First-run wizard "has my team answered yet?" logic (BUG-54).
 *
 * The wizard sends each started agent a hello, then watches the channel for a reply. Since "Start my team" became
 * idempotent (BUG-53), a retry reuses the channel it already made, so the channel can already hold replies from an
 * earlier run. An earlier reply must not count as an answer to THIS run's hello — otherwise the wizard shows a stale
 * message and reports success on a run whose hello was never answered, which is the exact failure the first-run flow
 * exists to catch.
 *
 * Messages carry an id but no timestamp here, so the cut-off is a watermark of the ids already in the channel when the
 * run began. A message counts only when an agent sent it and its id was not in that watermark (it appeared after the
 * hello). This is clock-free and does not depend on id ordering.
 */
export interface FirstReplyMessage {
  id: string;
  from?: { name?: string; type?: string };
}

/** True when an agent (not the person) sent this message during this run — its id is new since the run began. */
export function isFreshAgentReply(message: FirstReplyMessage, priorIds: Set<string>): boolean {
  return message.from?.type !== 'user' && !priorIds.has(message.id);
}

/** The started agents' fresh replies, in channel order (used to show each agent's answer). Generic so it preserves the
 *  caller's full message type (e.g. the field holding the reply text) rather than narrowing to FirstReplyMessage. */
export function freshReplies<T extends FirstReplyMessage>(messages: T[], started: string[], priorIds: Set<string>): T[] {
  return messages.filter((m) => isFreshAgentReply(m, priorIds) && !!m.from?.name && started.includes(m.from.name));
}

/** True only when every named agent has a fresh reply this run. */
export function everyAgentAnswered(messages: FirstReplyMessage[], names: string[], priorIds: Set<string>): boolean {
  return names.every((n) => messages.some((m) => m.from?.name === n && isFreshAgentReply(m, priorIds)));
}
