/**
 * Message kinds written before the feature was renamed to Ask-owner.
 *
 * An install that already has history keeps stored question and answer messages with these kinds. The
 * guards in types.ts accept them, so old cards still render, pending questions still route and answers
 * from a browser tab opened before the rename still land. New messages always use the ask-owner kinds.
 */
export const LEGACY_ASK_QUESTION_KIND = 'ask-liam.question' as const;
export const LEGACY_ASK_ANSWER_KIND = 'ask-liam.answer' as const;
