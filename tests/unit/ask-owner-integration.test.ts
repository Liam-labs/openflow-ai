import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { handleAskOwnerMessage } from '@/lib/ask-owner/route';
import { getQuestion } from '@/lib/ask-owner/store';
import {
  ASK_OWNER_QUESTION_KIND,
  ASK_OWNER_ANSWER_KIND,
  OTHER_OPTION_ID,
  type StructuredQuestion,
  type StructuredAnswer,
} from '@/lib/ask-owner/types';
import type { CollabMessage } from '@/lib/types';

/**
 * End-to-end at the module level: route ↔ REAL store (no mocks, no HTTP server).
 * Proves the full T1.3 path that handleMessage invokes — record a question, then
 * correlate + mark answered + reshape the answer for targeted delivery.
 */
let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ask-owner-int-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});
afterEach(async () => {
  cwdSpy.mockRestore();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const question: StructuredQuestion = {
  id: 'q-int-1',
  questionText: 'Which database should we use?',
  options: [{ id: 'postgresql', label: 'PostgreSQL' }, { id: 'redis', label: 'Redis' }],
  allowOther: true,
  multiSelect: false,
  askedBy: { participantId: 'roster-builder', name: 'Builder' },
  channelId: 'chan-1',
  status: 'pending',
  answer: null,
  createdAt: '2026-06-03T20:00:00.000Z',
};

function questionMsg(): CollabMessage {
  return {
    id: 'm-q', channelId: 'chan-1',
    from: { id: 'roster-builder', type: 'claude', name: 'Builder', source: 'x', joinedAt: '', lastSeen: '' },
    content: 'Question for Owner: Which database should we use?',
    timestamp: '2026-06-03T20:00:00.000Z',
    recipients: undefined,
    metadata: { client: { kind: ASK_OWNER_QUESTION_KIND, payload: question } },
  };
}

function answerMsg(answer: StructuredAnswer): CollabMessage {
  return {
    id: 'm-a', channelId: 'chan-1',
    from: { id: 'browser-user-owner', type: 'user', name: 'Owner', source: 'web', joinedAt: '', lastSeen: '' },
    content: '(raw answer payload)',
    timestamp: '2026-06-03T20:05:00.000Z',
    recipients: undefined,
    metadata: { client: { kind: ASK_OWNER_ANSWER_KIND, payload: answer } },
  };
}

describe('ask-owner integration (route ↔ real store)', () => {
  it('records a question, then routes its answer back to the asking agent', async () => {
    // 1. Agent asks → recorded as pending.
    const qRes = await handleAskOwnerMessage(questionMsg());
    expect(qRes).toEqual({ kind: 'question', questionId: 'q-int-1' });
    const stored = await getQuestion('q-int-1');
    expect(stored?.status).toBe('pending');
    expect(stored?.askedBy.participantId).toBe('roster-builder');

    // 2. Owner answers → correlated, marked answered, message reshaped for delivery.
    const answer: StructuredAnswer = {
      questionId: 'q-int-1',
      selectedOptionIds: ['postgresql'],
      selectedLabels: ['PostgreSQL'],
      answeredBy: 'browser-user-owner',
      answeredAt: '2026-06-03T20:05:00.000Z',
    };
    const m = answerMsg(answer);
    const aRes = await handleAskOwnerMessage(m);

    expect(aRes).toEqual({ kind: 'answer', questionId: 'q-int-1', routedTo: 'roster-builder' });
    // routed to the asking agent's inbox via the existing delivery flow
    expect(m.recipients).toEqual(['roster-builder']);
    expect(m.mentions).toEqual(['roster-builder']);
    expect(m.content).toBe('@Builder [Ask-Owner] Owner answered your question: "Which database should we use?"\n→ PostgreSQL');
    expect(m.metadata?.isHidden).toBe(true);
    expect(m.metadata?.deliveryMode).toBe('targeted');
    // answer envelope preserved for the UI card-collapse (SSE)
    expect((m.metadata?.client as { kind: string }).kind).toBe(ASK_OWNER_ANSWER_KIND);

    // 3. Store reflects the answer.
    const answered = await getQuestion('q-int-1');
    expect(answered?.status).toBe('answered');
    expect(answered?.answer?.selectedLabels).toEqual(['PostgreSQL']);
    expect(answered?.answeredAt).toBe('2026-06-03T20:05:00.000Z');
  });

  it('routes an Other free-text answer', async () => {
    await handleAskOwnerMessage(questionMsg());
    const answer: StructuredAnswer = {
      questionId: 'q-int-1',
      selectedOptionIds: [OTHER_OPTION_ID],
      selectedLabels: ['Use DuckDB'],
      otherText: 'Use DuckDB',
      answeredBy: 'browser-user-owner',
      answeredAt: '2026-06-03T20:06:00.000Z',
    };
    const m = answerMsg(answer);
    await handleAskOwnerMessage(m);
    expect(m.content).toContain('→ Use DuckDB');
    expect((await getQuestion('q-int-1'))?.answer?.otherText).toBe('Use DuckDB');
  });

  it('leaves an answer for an unknown question unrouted (no store, no reshape)', async () => {
    const m = answerMsg({
      questionId: 'never-asked',
      selectedOptionIds: ['x'],
      selectedLabels: ['X'],
      answeredBy: 'browser-user-owner',
      answeredAt: '2026-06-03T20:07:00.000Z',
    });
    const res = await handleAskOwnerMessage(m);
    expect(res).toEqual({ kind: 'answer', questionId: 'never-asked', routedTo: null });
    expect(m.recipients).toBeUndefined();
    expect(m.content).toBe('(raw answer payload)');
    expect(await getQuestion('never-asked')).toBeNull();
  });
});
