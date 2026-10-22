import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the store so we unit-test the routing orchestration + message mutation in
// isolation (the store itself is covered by ask-owner-store.test.ts).
vi.mock('@/lib/ask-owner/store', () => ({
  recordQuestion: vi.fn(async () => {}),
  markAnswered: vi.fn(async () => null),
  getQuestion: vi.fn(async () => null),
  listPending: vi.fn(async () => []),
  findRecentDuplicate: vi.fn(async () => null),
}));

import { handleAskOwnerMessage, formatAnswerForAgent } from '@/lib/ask-owner/route';
import * as store from '@/lib/ask-owner/store';
import {
  ASK_OWNER_QUESTION_KIND,
  ASK_OWNER_ANSWER_KIND,
  OTHER_OPTION_ID,
  type StructuredQuestion,
  type StructuredAnswer,
} from '@/lib/ask-owner/types';
import type { CollabMessage } from '@/lib/types';

const markAnswered = vi.mocked(store.markAnswered);
const recordQuestion = vi.mocked(store.recordQuestion);
const HUMAN_RECIPIENTS = { humanRecipientIds: ['browser-user-owner'] };

beforeEach(() => {
  vi.clearAllMocks();
});

function question(over: Partial<StructuredQuestion> = {}): StructuredQuestion {
  return {
    id: 'q-1',
    questionText: 'Ship it?',
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    allowOther: true,
    multiSelect: false,
    askedBy: { participantId: 'roster-abc', name: 'Builder' },
    channelId: 'chan-1',
    status: 'pending',
    answer: null,
    createdAt: '2026-06-03T20:00:00.000Z',
    ...over,
  };
}

function answer(over: Partial<StructuredAnswer> = {}): StructuredAnswer {
  return {
    questionId: 'q-1',
    selectedOptionIds: ['yes'],
    selectedLabels: ['Yes'],
    answeredBy: 'browser-user-owner',
    answeredAt: '2026-06-03T20:05:00.000Z',
    ...over,
  };
}

function msg(client?: unknown, over: Partial<CollabMessage> = {}): CollabMessage {
  return {
    id: 'm-1',
    channelId: 'chan-1',
    from: { id: 'browser-user-owner', type: 'user', name: 'Owner', source: 'web', joinedAt: '', lastSeen: '' },
    content: 'original content',
    timestamp: '2026-06-03T20:05:00.000Z',
    recipients: undefined,
    metadata: client ? { client: client as Record<string, unknown> } : {},
    ...over,
  };
}

describe('ask-owner route — handleAskOwnerMessage', () => {
  it('no-ops on a plain message (no metadata.client)', async () => {
    const m = msg();
    const r = await handleAskOwnerMessage(m, HUMAN_RECIPIENTS);
    expect(r).toEqual({ kind: 'none' });
    expect(recordQuestion).not.toHaveBeenCalled();
    expect(markAnswered).not.toHaveBeenCalled();
    expect(m.content).toBe('original content');
    expect(m.recipients).toBeUndefined();
  });

  it('no-ops on an unrelated metadata.client kind', async () => {
    const m = msg({ kind: 'outlook.notification', payload: {} });
    expect(await handleAskOwnerMessage(m, HUMAN_RECIPIENTS)).toEqual({ kind: 'none' });
    expect(recordQuestion).not.toHaveBeenCalled();
  });

  it('records a question envelope and targets only the human participant', async () => {
    const q = question();
    const m = msg({ kind: ASK_OWNER_QUESTION_KIND, payload: q });
    const r = await handleAskOwnerMessage(m, HUMAN_RECIPIENTS);
    expect(r).toEqual({ kind: 'question', questionId: 'q-1' });
    expect(recordQuestion).toHaveBeenCalledTimes(1);
    expect(recordQuestion).toHaveBeenCalledWith(q);
    // The browser still renders the card, but agent wrappers must not receive it.
    expect(m.content).toBe('original content');
    expect(m.recipients).toEqual(['browser-user-owner']);
    expect(m.metadata?.deliveryMode).toBe('targeted');
    expect(m.metadata?.isHidden).toBeUndefined();
  });

  it('routes an answer to the asking agent and reshapes the (hidden) message', async () => {
    markAnswered.mockResolvedValueOnce(question());
    const a = answer();
    const m = msg({ kind: ASK_OWNER_ANSWER_KIND, payload: a });
    const r = await handleAskOwnerMessage(m, HUMAN_RECIPIENTS);
    expect(markAnswered).toHaveBeenCalledWith('q-1', a);
    expect(r).toEqual({ kind: 'answer', questionId: 'q-1', routedTo: 'roster-abc' });
    expect(m.recipients).toEqual(['roster-abc']);
    expect(m.mentions).toEqual(['roster-abc']);
    expect(m.content).toBe('@Builder [Ask-Owner] Owner answered your question: "Ship it?"\n→ Yes');
    expect(m.metadata?.isHidden).toBe(true);
    expect(m.metadata?.deliveryMode).toBe('targeted');
  });

  it('does not mutate the message when the question is unknown', async () => {
    markAnswered.mockResolvedValueOnce(null);
    const m = msg({ kind: ASK_OWNER_ANSWER_KIND, payload: answer({ questionId: 'ghost' }) });
    const r = await handleAskOwnerMessage(m, HUMAN_RECIPIENTS);
    expect(r).toEqual({ kind: 'answer', questionId: 'ghost', routedTo: null });
    expect(m.content).toBe('original content');
    expect(m.recipients).toBeUndefined();
  });

  it('no-ops on an answer envelope missing questionId', async () => {
    const m = msg({ kind: ASK_OWNER_ANSWER_KIND, payload: { selectedLabels: ['x'] } });
    expect(await handleAskOwnerMessage(m, HUMAN_RECIPIENTS)).toEqual({ kind: 'none' });
    expect(markAnswered).not.toHaveBeenCalled();
  });

  it('renders the Other free-text answer via selectedLabels', async () => {
    markAnswered.mockResolvedValueOnce(question());
    const a = answer({ selectedOptionIds: [OTHER_OPTION_ID], selectedLabels: ['Use DuckDB instead'], otherText: 'Use DuckDB instead' });
    const m = msg({ kind: ASK_OWNER_ANSWER_KIND, payload: a });
    await handleAskOwnerMessage(m, HUMAN_RECIPIENTS);
    expect(m.content).toContain('→ Use DuckDB instead');
  });
});

describe('ask-owner route — formatAnswerForAgent', () => {
  it('joins multiple labels for a multiSelect answer', () => {
    const text = formatAnswerForAgent(
      question({ multiSelect: true }),
      answer({ selectedOptionIds: ['yes', 'no'], selectedLabels: ['Yes', 'No'] })
    );
    expect(text).toContain('@Builder [Ask-Owner]');
    expect(text).toContain('→ Yes, No');
  });

  it('falls back to a placeholder when nothing is selected', () => {
    const text = formatAnswerForAgent(question(), answer({ selectedOptionIds: [], selectedLabels: [] }));
    expect(text).toContain('(no selection)');
  });
});

describe('messages written before the rename', () => {
  it('still counts as an ask-owner question and answer', async () => {
    const { isAskOwnerAnswer, isAskOwnerQuestion } = await import('@/lib/ask-owner/types');
    const { LEGACY_ASK_ANSWER_KIND, LEGACY_ASK_QUESTION_KIND } = await import('@/lib/ask-owner/legacy-kinds');
    expect(isAskOwnerQuestion({ kind: LEGACY_ASK_QUESTION_KIND, payload: {} })).toBe(true);
    expect(isAskOwnerAnswer({ kind: LEGACY_ASK_ANSWER_KIND, payload: {} })).toBe(true);
    expect(isAskOwnerQuestion({ kind: LEGACY_ASK_ANSWER_KIND, payload: {} })).toBe(false);
    expect(isAskOwnerAnswer({ kind: 'something-else', payload: {} })).toBe(false);
  });
});
