/**
 * Sprint 'Realtime Context Bar' T1 — pure merge helpers for the live
 * context-health poll. The UI polls GET /api/agent/context-health and merges
 * the fresh per-agent value over the roster value so the bar is live without
 * a restart.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextHealthMap,
  CONTEXT_HEALTH_MAX_AGE_MS,
  isFreshContextHealth,
  selectLiveHealth,
  type ContextHealth,
} from '@/lib/context-health/merge';

// The readings below are all from the minutes after 07:00 on 6 Jun 2026, so judge freshness at 07:06.
const NOW = Date.parse('2026-06-06T07:06:00Z');

const h = (percent: number, reportedAt: string): ContextHealth => ({
  percent,
  turnCount: 1,
  model: 'opus',
  reportedAt,
});

describe('buildContextHealthMap', () => {
  it('keys lastContextHealth by agentId', () => {
    const map = buildContextHealthMap([
      { agentId: 'a1', lastContextHealth: h(50, '2026-06-06T07:00:00Z') },
      { agentId: 'a2', lastContextHealth: h(20, '2026-06-06T07:01:00Z') },
    ]);
    expect(map.a1.percent).toBe(50);
    expect(map.a2.percent).toBe(20);
  });

  it('skips agents with null / missing health or id', () => {
    const map = buildContextHealthMap([
      { agentId: 'a1', lastContextHealth: null },
      { agentId: 'a2' },
      { lastContextHealth: h(10, '2026-06-06T07:00:00Z') },
      { agentId: 'a3', lastContextHealth: h(33, '2026-06-06T07:00:00Z') },
    ]);
    expect(map).not.toHaveProperty('a1');
    expect(map).not.toHaveProperty('a2');
    expect(Object.keys(map)).toEqual(['a3']);
  });

  it('tolerates undefined / non-array input', () => {
    expect(buildContextHealthMap(undefined)).toEqual({});
    // @ts-expect-error — defensive runtime guard
    expect(buildContextHealthMap(null)).toEqual({});
  });
});

describe('selectLiveHealth', () => {
  it('returns roster value when no live value', () => {
    const roster = h(40, '2026-06-06T07:00:00Z');
    expect(selectLiveHealth(undefined, roster, NOW)).toBe(roster);
    expect(selectLiveHealth(null, roster, NOW)).toBe(roster);
  });

  it('returns live value when no roster value', () => {
    const live = h(40, '2026-06-06T07:00:00Z');
    expect(selectLiveHealth(live, undefined, NOW)).toBe(live);
    expect(selectLiveHealth(live, null, NOW)).toBe(live);
  });

  it('returns undefined when neither present', () => {
    expect(selectLiveHealth(undefined, undefined, NOW)).toBeUndefined();
  });

  it('prefers the fresher reportedAt when both present', () => {
    const older = h(40, '2026-06-06T07:00:00Z');
    const newer = h(55, '2026-06-06T07:05:00Z');
    expect(selectLiveHealth(newer, older, NOW)).toBe(newer); // live fresher
    expect(selectLiveHealth(older, newer, NOW)).toBe(newer); // roster fresher
  });

  it('falls back gracefully on unparseable timestamps', () => {
    const live = h(40, 'not-a-date');
    const roster = h(60, '2026-06-06T07:00:00Z');
    expect(selectLiveHealth(live, roster, NOW)).toBe(roster); // live time NaN → roster
    expect(selectLiveHealth(roster, live, NOW)).toBe(roster); // roster(arg2) time NaN → live(arg1)=roster obj
  });
});

describe('a reading that has gone stale is not shown (18 Oct 2026: bars showed numbers saved months earlier)', () => {
  const reportedAt = '2026-06-06T07:00:00Z';
  const at = (msAfter: number) => Date.parse(reportedAt) + msAfter;

  it('is fresh up to the limit and stale after it', () => {
    expect(CONTEXT_HEALTH_MAX_AGE_MS).toBe(15 * 60 * 1000);
    expect(isFreshContextHealth({ reportedAt }, at(0))).toBe(true);
    expect(isFreshContextHealth({ reportedAt }, at(CONTEXT_HEALTH_MAX_AGE_MS))).toBe(true);
    expect(isFreshContextHealth({ reportedAt }, at(CONTEXT_HEALTH_MAX_AGE_MS + 1))).toBe(false);
  });

  it('counts a reading stamped a little ahead of this clock as fresh, and a missing or unreadable stamp as stale', () => {
    expect(isFreshContextHealth({ reportedAt }, at(-30_000))).toBe(true);
    expect(isFreshContextHealth({ reportedAt: 'not-a-date' }, NOW)).toBe(false);
    expect(isFreshContextHealth({}, NOW)).toBe(false);
    expect(isFreshContextHealth(null, NOW)).toBe(false);
    expect(isFreshContextHealth(undefined, NOW)).toBe(false);
  });

  it('hides the bar when the newest reading is old, whichever source it came from', () => {
    const old = h(100, '2026-06-06T07:00:00Z');
    expect(selectLiveHealth(old, undefined, at(CONTEXT_HEALTH_MAX_AGE_MS + 1))).toBeUndefined();
    expect(selectLiveHealth(undefined, old, at(CONTEXT_HEALTH_MAX_AGE_MS + 1))).toBeUndefined();
    expect(selectLiveHealth(old, old, at(CONTEXT_HEALTH_MAX_AGE_MS + 1))).toBeUndefined();
  });

  it('shows the newer reading when only the older one has expired', () => {
    const old = h(100, '2026-06-06T07:00:00Z');
    const fresh = h(27, '2026-06-06T07:20:00Z');
    expect(selectLiveHealth(fresh, old, Date.parse('2026-06-06T07:25:00Z'))).toBe(fresh);
    expect(selectLiveHealth(old, fresh, Date.parse('2026-06-06T07:25:00Z'))).toBe(fresh);
  });

  it('keeps the tokens and window a reporter supplied, so the bar can say what it measured', () => {
    const detailed: ContextHealth = { ...h(27.5, '2026-06-06T07:05:00Z'), tokens: 275_151, window: 1_000_000, source: 'transcript-sampler' };
    expect(selectLiveHealth(detailed, undefined, NOW)).toMatchObject({ tokens: 275_151, window: 1_000_000 });
  });
});
