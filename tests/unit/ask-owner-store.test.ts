import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  recordQuestion,
  getQuestion,
  markAnswered,
  listPending,
  getAskOwnerStorePath,
} from '@/lib/ask-owner/store';
import type { StructuredQuestion, StructuredAnswer } from '@/lib/ask-owner/types';

/** A fresh cwd per test so the store path (re-derived from cwd) is isolated. */
let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ask-owner-store-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(async () => {
  cwdSpy.mockRestore();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function q(over: Partial<StructuredQuestion> = {}): StructuredQuestion {
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

function ans(over: Partial<StructuredAnswer> = {}): StructuredAnswer {
  return {
    questionId: 'q-1',
    selectedOptionIds: ['yes'],
    selectedLabels: ['Yes'],
    answeredBy: 'browser-user-owner',
    answeredAt: '2026-06-03T20:05:00.000Z',
    ...over,
  };
}

describe('ask-owner store', () => {
  it('records a question and reads it back by id', async () => {
    await recordQuestion(q());
    const got = await getQuestion('q-1');
    expect(got).not.toBeNull();
    expect(got!.questionText).toBe('Ship it?');
    expect(got!.askedBy.participantId).toBe('roster-abc');
    expect(got!.status).toBe('pending');
  });

  it('writes the store under .AppData of the (mocked) cwd', async () => {
    await recordQuestion(q());
    const p = getAskOwnerStorePath();
    expect(p).toBe(path.join(tmpDir, '.AppData', 'ask-owner-questions.json'));
    await expect(fs.stat(p)).resolves.toBeTruthy();
  });

  it('returns null for an unknown question id', async () => {
    expect(await getQuestion('nope')).toBeNull();
  });

  it('marks a question answered and stamps the answer', async () => {
    await recordQuestion(q());
    const updated = await markAnswered('q-1', ans());
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('answered');
    expect(updated!.answer).toEqual(ans());
    expect(updated!.answeredAt).toBe('2026-06-03T20:05:00.000Z');
    const reread = await getQuestion('q-1');
    expect(reread!.status).toBe('answered');
    expect(reread!.answer!.selectedLabels).toEqual(['Yes']);
  });

  it('returns null when marking an unknown question answered', async () => {
    expect(await markAnswered('ghost', ans({ questionId: 'ghost' }))).toBeNull();
  });

  it('lists only pending questions, optionally scoped by channel', async () => {
    await recordQuestion(q({ id: 'q-1', channelId: 'chan-1' }));
    await recordQuestion(q({ id: 'q-2', channelId: 'chan-2' }));
    await recordQuestion(q({ id: 'q-3', channelId: 'chan-1' }));
    await markAnswered('q-3', ans({ questionId: 'q-3' }));

    const allPending = await listPending();
    expect(allPending.map((x) => x.id).sort()).toEqual(['q-1', 'q-2']);

    const chan1 = await listPending('chan-1');
    expect(chan1.map((x) => x.id)).toEqual(['q-1']);
  });

  it('re-recording an id overwrites a still-pending entry', async () => {
    await recordQuestion(q({ questionText: 'first' }));
    await recordQuestion(q({ questionText: 'second' }));
    expect((await getQuestion('q-1'))!.questionText).toBe('second');
  });

  it('does not clobber an already-answered question on re-record', async () => {
    await recordQuestion(q());
    await markAnswered('q-1', ans());
    await recordQuestion(q({ questionText: 'stale repost', status: 'pending', answer: null }));
    const got = await getQuestion('q-1');
    expect(got!.status).toBe('answered');
    expect(got!.questionText).toBe('Ship it?');
  });
});
