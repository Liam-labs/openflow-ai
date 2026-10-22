import { describe, it, expect } from 'vitest';
import {
  ASK_OWNER_QUESTION_KIND,
  ASK_OWNER_ANSWER_KIND,
  type StructuredQuestion,
  type StructuredAnswer,
} from '@/lib/ask-owner/types';
import {
  collectAnswers,
  isDismissedAnsweredQuestion,
  isQuestionAnswered,
  selectPendingQuestions,
} from '@/lib/ask-owner/pending';

/**
 * T2.3 — the pure partition logic behind the floating overlay:
 *   pending (unanswered) ask-owner questions float bottom-right;
 *   answered ones drop from the corner and stay inline as the record.
 * This tests the selector that decides which questions are "still pending".
 */

function q(over: Partial<StructuredQuestion> = {}): StructuredQuestion {
  return {
    id: 'q-1',
    questionText: 'Ship it?',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    allowOther: true,
    multiSelect: false,
    askedBy: { participantId: 'roster-m', name: 'Morpheus' },
    channelId: 'chan-1',
    status: 'pending',
    answer: null,
    createdAt: '2026-06-04T08:00:00.000Z',
    ...over,
  };
}

function answer(over: Partial<StructuredAnswer> = {}): StructuredAnswer {
  return {
    questionId: 'q-1',
    selectedOptionIds: ['yes'],
    selectedLabels: ['Yes'],
    answeredBy: 'owner',
    answeredAt: '2026-06-04T08:01:00.000Z',
    ...over,
  };
}

// Minimal CollabMessage-shaped object (selector reads only id + metadata.client).
function qmsg(question: StructuredQuestion, id = `m-${question.id}`) {
  return { id, metadata: { client: { kind: ASK_OWNER_QUESTION_KIND, payload: question } } };
}
function amsg(ans: StructuredAnswer, id = `a-${ans.questionId}`) {
  return { id, metadata: { client: { kind: ASK_OWNER_ANSWER_KIND, payload: ans } } };
}
function plain(id: string) {
  return { id, content: 'just a normal message', metadata: {} };
}

describe('collectAnswers', () => {
  it('maps questionId → answer for every answer envelope', () => {
    const map = collectAnswers([
      qmsg(q({ id: 'q-1' })),
      amsg(answer({ questionId: 'q-1' })),
      amsg(answer({ questionId: 'q-2', selectedLabels: ['No'], selectedOptionIds: ['no'] })),
    ]);
    expect(map.size).toBe(2);
    expect(map.get('q-1')?.selectedLabels).toEqual(['Yes']);
    expect(map.get('q-2')?.selectedLabels).toEqual(['No']);
  });

  it('ignores non-answer messages', () => {
    const map = collectAnswers([qmsg(q()), plain('p-1')]);
    expect(map.size).toBe(0);
  });
});

describe('isQuestionAnswered', () => {
  it('true when status is answered (no answer envelope needed)', () => {
    expect(isQuestionAnswered(q({ status: 'answered' }), new Map())).toBe(true);
  });

  it('true when a matching answer envelope exists', () => {
    const map = new Map([['q-1', answer({ questionId: 'q-1' })]]);
    expect(isQuestionAnswered(q({ id: 'q-1', status: 'pending' }), map)).toBe(true);
  });

  it('false when pending and no answer envelope', () => {
    expect(isQuestionAnswered(q({ id: 'q-9', status: 'pending' }), new Map())).toBe(false);
  });
});

describe('isDismissedAnsweredQuestion', () => {
  it('hides an answered question whose id was dismissed', () => {
    expect(isDismissedAnsweredQuestion(
      q({ id: 'q-1', status: 'answered' }),
      new Map(),
      new Set(['q-1']),
    )).toBe(true);
  });

  it('never hides a pending question, even if a stale dismissal contains its id', () => {
    expect(isDismissedAnsweredQuestion(
      q({ id: 'q-1', status: 'pending' }),
      new Map(),
      new Set(['q-1']),
    )).toBe(false);
  });
});

describe('selectPendingQuestions', () => {
  it('returns only unanswered questions', () => {
    const messages = [
      qmsg(q({ id: 'q-1', status: 'pending' })),
      qmsg(q({ id: 'q-2', status: 'answered' })),       // answered by status → excluded
      qmsg(q({ id: 'q-3', status: 'pending' })),
      amsg(answer({ questionId: 'q-3' })),               // answered by envelope → excluded
      qmsg(q({ id: 'q-4', status: 'pending' })),
    ];
    const pending = selectPendingQuestions(messages, collectAnswers(messages));
    expect(pending.map((p) => p.question.id)).toEqual(['q-1', 'q-4']);
  });

  it('preserves message order (oldest → newest) so newest renders nearest the corner', () => {
    const messages = [
      qmsg(q({ id: 'old', createdAt: '2026-06-04T08:00:00.000Z' })),
      qmsg(q({ id: 'mid', createdAt: '2026-06-04T08:05:00.000Z' })),
      qmsg(q({ id: 'new', createdAt: '2026-06-04T08:10:00.000Z' })),
    ];
    const pending = selectPendingQuestions(messages, collectAnswers(messages));
    expect(pending.map((p) => p.question.id)).toEqual(['old', 'mid', 'new']);
  });

  it('carries the source messageId for each pending question', () => {
    const pending = selectPendingQuestions([qmsg(q({ id: 'q-7' }), 'msg-7')], new Map());
    expect(pending).toEqual([{ messageId: 'msg-7', question: expect.objectContaining({ id: 'q-7' }) }]);
  });

  it('ignores non-ask-owner messages', () => {
    const pending = selectPendingQuestions([plain('p-1'), amsg(answer({ questionId: 'q-x' }))], new Map());
    expect(pending).toEqual([]);
  });

  it('returns empty when there are no questions', () => {
    expect(selectPendingQuestions([], new Map())).toEqual([]);
  });
});
