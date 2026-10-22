import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { recordQuestion, findRecentDuplicate, getQuestion, listPending } from '@/lib/ask-owner/store';
import { handleAskOwnerMessage } from '@/lib/ask-owner/route';
import { ASK_OWNER_QUESTION_KIND, type StructuredQuestion } from '@/lib/ask-owner/types';
import type { CollabMessage } from '@/lib/types';

/**
 * T1.4 — idempotency dedup. A model can invoke ask_owner.py twice inside one turn
 * (~90s apart), posting the SAME question twice. The dedup suppresses the second:
 * keep the original store entry, hide the duplicate card.
 */
let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ask-owner-dedup-'));
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
    askedBy: { participantId: 'roster-m', name: 'Morpheus' },
    channelId: 'chan-1',
    status: 'pending',
    answer: null,
    createdAt: '2026-06-03T20:00:00.000Z',
    ...over,
  };
}

function qmsg(question: StructuredQuestion): CollabMessage {
  return {
    id: `m-${question.id}`,
    channelId: question.channelId,
    from: { id: question.askedBy.participantId, type: 'claude', name: question.askedBy.name, source: 'x', joinedAt: '', lastSeen: '' },
    content: 'Question for Owner: ...',
    timestamp: question.createdAt,
    metadata: { client: { kind: ASK_OWNER_QUESTION_KIND, payload: question } },
  };
}

describe('store.findRecentDuplicate', () => {
  const NOW = Date.parse('2026-06-03T20:00:30.000Z'); // 30s after q createdAt

  it('finds a pending identical question within the window', async () => {
    await recordQuestion(q());
    const dup = await findRecentDuplicate('roster-m', 'Ship it?', 'chan-1', 120_000, NOW);
    expect(dup?.id).toBe('q-1');
  });

  it('returns null outside the window', async () => {
    await recordQuestion(q({ createdAt: '2026-06-03T19:55:00.000Z' })); // 5m before NOW
    expect(await findRecentDuplicate('roster-m', 'Ship it?', 'chan-1', 120_000, NOW)).toBeNull();
  });

  it('returns null for a different participant, text, or channel', async () => {
    await recordQuestion(q());
    expect(await findRecentDuplicate('roster-OTHER', 'Ship it?', 'chan-1', 120_000, NOW)).toBeNull();
    expect(await findRecentDuplicate('roster-m', 'Different?', 'chan-1', 120_000, NOW)).toBeNull();
    expect(await findRecentDuplicate('roster-m', 'Ship it?', 'chan-OTHER', 120_000, NOW)).toBeNull();
  });

  it('ignores an already-answered question (a fresh ask is legitimate)', async () => {
    await recordQuestion(q({ status: 'answered' }));
    expect(await findRecentDuplicate('roster-m', 'Ship it?', 'chan-1', 120_000, NOW)).toBeNull();
  });
});

describe('handleAskOwnerMessage dedup (T1.4)', () => {
  it('records the first, hides the duplicate, store keeps exactly one', async () => {
    const now = new Date().toISOString();
    const r1 = await handleAskOwnerMessage(qmsg(q({ id: 'q-1', createdAt: now })));
    expect(r1).toMatchObject({ kind: 'question', questionId: 'q-1' });

    const m2 = qmsg(q({ id: 'q-2', createdAt: now })); // identical content, fresh id, within window
    const r2 = await handleAskOwnerMessage(m2);
    expect(r2).toMatchObject({ kind: 'question', questionId: 'q-1', duplicate: true });
    expect(m2.metadata?.isHidden).toBe(true);
    expect(await getQuestion('q-2')).toBeNull();
    expect((await listPending()).map((x) => x.id)).toEqual(['q-1']);
  });

  it('records a non-duplicate (different text) and does not hide it', async () => {
    const now = new Date().toISOString();
    await handleAskOwnerMessage(qmsg(q({ id: 'q-1', createdAt: now })));
    const m2 = qmsg(q({ id: 'q-2', questionText: 'Different?', createdAt: now }));
    const r2 = await handleAskOwnerMessage(m2);
    expect(r2).toMatchObject({ kind: 'question', questionId: 'q-2' });
    expect(r2).not.toHaveProperty('duplicate', true);
    expect(m2.metadata?.isHidden).toBeUndefined();
    expect((await listPending()).map((x) => x.id).sort()).toEqual(['q-1', 'q-2']);
  });

  it('records an identical question posted OUTSIDE the window (legitimate re-ask)', async () => {
    // original recorded 5 minutes ago
    await recordQuestion(q({ id: 'q-old', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    const m2 = qmsg(q({ id: 'q-new', createdAt: new Date().toISOString() }));
    const r2 = await handleAskOwnerMessage(m2);
    expect(r2).toMatchObject({ kind: 'question', questionId: 'q-new' });
    expect(m2.metadata?.isHidden).toBeUndefined();
    expect((await listPending()).map((x) => x.id).sort()).toEqual(['q-new', 'q-old']);
  });
});
