/**
 * ask-owner/route.ts — T1.3 routing: turn a metadata.client envelope into action.
 *
 * Called from the message-creation path (handleMessage) right after the
 * CollabMessage is built and BEFORE it is appended/delivered. Two directions:
 *   - kind = ask-owner.question → record the StructuredQuestion so a later answer
 *     can resolve its askedBy (route target), then target the message to the
 *     channel's human participants. Browser clients render targeted messages,
 *     while agent wrappers must not receive a question that only the owner can answer.
 *   - kind = ask-owner.answer   → correlate to its question by questionId, mark it
 *     answered, and reshape the (hidden) answer message so the EXISTING delivery
 *     flow routes a readable line into the asking agent's inbox:
 *       recipients/mentions = [askedBy.participantId], content = human text
 *       prefixed with @askedBy.name, isHidden, deliveryMode = 'targeted'.
 *
 * Per the Phase-3 contract we key purely off metadata.client — hidden vs visible
 * never matters. Resilient by design: the caller wraps this in try/catch; an
 * ask-owner failure must never break normal messaging.
 */

import type { CollabMessage } from '@/lib/types';
import { isAskOwnerQuestion, isAskOwnerAnswer, type StructuredQuestion, type StructuredAnswer } from './types';
import { recordQuestion, markAnswered, findRecentDuplicate } from './store';

import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
/**
 * T1.4: window for deduping a model double-invocation of ask_owner.py. The
 * observed gap was ~94s (the model re-running ask_owner.py within one agy turn),
 * so 120s comfortably covers it while still treating a later identical ask as new.
 */
const DEDUP_WINDOW_MS = 120_000;

export type AskOwnerRouteResult =
  | { kind: 'none' }
  | { kind: 'question'; questionId: string; duplicate?: boolean }
  | { kind: 'answer'; questionId: string; routedTo: string | null };

export interface AskOwnerRouteContext {
  humanRecipientIds?: readonly string[];
}

// Fail closed when a malformed/legacy caller does not provide the channel's
// human audience. A non-empty recipients list keeps every agent delivery path
// targeted; browser SSE still renders the card in real time.
const HUMAN_ONLY_FALLBACK_RECIPIENT = 'ask-owner-human-only';

/** Human-readable line delivered to the asking agent's inbox (writeToParticipantInbox uses message.content). */
export function formatAnswerForAgent(question: StructuredQuestion, answer: StructuredAnswer): string {
  const choice = answer.selectedLabels.length > 0 ? answer.selectedLabels.join(', ') : '(no selection)';
  const targetName = question.askedBy?.name?.trim();
  const mention = targetName ? `@${targetName.replace(/^@+/, '')} ` : '';
  return `${mention}[Ask-Owner] ${HUMAN_ROUTING_NAME} answered your question: "${question.questionText}"\n→ ${choice}`;
}

/**
 * Inspect message.metadata.client and act. MUTATES `message` in place for the
 * answer case (recipients / content / metadata). Returns a small descriptor for
 * logging. A no-op (and zero store calls) for any non-ask-owner message.
 */
export async function handleAskOwnerMessage(
  message: CollabMessage,
  context: AskOwnerRouteContext = {},
): Promise<AskOwnerRouteResult> {
  const client = message.metadata?.client;
  if (!client || typeof client !== 'object') return { kind: 'none' };

  // Question → record it (askedBy lookup table for future answers).
  if (isAskOwnerQuestion(client)) {
    const q = client.payload as StructuredQuestion;
    if (!q || typeof q.id !== 'string') return { kind: 'none' };

    const humanRecipientIds = Array.from(new Set(
      (context.humanRecipientIds ?? []).filter(id => typeof id === 'string' && id.length > 0),
    ));
    message.recipients = humanRecipientIds.length > 0
      ? humanRecipientIds
      : [HUMAN_ONLY_FALLBACK_RECIPIENT];
    message.metadata = {
      ...message.metadata,
      deliveryMode: 'targeted',
    };

    // T1.4 idempotency: a model can invoke ask_owner.py twice inside one turn,
    // posting the same question twice ~90s apart. If an identical PENDING question
    // (askedBy + questionText + channelId) is already on record within the window,
    // suppress this one — hide its card and keep the original entry. Server-side so
    // it catches ANY model double-invoking, not just one wrapper.
    const pid = q.askedBy?.participantId;
    if (pid && typeof q.questionText === 'string' && typeof q.channelId === 'string') {
      const dup = await findRecentDuplicate(pid, q.questionText, q.channelId, DEDUP_WINDOW_MS);
      if (dup && dup.id !== q.id) {
        message.metadata = { ...message.metadata, isHidden: true };
        return { kind: 'question', questionId: dup.id, duplicate: true };
      }
    }
    await recordQuestion(q);
    return { kind: 'question', questionId: q.id };
  }

  // Answer → correlate, mark answered, reshape for targeted delivery.
  if (isAskOwnerAnswer(client)) {
    const answer = client.payload as StructuredAnswer;
    if (!answer || typeof answer.questionId !== 'string') return { kind: 'none' };

    const question = await markAnswered(answer.questionId, answer);
    if (!question) {
      // Unknown question (e.g. posted via a path that didn't record it) — can't route.
      return { kind: 'answer', questionId: answer.questionId, routedTo: null };
    }

    const target = question.askedBy?.participantId ?? null;
    if (target) {
      message.recipients = [target];
      // A question-card answer is a direct response to the agent that asked it.
      // Preserve that semantic in mention metadata as well as recipients so every
      // wrapper labels it as addressed, never as a broadcast.
      message.mentions = [target];
      message.content = formatAnswerForAgent(question, answer);
      message.metadata = {
        ...message.metadata,
        isHidden: true,
        deliveryMode: 'targeted',
      };
    }
    return { kind: 'answer', questionId: answer.questionId, routedTo: target };
  }

  return { kind: 'none' };
}
