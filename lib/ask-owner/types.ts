/**
 * ask-owner/types.ts — Cross-model structured-question schema (Sprint "Ask-owner", T1.1).
 *
 * Shared, model-agnostic format for an agent question to the owner that renders as
 * clickable answer buttons (+ an "Other" free-text option) instead of a typed reply.
 *
 * Transport: carried on the existing CollabMessage.metadata.client passthrough — the
 * sanctioned client-payload channel (the /api/agent collab.message handler accepts only
 * the `client` metadata subkey from request bodies; first consumer: outlook-events.ts).
 *   ask  →  metadata.client = { kind: ASK_OWNER_QUESTION_KIND, payload: StructuredQuestion }
 *   answer → metadata.client = { kind: ASK_OWNER_ANSWER_KIND,  payload: StructuredAnswer }
 *
 * Capture: Claude agents map their AskUserQuestion tool-use INTO this format (capture.ts);
 * non-Claude agents construct it directly via the T1.2 helper. One AskUserQuestion
 * `questions[]` entry maps to one StructuredQuestion (one card).
 *
 * This file is the LOCKED contract — Daniel's T2.x UI renders from it, T1.3 routes against
 * it. Treat the field set as stable; additive-only changes after lock.
 */

import { LEGACY_ASK_ANSWER_KIND, LEGACY_ASK_QUESTION_KIND } from './legacy-kinds';

/** metadata.client.kind discriminator — an agent asking the owner a structured question. */
export const ASK_OWNER_QUESTION_KIND = 'ask-owner.question' as const;
/** metadata.client.kind discriminator — the owner's answer routed back to the asking agent. */
export const ASK_OWNER_ANSWER_KIND = 'ask-owner.answer' as const;

/** Reserved option id used when the owner picks the injected "Other" free-text choice. */
export const OTHER_OPTION_ID = '__other__';

/** A single clickable answer choice. */
export interface AskOwnerOption {
  /** Stable id routed back in the answer. Derived from the label (slugified) unless set. */
  id: string;
  /** Button text (concise, 1-5 words). */
  label: string;
  /** Optional one-line explanation / tradeoff shown under the label. */
  description?: string;
}

export type QuestionStatus = 'pending' | 'answered';

/** The asking agent — used to route the owner's answer back to it. */
export interface AskOwnerAsker {
  /** Asking agent's participant id (route target). */
  participantId: string;
  /** Asking agent's display name. */
  name: string;
}

/** The structured question payload. */
export interface StructuredQuestion {
  /** Unique id — correlates the owner's answer back to this question (T1.3 routing). */
  id: string;
  /** The question prompt shown to the owner. */
  questionText: string;
  /** Optional short chip/header (<=12 chars). Sourced from AskUserQuestion `header`. */
  header?: string;
  /** 2-4 real choices. Does NOT include "Other" — that is driven by `allowOther`. */
  options: AskOwnerOption[];
  /** Always true: the helper guarantees an "Other" free-text path alongside the options. */
  allowOther: boolean;
  /** Multi-select support. Default false — one-click single answer is the golden path. */
  multiSelect: boolean;
  /** Who asked — route target for the answer. */
  askedBy: AskOwnerAsker;
  /** Channel the question lives in. */
  channelId: string;
  /** Lifecycle state. */
  status: QuestionStatus;
  /** the owner's answer; null until answered. */
  answer: StructuredAnswer | null;
  /** ISO timestamp when asked. */
  createdAt: string;
  /** ISO timestamp when answered (set together with status='answered'). */
  answeredAt?: string;
}

/** the owner's answer to a structured question. */
export interface StructuredAnswer {
  /** Id of the answered question (matches StructuredQuestion.id). */
  questionId: string;
  /** Selected option id(s). "Other" => [OTHER_OPTION_ID]. Array supports multiSelect. */
  selectedOptionIds: string[];
  /** Selected label(s), for display + agent consumption. For "Other" => the otherText. */
  selectedLabels: string[];
  /** Free text supplied for the "Other" choice (present only when Other was chosen). */
  otherText?: string;
  /** Who answered — the owner's participant id. */
  answeredBy: string;
  /** ISO timestamp when answered. */
  answeredAt: string;
}

/** Discriminated client-metadata union as it rides on CollabMessage.metadata.client. */
export interface AskOwnerQuestionEnvelope {
  kind: typeof ASK_OWNER_QUESTION_KIND | typeof LEGACY_ASK_QUESTION_KIND;
  payload: StructuredQuestion;
}
export interface AskOwnerAnswerEnvelope {
  kind: typeof ASK_OWNER_ANSWER_KIND | typeof LEGACY_ASK_ANSWER_KIND;
  payload: StructuredAnswer;
}
export type AskOwnerClientMetadata = AskOwnerQuestionEnvelope | AskOwnerAnswerEnvelope;

function isOneOf(v: object, ...kinds: string[]): boolean {
  const kind = (v as { kind?: unknown }).kind;
  return typeof kind === 'string' && kinds.includes(kind);
}

/** Narrowing guard for an inbound ask-owner question envelope on metadata.client. */
export function isAskOwnerQuestion(v: unknown): v is AskOwnerQuestionEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    isOneOf(v, ASK_OWNER_QUESTION_KIND, LEGACY_ASK_QUESTION_KIND) &&
    typeof (v as { payload?: unknown }).payload === 'object' &&
    (v as { payload?: unknown }).payload !== null
  );
}

/** Narrowing guard for an inbound ask-owner answer envelope on metadata.client. */
export function isAskOwnerAnswer(v: unknown): v is AskOwnerAnswerEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    isOneOf(v, ASK_OWNER_ANSWER_KIND, LEGACY_ASK_ANSWER_KIND) &&
    typeof (v as { payload?: unknown }).payload === 'object' &&
    (v as { payload?: unknown }).payload !== null
  );
}
