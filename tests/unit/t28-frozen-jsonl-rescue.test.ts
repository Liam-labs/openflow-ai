/**
 * T2.8 — JSONL-mtime liveness rescues a busy-but-quiet respawned Claude agent
 * from a false FROZEN verdict when activityStatus is absent.
 *
 * The DoD case (A): a frozen *candidate* (online + unread @mention aged 10-30min)
 * with activityStatus=None but a FRESH JSONL transcript (<90s) must read NOT
 * frozen — the transcript-mtime signal stands in for the missing heartbeat.
 *
 * Companion to the live evidence: post-encode-fix, resolveJsonlMtimeMs resolves
 * LatencyProbe's dotted `.probe-latency` path to a real mtime (8.4s, fresh) where
 * pre-fix it returned null. This test pins the verdict logic on top of that.
 */

import { describe, it, expect } from 'vitest';
import { detectFrozenParticipantIds } from '@/lib/frozen-detection';
import type { FrozenParticipantLike, FrozenMessageLike } from '@/lib/frozen-detection';

const NOW = Date.UTC(2026, 5, 5, 12, 0, 0);
const MIN = 60_000;

// A candidate: online (lastSeen now), lastRead 20min ago, with an unread
// @Probe mention aged 15min (inside the 10-30min frozen window).
function candidate(overrides: Partial<FrozenParticipantLike>): FrozenParticipantLike {
  return {
    id: 'roster-probe',
    name: 'Probe',
    type: 'claude-terminal',
    lastSeen: new Date(NOW).toISOString(),
    lastRead: new Date(NOW - 20 * MIN).toISOString(),
    ...overrides,
  };
}

const messages: FrozenMessageLike[] = [
  { from: { id: 'roster-sender' }, timestamp: new Date(NOW - 15 * MIN).toISOString(), content: '@Probe you there?' },
];

const run = (p: FrozenParticipantLike) =>
  detectFrozenParticipantIds({ participants: [p], messages, now: NOW });

describe('T2.8 — JSONL-mtime liveness multi-signal verdict', () => {
  it('A (DoD): activityStatus=None + FRESH JSONL (<90s) ⇒ NOT frozen (rescued by transcript mtime)', () => {
    const frozen = run(candidate({ activityStatus: undefined, jsonlMtimeMs: NOW - 10_000 }));
    expect(frozen.has('roster-probe')).toBe(false);
  });

  it('B: activityStatus=None + STALE JSONL (120s) ⇒ FROZEN (genuinely quiet)', () => {
    const frozen = run(candidate({ activityStatus: undefined, jsonlMtimeMs: NOW - 120_000 }));
    expect(frozen.has('roster-probe')).toBe(true);
  });

  it('C (pre-encode-fix state): activityStatus=None + jsonlMtimeMs=null ⇒ FROZEN', () => {
    const frozen = run(candidate({ activityStatus: undefined, jsonlMtimeMs: null }));
    expect(frozen.has('roster-probe')).toBe(true);
  });

  it('D: activityStatus=working + jsonlMtimeMs=null ⇒ NOT frozen (rescued by heartbeat)', () => {
    const frozen = run(candidate({ activityStatus: 'working', jsonlMtimeMs: null }));
    expect(frozen.has('roster-probe')).toBe(false);
  });

  it('E: activityStatus=idle + FRESH JSONL ⇒ NOT frozen (idle is not "working"; JSONL rescues)', () => {
    const frozen = run(candidate({ activityStatus: 'idle', jsonlMtimeMs: NOW - 10_000 }));
    expect(frozen.has('roster-probe')).toBe(false);
  });

  it('control: a non-candidate (no unread aged mention) is never flagged regardless of signals', () => {
    const readRecently = candidate({ activityStatus: undefined, jsonlMtimeMs: null, lastRead: new Date(NOW).toISOString() });
    expect(run(readRecently).has('roster-probe')).toBe(false);
  });
});
