/**
 * Unit tests for supabase backup panel helper functions.
 * Covers: heroTier (color threshold) + formatHeroElapsed (display format).
 * Written TDD — RED first, then lib/supabase-backup-helpers.ts implemented.
 */

import { describe, it, expect } from 'vitest';
import {
  heroTier,
  formatHeroElapsed,
  formatRelativeNow,
  applySort,
  applyFilter,
  confirmMatchState,
  buildDiffCandidates,
  defaultDiffTarget,
  diffIsEmpty,
} from '@/lib/supabase-backup-helpers';
import type { SchemaDiffResult } from '@/lib/supabase-backup-diff';

const H = 3_600_000;
const D = 86_400_000;

// ─── heroTier ─────────────────────────────────────────────────────────────────

describe('heroTier', () => {
  it('returns green for elapsed < 24h', () => {
    expect(heroTier(0)).toBe('green');
    expect(heroTier(H)).toBe('green');
    expect(heroTier(23 * H + 59 * 60_000)).toBe('green');
  });

  it('returns amber for elapsed 24h–48h (exclusive)', () => {
    expect(heroTier(D)).toBe('amber');
    expect(heroTier(36 * H)).toBe('amber');
    expect(heroTier(2 * D - 1)).toBe('amber');
  });

  it('returns red for elapsed >= 48h', () => {
    expect(heroTier(2 * D)).toBe('red');
    expect(heroTier(7 * D)).toBe('red');
  });
});

// ─── formatHeroElapsed ────────────────────────────────────────────────────────

describe('formatHeroElapsed', () => {
  it('shows seconds only when elapsed < 1 minute', () => {
    expect(formatHeroElapsed(30_000)).toBe('30s ago');
    expect(formatHeroElapsed(59_000)).toBe('59s ago');
  });

  it('shows minutes and seconds when elapsed < 1 hour', () => {
    expect(formatHeroElapsed(90_000)).toBe('1m 30s ago');
    expect(formatHeroElapsed(5 * 60_000 + 15_000)).toBe('5m 15s ago');
    expect(formatHeroElapsed(59 * 60_000)).toBe('59m 0s ago');
  });

  it('shows hours and minutes when elapsed >= 1 hour', () => {
    expect(formatHeroElapsed(H)).toBe('1h 0m ago');
    expect(formatHeroElapsed(H + 30 * 60_000)).toBe('1h 30m ago');
    expect(formatHeroElapsed(25 * H)).toBe('25h 0m ago');
  });

  it('handles 0ms gracefully', () => {
    expect(formatHeroElapsed(0)).toBe('0s ago');
  });
});

// ─── formatRelativeNow ────────────────────────────────────────────────────────

describe('formatRelativeNow', () => {
  it('returns <1m ago for very recent dates', () => {
    const now = Date.now();
    const iso = new Date(now - 30_000).toISOString();
    expect(formatRelativeNow(iso, now)).toBe('30s ago');
  });

  it('returns minutes ago correctly', () => {
    const now = Date.now();
    const iso = new Date(now - 5 * 60_000).toISOString();
    expect(formatRelativeNow(iso, now)).toBe('5m ago');
  });

  it('returns hours ago correctly', () => {
    const now = Date.now();
    const iso = new Date(now - 3 * H).toISOString();
    expect(formatRelativeNow(iso, now)).toBe('3h ago');
  });

  it('returns days ago correctly', () => {
    const now = Date.now();
    const iso = new Date(now - 2 * D).toISOString();
    expect(formatRelativeNow(iso, now)).toBe('2d ago');
  });

  it('handles invalid dates gracefully', () => {
    expect(formatRelativeNow('not-a-date', Date.now())).toBe('');
  });
});

// ─── applySort ────────────────────────────────────────────────────────────────

const makeBackup = (createdAt: string) => ({
  filename: `backup-${createdAt}.sql`,
  sizeMb: 1,
  createdAt,
});

describe('applySort', () => {
  const backups = [
    makeBackup('2026-04-08T10:00:00Z'),
    makeBackup('2026-04-10T10:00:00Z'),
    makeBackup('2026-04-09T10:00:00Z'),
  ];

  it('sorts newest-first by default', () => {
    const result = applySort(backups, 'newest');
    expect(result[0].createdAt).toBe('2026-04-10T10:00:00Z');
    expect(result[2].createdAt).toBe('2026-04-08T10:00:00Z');
  });

  it('sorts oldest-first when specified', () => {
    const result = applySort(backups, 'oldest');
    expect(result[0].createdAt).toBe('2026-04-08T10:00:00Z');
    expect(result[2].createdAt).toBe('2026-04-10T10:00:00Z');
  });

  it('does not mutate the original array', () => {
    const original = [...backups];
    applySort(backups, 'oldest');
    expect(backups[0].createdAt).toBe(original[0].createdAt);
  });
});

// ─── applyFilter ─────────────────────────────────────────────────────────────

describe('applyFilter', () => {
  const now = new Date('2026-04-10T12:00:00Z').getTime();
  const backups = [
    makeBackup('2026-04-10T10:00:00Z'), // 2h ago — today
    makeBackup('2026-04-07T12:00:00Z'), // 3d ago — this week
    makeBackup('2026-03-20T12:00:00Z'), // 21d ago — this month
    makeBackup('2026-01-01T12:00:00Z'), // 99d ago — older
  ];

  it('returns all backups for "all" bucket', () => {
    expect(applyFilter(backups, 'all', now)).toHaveLength(4);
  });

  it('returns only today\'s backups (<24h)', () => {
    const result = applyFilter(backups, 'today', now);
    expect(result).toHaveLength(1);
    expect(result[0].createdAt).toBe('2026-04-10T10:00:00Z');
  });

  it('returns backups within 7 days for "week" bucket', () => {
    const result = applyFilter(backups, 'week', now);
    expect(result).toHaveLength(2); // 2h + 3d
  });

  it('returns backups within 30 days for "month" bucket', () => {
    const result = applyFilter(backups, 'month', now);
    expect(result).toHaveLength(3); // 2h + 3d + 21d
  });
});

// ─── confirmMatchState ────────────────────────────────────────────────────────

describe('confirmMatchState', () => {
  it('returns idle when typed is empty', () => {
    expect(confirmMatchState('', 'Local Dev')).toBe('idle');
  });

  it('returns mismatch for a partial (prefix) match', () => {
    // "partial-match → disabled" per spec — prefix is NOT exact
    expect(confirmMatchState('Local', 'Local Dev')).toBe('mismatch');
  });

  it('returns exact for a byte-perfect match', () => {
    expect(confirmMatchState('Local Dev', 'Local Dev')).toBe('exact');
  });

  it('returns mismatch after previously exact if user keeps typing', () => {
    // trailing space breaks the exact match
    expect(confirmMatchState('Local Dev ', 'Local Dev')).toBe('mismatch');
  });

  it('is case-sensitive — wrong case returns mismatch', () => {
    expect(confirmMatchState('local dev', 'Local Dev')).toBe('mismatch');
  });

  it('returns idle when target name is empty', () => {
    // No target selected yet — targetName will be ''
    expect(confirmMatchState('anything', '')).toBe('mismatch');
    expect(confirmMatchState('', '')).toBe('idle');
  });
});

// ─── buildDiffCandidates ──────────────────────────────────────────────────────

describe('buildDiffCandidates', () => {
  const backups = [
    makeBackup('2026-04-10T10:00:00Z'),
    makeBackup('2026-04-09T10:00:00Z'),
    makeBackup('2026-04-08T10:00:00Z'),
  ];

  it('excludes the source backup from candidates', () => {
    const src = backups[1].filename; // 2026-04-09
    const result = buildDiffCandidates(backups, src);
    expect(result.every(b => b.filename !== src)).toBe(true);
  });

  it('returns remaining backups sorted newest-first', () => {
    const result = buildDiffCandidates(backups, backups[2].filename); // exclude oldest
    expect(result[0].createdAt).toBe('2026-04-10T10:00:00Z');
    expect(result[1].createdAt).toBe('2026-04-09T10:00:00Z');
  });

  it('returns empty array when source is the only backup', () => {
    const result = buildDiffCandidates([backups[0]], backups[0].filename);
    expect(result).toHaveLength(0);
  });

  it('does not mutate the original array', () => {
    const original = [...backups];
    buildDiffCandidates(backups, backups[0].filename);
    expect(backups[0].createdAt).toBe(original[0].createdAt);
  });
});

// ─── defaultDiffTarget ────────────────────────────────────────────────────────

describe('defaultDiffTarget', () => {
  const backups = [
    makeBackup('2026-04-10T10:00:00Z'), // newest
    makeBackup('2026-04-09T10:00:00Z'),
    makeBackup('2026-04-08T10:00:00Z'), // oldest
  ];

  it('selects the next-older backup when source is not the oldest', () => {
    // source = newest (2026-04-10), next older = 2026-04-09
    const result = defaultDiffTarget(backups, backups[0].filename);
    expect(result).toBe(backups[1].filename);
  });

  it('selects the correct next-older backup in the middle', () => {
    // source = middle (2026-04-09), next older = 2026-04-08
    const result = defaultDiffTarget(backups, backups[1].filename);
    expect(result).toBe(backups[2].filename);
  });

  it('falls back to newest candidate when source is the oldest', () => {
    // source = oldest, no next-older, fallback = newest candidate (2026-04-10)
    const result = defaultDiffTarget(backups, backups[2].filename);
    expect(result).toBe(backups[0].filename);
  });

  it('returns empty string when source is the only backup', () => {
    const result = defaultDiffTarget([backups[0]], backups[0].filename);
    expect(result).toBe('');
  });
});

// ─── diffIsEmpty ──────────────────────────────────────────────────────────────

describe('diffIsEmpty', () => {
  const emptyDiff: SchemaDiffResult = { addedTables: [], removedTables: [], modifiedTables: [] };

  it('returns true for an empty diff result', () => {
    expect(diffIsEmpty(emptyDiff)).toBe(true);
  });

  it('returns false when addedTables is non-empty', () => {
    expect(diffIsEmpty({ ...emptyDiff, addedTables: [{ name: 'users', columns: [] }] })).toBe(false);
  });

  it('returns false when removedTables is non-empty', () => {
    expect(diffIsEmpty({ ...emptyDiff, removedTables: [{ name: 'old', columns: [] }] })).toBe(false);
  });

  it('returns false when modifiedTables is non-empty', () => {
    expect(diffIsEmpty({
      ...emptyDiff,
      modifiedTables: [{ name: 'accounts', addedColumns: [], removedColumns: [], modifiedColumns: [] }],
    })).toBe(false);
  });
});
