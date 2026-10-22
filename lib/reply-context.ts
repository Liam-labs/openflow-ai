/**
 * The reply line an agent is shown when a message answers an earlier one, in every runtime.
 *
 *   (replying to an agent, message 1538c43d-d16e-4f24-9b27-57e40dd3b8cf: "first 80 characters...")
 *
 * The full message id is what lets an agent quote the right message back: two messages can start with the same words, a
 * name and 80 characters cannot tell them apart (the owner and an agent, 18 Oct 2026). Python wrappers use the identical rules in
 * scripts/reply_context.py; tests/fixtures/reply-context-vectors.json pins both to the same output.
 */

export interface ReplyContextInput {
  id?: string | null;
  from?: string | { name?: string | null } | null;
  content?: string | null;
}

export const REPLY_PREVIEW_CHARS = 80;

/** Message ids are UUIDs or short tokens; anything else is not quoted rather than risking a broken line. */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export function formatReplyContext(reply: ReplyContextInput | null | undefined): string {
  if (!reply || typeof reply !== 'object') return '';
  const name = (typeof reply.from === 'object' && reply.from ? reply.from.name : reply.from) || 'Unknown';
  const preview = String(reply.content ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, REPLY_PREVIEW_CHARS);
  const id = typeof reply.id === 'string' ? reply.id.trim() : '';
  const who = SAFE_ID.test(id) ? `${name}, message ${id}` : String(name);
  return `(replying to ${who}: "${preview}...")`;
}
