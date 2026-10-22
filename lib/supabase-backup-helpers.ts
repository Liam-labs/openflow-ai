/**
 * Pure helper functions for the Supabase backup panel.
 * Extracted so they can be unit-tested without a browser environment.
 */

/** Returns the color tier for the hero status based on elapsed milliseconds. */
export function heroTier(ms: number): 'green' | 'amber' | 'red' {
  if (ms < 86_400_000) return 'green';   // < 24h
  if (ms < 172_800_000) return 'amber';  // < 48h
  return 'red';
}

/** Formats elapsed milliseconds as a human-readable string for the hero display. */
export function formatHeroElapsed(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m ago`;
  if (m > 0) return `${m}m ${s}s ago`;
  return `${s}s ago`;
}

/**
 * Formats a relative time string ("Xm ago", "Xh ago") from an ISO date
 * and an explicit `now` timestamp (enables animated updates).
 */
export function formatRelativeNow(iso: string, nowMs: number): string {
  try {
    const diff = nowMs - new Date(iso).getTime();
    if (Number.isNaN(diff)) return '';
    const abs = Math.abs(diff);
    if (abs < 60_000) return `${Math.round(abs / 1_000)}s ago`;
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
    return `${Math.round(abs / 86_400_000)}d ago`;
  } catch {
    return '';
  }
}

// ─── Sort & Filter ────────────────────────────────────────────────────────────

export interface LocalBackupEntry {
  filename: string;
  sizeMb: number;
  createdAt: string;
}

export type SortOrder   = 'newest' | 'oldest';
export type FilterBucket = 'all' | 'today' | 'week' | 'month';

/** Returns a sorted copy of local backups (does not mutate the original). */
export function applySort(backups: LocalBackupEntry[], order: SortOrder): LocalBackupEntry[] {
  return [...backups].sort((a, b) => {
    const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return order === 'newest' ? diff : -diff;
  });
}

/**
 * Returns backups matching the age bucket.
 * @param backups - array to filter
 * @param bucket  - 'all' | 'today' (<24h) | 'week' (<7d) | 'month' (<30d)
 * @param nowMs   - reference timestamp (defaults to Date.now())
 */
export function applyFilter(
  backups: LocalBackupEntry[],
  bucket: FilterBucket,
  nowMs = Date.now(),
): LocalBackupEntry[] {
  if (bucket === 'all') return backups;
  const limits: Record<Exclude<FilterBucket, 'all'>, number> = {
    today: 86_400_000,        // 24h
    week:  7 * 86_400_000,    // 7d
    month: 30 * 86_400_000,   // 30d
  };
  const limit = limits[bucket as Exclude<FilterBucket, 'all'>];
  return backups.filter(b => nowMs - new Date(b.createdAt).getTime() < limit);
}

// ─── Typed-confirm form state ─────────────────────────────────────────────────

export type ConfirmMatchState = 'idle' | 'mismatch' | 'exact';

/**
 * Returns the match state for the typed-confirm input in the restore-to-other modal.
 * - 'idle'     — typed is empty; button disabled, no hint shown
 * - 'mismatch' — non-empty but not an exact match; button disabled, hint shown
 * - 'exact'    — typed equals targetName byte-for-byte; button enabled
 *
 * Case-sensitive. No trim applied — matches server-side gate 6 semantics.
 */
export function confirmMatchState(typed: string, targetName: string): ConfirmMatchState {
  if (!typed) return 'idle';
  if (typed === targetName) return 'exact';
  return 'mismatch';
}

// ─── Diff viewer helpers ──────────────────────────────────────────────────────

import type { SchemaDiffResult } from './supabase-backup-diff';

/**
 * Returns all backups except the source, sorted newest-first.
 * Used to populate the file-picker in the diff modal.
 */
export function buildDiffCandidates(
  backups: LocalBackupEntry[],
  sourceFilename: string,
): LocalBackupEntry[] {
  return [...backups]
    .filter(b => b.filename !== sourceFilename)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Returns the filename to pre-select as fileB in the diff modal.
 * Prefers the immediately-older backup; falls back to the newest candidate.
 */
export function defaultDiffTarget(
  backups: LocalBackupEntry[],
  sourceFilename: string,
): string {
  const candidates = buildDiffCandidates(backups, sourceFilename);
  if (candidates.length === 0) return '';
  const sorted = [...backups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const sourceIdx = sorted.findIndex(b => b.filename === sourceFilename);
  const nextOlder = sourceIdx >= 0 ? sorted[sourceIdx + 1] : undefined;
  return nextOlder ? nextOlder.filename : candidates[0].filename;
}

/** Returns true when a diff result has no changes. */
export function diffIsEmpty(diff: SchemaDiffResult): boolean {
  return (
    diff.addedTables.length === 0 &&
    diff.removedTables.length === 0 &&
    diff.modifiedTables.length === 0
  );
}

/** Formats an ISO timestamp as a locale-aware absolute date string. */
export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
