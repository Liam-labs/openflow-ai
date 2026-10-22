/**
 * ask-owner/store.ts — server-side persistence for structured questions (T1.3).
 *
 * Why a store: the owner's answer (StructuredAnswer) carries only `questionId`, but
 * to route it back we need the asking agent's participantId — which lives on the
 * StructuredQuestion (askedBy). We record every question when its
 * `ask-owner.question` envelope lands in handleMessage, then look it up by id
 * when the matching answer arrives.
 *
 * Store: .AppData/ask-owner-questions.json (flock-guarded via withFileLock,
 * server-owned). The path is re-derived from process.cwd() on every call — never
 * a module-level constant — so tests can redirect cwd.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { withFileLock, readJsonFile, writeJsonFile } from '@/lib/data-io';
import type { StructuredQuestion, StructuredAnswer } from './types';
import { appPath } from '@/lib/app-paths';

interface AskOwnerStore {
  /** Keyed by StructuredQuestion.id for O(1) answer correlation. */
  questions: Record<string, StructuredQuestion>;
  lastUpdated: string;
}

/** Fresh default each call — never a shared const (readJsonFile returns the
 *  default by reference on ENOENT, and callers mutate it). */
const emptyStore = (): AskOwnerStore => ({ questions: {}, lastUpdated: '' });

function getAppdataDir(): string {
  return appPath('.AppData');
}

export function getAskOwnerStorePath(): string {
  return path.join(getAppdataDir(), 'ask-owner-questions.json');
}

/**
 * Upsert a question. Idempotent on id: a re-post overwrites a still-pending
 * entry, but never clobbers one already answered (guards against a stale
 * duplicate question message landing after the answer).
 */
export async function recordQuestion(question: StructuredQuestion): Promise<void> {
  const storePath = getAskOwnerStorePath();
  await fs.mkdir(getAppdataDir(), { recursive: true });
  await withFileLock(storePath, async () => {
    const store = await readJsonFile<AskOwnerStore>(storePath, emptyStore());
    const existing = store.questions[question.id];
    if (existing && existing.status === 'answered') return;
    store.questions[question.id] = question;
    store.lastUpdated = new Date().toISOString();
    await writeJsonFile(storePath, store);
  });
}

/** Read a question by id, or null if unknown. */
export async function getQuestion(questionId: string): Promise<StructuredQuestion | null> {
  const store = await readJsonFile<AskOwnerStore>(getAskOwnerStorePath(), emptyStore());
  return store.questions[questionId] ?? null;
}

/**
 * Find a still-PENDING question with the same (askedBy.participantId, questionText,
 * channelId) created within `windowMs` of `now`. Used to dedup a model that
 * double-invokes ask_owner.py inside one turn (T1.4) — same question posted twice
 * ~90s apart. Returns the original (so the duplicate can resolve to its id), or null.
 * Answered questions are ignored — a later identical ask is legitimate, not a dup.
 */
export async function findRecentDuplicate(
  participantId: string,
  questionText: string,
  channelId: string,
  windowMs: number,
  now: number = Date.now()
): Promise<StructuredQuestion | null> {
  const store = await readJsonFile<AskOwnerStore>(getAskOwnerStorePath(), emptyStore());
  for (const q of Object.values(store.questions)) {
    if (q.status !== 'pending') continue;
    if (q.askedBy?.participantId !== participantId) continue;
    if (q.questionText !== questionText) continue;
    if (q.channelId !== channelId) continue;
    const age = now - new Date(q.createdAt).getTime();
    if (age >= 0 && age <= windowMs) return q;
  }
  return null;
}

/**
 * Mark a question answered and stamp the answer. Returns the updated question,
 * or null if the id is unknown (answer can't be correlated → caller logs/skips).
 */
export async function markAnswered(
  questionId: string,
  answer: StructuredAnswer
): Promise<StructuredQuestion | null> {
  const storePath = getAskOwnerStorePath();
  return withFileLock(storePath, async () => {
    const store = await readJsonFile<AskOwnerStore>(storePath, emptyStore());
    const q = store.questions[questionId];
    if (!q) return null;
    q.status = 'answered';
    q.answer = answer;
    q.answeredAt = answer.answeredAt;
    store.lastUpdated = new Date().toISOString();
    await writeJsonFile(storePath, store);
    return q;
  });
}

/** Pending (unanswered) questions, optionally scoped to a channel — for badges/audits. */
export async function listPending(channelId?: string): Promise<StructuredQuestion[]> {
  const store = await readJsonFile<AskOwnerStore>(getAskOwnerStorePath(), emptyStore());
  return Object.values(store.questions).filter(
    (q) => q.status === 'pending' && (!channelId || q.channelId === channelId)
  );
}
