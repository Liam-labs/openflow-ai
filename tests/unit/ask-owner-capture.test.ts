import { describe, it, expect } from 'vitest';
import { captureAskUserQuestion, type CaptureContext } from '@/lib/ask-owner/capture';
import { OTHER_OPTION_ID } from '@/lib/ask-owner/types';

/** Deterministic context: counter ids + fixed clock so assertions are stable. */
function ctx(over: Partial<CaptureContext> = {}): CaptureContext {
  let n = 0;
  return {
    askedBy: { participantId: 'roster-abc', name: 'Builder' },
    channelId: 'chan-1',
    now: () => '2026-06-03T20:00:00.000Z',
    idFactory: () => `q${++n}`,
    ...over,
  };
}

const oneQuestion = {
  questions: [
    {
      question: 'Which database should we use?',
      header: 'Database',
      multiSelect: false,
      options: [
        { label: 'PostgreSQL', description: 'Relational, strong consistency' },
        { label: 'Redis', description: 'In-memory, fast' },
      ],
    },
  ],
};

describe('captureAskUserQuestion — AskUserQuestion tool-use → StructuredQuestion[]', () => {
  it('maps a single question with full field fidelity', () => {
    const [q] = captureAskUserQuestion(oneQuestion, ctx());
    expect(q.id).toBe('q1');
    expect(q.questionText).toBe('Which database should we use?');
    expect(q.header).toBe('Database');
    expect(q.multiSelect).toBe(false);
    expect(q.allowOther).toBe(true); // ALWAYS injected
    expect(q.status).toBe('pending');
    expect(q.answer).toBeNull();
    expect(q.askedBy).toEqual({ participantId: 'roster-abc', name: 'Builder' });
    expect(q.channelId).toBe('chan-1');
    expect(q.createdAt).toBe('2026-06-03T20:00:00.000Z');
    expect(q.options).toEqual([
      { id: 'postgresql', label: 'PostgreSQL', description: 'Relational, strong consistency' },
      { id: 'redis', label: 'Redis', description: 'In-memory, fast' },
    ]);
  });

  it('emits one StructuredQuestion per questions[] entry', () => {
    const input = {
      questions: [
        { question: 'Q1?', header: 'A', multiSelect: false, options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }] },
        { question: 'Q2?', header: 'B', multiSelect: true, options: [{ label: 'Z', description: '' }, { label: 'W', description: '' }] },
      ],
    };
    const out = captureAskUserQuestion(input, ctx());
    expect(out).toHaveLength(2);
    expect(out[0].questionText).toBe('Q1?');
    expect(out[1].questionText).toBe('Q2?');
    expect(out[0].id).toBe('q1');
    expect(out[1].id).toBe('q2');
  });

  it('preserves multiSelect=true', () => {
    const input = { questions: [{ question: 'Pick many?', header: 'M', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] };
    const [q] = captureAskUserQuestion(input, ctx());
    expect(q.multiSelect).toBe(true);
  });

  it('omits header when absent or empty', () => {
    const input = { questions: [{ question: 'No header?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] };
    const [q] = captureAskUserQuestion(input, ctx());
    expect(q.header).toBeUndefined();
  });

  it('omits option description when absent or empty', () => {
    const input = { questions: [{ question: 'Q?', multiSelect: false, options: [{ label: 'A' }, { label: 'B', description: '' }] }] };
    const [q] = captureAskUserQuestion(input, ctx());
    expect(q.options[0].description).toBeUndefined();
    expect(q.options[1].description).toBeUndefined();
  });

  it('slugifies option ids from labels and de-dupes collisions', () => {
    const input = {
      questions: [
        {
          question: 'Q?',
          multiSelect: false,
          options: [
            { label: 'Use Cache' },
            { label: 'use cache' }, // collides with above after slug
            { label: 'Skip it!' },
          ],
        },
      ],
    };
    const [q] = captureAskUserQuestion(input, ctx());
    expect(q.options.map((o) => o.id)).toEqual(['use-cache', 'use-cache-2', 'skip-it']);
  });

  it('never collides a generated option id with the reserved Other id', () => {
    const input = { questions: [{ question: 'Q?', multiSelect: false, options: [{ label: '__other__' }, { label: 'Real' }] }] };
    const [q] = captureAskUserQuestion(input, ctx());
    expect(q.options.map((o) => o.id)).not.toContain(OTHER_OPTION_ID);
  });

  it('returns [] for non-object / missing questions (defensive)', () => {
    expect(captureAskUserQuestion(null, ctx())).toEqual([]);
    expect(captureAskUserQuestion('nope', ctx())).toEqual([]);
    expect(captureAskUserQuestion({}, ctx())).toEqual([]);
    expect(captureAskUserQuestion({ questions: 'x' }, ctx())).toEqual([]);
  });

  it('skips questions with empty/missing question text', () => {
    const input = {
      questions: [
        { question: '', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: '  ', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Real?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
      ],
    };
    const out = captureAskUserQuestion(input, ctx());
    expect(out).toHaveLength(1);
    expect(out[0].questionText).toBe('Real?');
  });

  it('tolerates a question with no options (Other still lets Owner answer)', () => {
    const input = { questions: [{ question: 'Open?', multiSelect: false }] };
    const [q] = captureAskUserQuestion(input, ctx());
    expect(q.options).toEqual([]);
    expect(q.allowOther).toBe(true);
  });
});
