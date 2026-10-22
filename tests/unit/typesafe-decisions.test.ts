import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  pageJevDecisions,
  readJevDecisions,
  summarizeJevDecisions,
  validateJevRun,
  type JevDecisionRecord,
} from '@/lib/typesafe-decisions';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function rec(id: string, hoursAgo: number, extra: Partial<JevDecisionRecord> = {}): JevDecisionRecord {
  return {
    id, ts: new Date(NOW - hoursAgo * 3_600_000).toISOString(), caller: 'Builder', transport: 'mcp',
    model: 'jev-1.13.0', latencyMs: 300, ok: true, usage: { input_tokens: 1000, output_tokens: 10 },
    costUsd: 0.000042, questions: {}, answers: {}, lowConfidence: [], statePreview: '', stateBytes: 0,
    stateSha256: '', ...extra,
  };
}

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe('readJevDecisions', () => {
  it('treats a missing log as empty and skips malformed lines', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'jev-read-'));
    const file = path.join(dir, 'decisions.jsonl');
    expect(await readJevDecisions(file)).toEqual([]);
    writeFileSync(file, `${JSON.stringify(rec('a', 1))}\n{torn\n${JSON.stringify(rec('b', 0))}\n`);
    expect((await readJevDecisions(file)).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('summarizeJevDecisions', () => {
  it('aggregates 24h and 7d windows and reports the last answering model', () => {
    const records = [
      rec('old', 24 * 10),
      rec('week', 48, { latencyMs: 100, lowConfidence: ['q'] }),
      rec('fail', 2, { ok: false, error: 'boom', usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0, latencyMs: 5, model: 'jev-latest' }),
      rec('day', 1, { latencyMs: 500, model: 'jev-1.14.0' }),
    ];
    const s = summarizeJevDecisions(records, NOW);
    expect(s.lastModel).toBe('jev-1.14.0');
    expect(s.last24h).toEqual({ calls: 2, failed: 1, inputTokens: 1000, costUsd: 0.000042, medianLatencyMs: 500, lowConfidenceCalls: 0 });
    expect(s.last7d.calls).toBe(3);
    expect(s.last7d.medianLatencyMs).toBe(300);
    expect(s.last7d.lowConfidenceCalls).toBe(1);
  });
});

describe('pageJevDecisions', () => {
  const records = [rec('1', 5), rec('2', 4, { caller: 'Sam' }), rec('3', 3, { lowConfidence: ['x'] }), rec('4', 2), rec('5', 1)];
  it('returns newest first and pages with before', () => {
    const first = pageJevDecisions(records, { limit: 2 });
    expect(first.records.map((r) => r.id)).toEqual(['5', '4']);
    const second = pageJevDecisions(records, { limit: 2, before: first.nextBefore! });
    expect(second.records.map((r) => r.id)).toEqual(['3', '2']);
    const last = pageJevDecisions(records, { limit: 2, before: second.nextBefore! });
    expect(last.records.map((r) => r.id)).toEqual(['1']);
    expect(last.nextBefore).toBeNull();
  });
  it('filters by caller and low confidence', () => {
    expect(pageJevDecisions(records, { caller: 'Sam' }).records.map((r) => r.id)).toEqual(['2']);
    expect(pageJevDecisions(records, { lowConfidence: true }).records.map((r) => r.id)).toEqual(['3']);
  });
});

describe('validateJevRun', () => {
  const choice = { type: 'choice', instructions: 'Who owns it?', criteria: { builder: 'backend', sam: 'architecture' } };
  it('accepts Choice, Score and Noul questions', () => {
    const r = validateJevRun({
      state: 'the build is broken',
      questions: {
        owner: choice,
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['can wait', 'blocking now'] },
        blocked: { type: 'noul', instructions: 'Is the sender blocked?' },
      },
    });
    expect(r.ok).toBe(true);
  });
  it('rejects empty state, empty questions and malformed questions', () => {
    expect(validateJevRun({ state: '  ', questions: { owner: choice } }).ok).toBe(false);
    expect(validateJevRun({ state: 'x', questions: {} }).ok).toBe(false);
    expect(validateJevRun({ state: 'x', questions: { q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } } }).ok).toBe(false);
    expect(validateJevRun({ state: 'x', questions: { q: { type: 'score', instructions: 'x', criteria: ['a'] } } }).ok).toBe(false);
    expect(validateJevRun({ state: 'x', questions: { q: { type: 'other', instructions: 'x' } } }).ok).toBe(false);
    expect(validateJevRun({ state: 'x', questions: { 'bad id!': { type: 'noul', instructions: 'x' } } }).ok).toBe(false);
  });
});
