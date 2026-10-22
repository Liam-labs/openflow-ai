/**
 * Pure selectors that partition ask-owner questions into pending vs answered.
 *
 * The floating overlay (T2.3) renders ONLY pending (unanswered) questions
 * bottom-right of the chat window; answered questions drop out of the corner
 * and stay inline as the conversation record. This module owns the "which
 * questions are still pending" decision so it can be unit-tested without React.
 */
import {
  isAskOwnerQuestion,
  isAskOwnerAnswer,
  type StructuredQuestion,
  type StructuredAnswer,
} from './types';

/** Minimal message shape the selectors read — keeps them decoupled from CollabMessage. */
interface ClientMetaMessage {
  id: string;
  metadata?: { client?: unknown } | null;
}

export interface PendingQuestion {
  /** Source message id (the question's CollabMessage). */
  messageId: string;
  question: StructuredQuestion;
}

/** Map<questionId, StructuredAnswer> built from every answer envelope in the list. */
export function collectAnswers(messages: ClientMetaMessage[]): Map<string, StructuredAnswer> {
  const map = new Map<string, StructuredAnswer>();
  for (const m of messages) {
    const client = m.metadata?.client;
    if (isAskOwnerAnswer(client)) {
      const ans = client.payload;
      if (ans?.questionId) map.set(ans.questionId, ans);
    }
  }
  return map;
}

/** A question is answered if its lifecycle says so OR a routed answer envelope exists. */
export function isQuestionAnswered(
  question: StructuredQuestion,
  answers: Map<string, StructuredAnswer>,
): boolean {
  return question.status === 'answered' || answers.has(question.id);
}

/** Dismissal applies only after an answer exists; pending questions must remain actionable. */
export function isDismissedAnsweredQuestion(
  question: StructuredQuestion,
  answers: Map<string, StructuredAnswer>,
  dismissedQuestionIds: ReadonlySet<string>,
): boolean {
  return dismissedQuestionIds.has(question.id) && isQuestionAnswered(question, answers);
}

/**
 * Unanswered ask-owner questions in message order (oldest → newest).
 * Rendered in a bottom-anchored flex column, the newest sits nearest the corner.
 */
export function selectPendingQuestions(
  messages: ClientMetaMessage[],
  answers: Map<string, StructuredAnswer>,
): PendingQuestion[] {
  const out: PendingQuestion[] = [];
  for (const m of messages) {
    const client = m.metadata?.client;
    if (isAskOwnerQuestion(client)) {
      const question = client.payload;
      if (!isQuestionAnswered(question, answers)) {
        out.push({ messageId: m.id, question });
      }
    }
  }
  return out;
}
