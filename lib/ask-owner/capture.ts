/**
 * ask-owner/capture.ts — T1.1: map a Claude AskUserQuestion tool-use into the shared
 * StructuredQuestion[] (one card per questions[] entry).
 *
 * Claude's AskUserQuestion input is { questions: [{ question, header, multiSelect,
 * options: [{ label, description, preview? }] }] }. Non-Claude agents skip this and
 * build StructuredQuestion directly via the T1.2 helper. `allowOther` is ALWAYS true.
 */

import { randomUUID } from 'node:crypto';
import type { AskOwnerAsker, AskOwnerOption, StructuredQuestion } from './types';

export interface CaptureContext {
  /** Asking agent — route target for the answer. */
  askedBy: AskOwnerAsker;
  /** Channel the question is posted in. */
  channelId: string;
  /** Clock injection for tests; defaults to wall clock. */
  now?: () => string;
  /** Id injection for tests; defaults to randomUUID. */
  idFactory?: () => string;
}

interface RawOption {
  label?: unknown;
  description?: unknown;
}
interface RawQuestion {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** label → stable url-ish slug for an option id. Underscores/punctuation collapse to '-'. */
export function slugifyOptionId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function captureOptions(rawOptions: unknown): AskOwnerOption[] {
  if (!Array.isArray(rawOptions)) return [];
  const used = new Set<string>();
  const out: AskOwnerOption[] = [];
  for (const raw of rawOptions as RawOption[]) {
    const label = str(raw?.label).trim();
    if (!label) continue;
    const base = slugifyOptionId(label) || 'option';
    let id = base;
    let n = 1;
    while (used.has(id)) id = `${base}-${++n}`;
    used.add(id);
    const description = str(raw?.description).trim();
    out.push(description ? { id, label, description } : { id, label });
  }
  return out;
}

/**
 * Map an AskUserQuestion tool-use input into StructuredQuestion[] (one per question).
 * Defensive: non-object or missing `questions` → []. Questions with no text are skipped.
 */
export function captureAskUserQuestion(input: unknown, ctx: CaptureContext): StructuredQuestion[] {
  if (typeof input !== 'object' || input === null) return [];
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];

  const now = ctx.now ?? (() => new Date().toISOString());
  const idFactory = ctx.idFactory ?? (() => randomUUID());

  const out: StructuredQuestion[] = [];
  for (const raw of questions as RawQuestion[]) {
    const questionText = str(raw?.question).trim();
    if (!questionText) continue;
    const q: StructuredQuestion = {
      id: idFactory(),
      questionText,
      options: captureOptions(raw?.options),
      allowOther: true,
      multiSelect: raw?.multiSelect === true,
      askedBy: ctx.askedBy,
      channelId: ctx.channelId,
      status: 'pending',
      answer: null,
      createdAt: now(),
    };
    const header = str(raw?.header).trim();
    if (header) q.header = header;
    out.push(q);
  }
  return out;
}
