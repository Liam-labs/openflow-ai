/**
 * Log Writer — JSONL append utility for the DevFlow Logs Dashboard
 *
 * Writes unified log entries to logs/event-logs/current.jsonl
 * Daily rotation moves current.jsonl to {YYYY-MM-DD}.jsonl
 *
 * Storage layout:
 *   logs/event-logs/
 *     current.jsonl        ← today's events (append-only)
 *     {YYYY-MM-DD}.jsonl   ← rotated daily archives
 *     index/
 *       {YYYY-MM-DD}.json  ← per-day summary (counts by source/severity)
 *
 * All Node.js writes go through withFileLock (in-process serialisation).
 * Shell script writes use POSIX append which is atomic for small lines.
 */

import path from 'path';
import { APP_CWD } from './app-paths';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import type { UnifiedLogEntry, LogSource, LogSeverity } from './log-types';
import { withFileLock } from './data-io';
import { shouldLog, getLoggingConfig } from './log-config';

const gzip = promisify(zlib.gzip);

export const LOG_BASE = path.join(/* turbopackIgnore: true */ APP_CWD, 'logs', 'event-logs');
export const CURRENT_LOG = path.join(LOG_BASE, 'current.jsonl');
const INDEX_DIR = path.join(LOG_BASE, 'index');

// Per-tool consecutive failure counters for auto-escalation
const consecutiveToolFailures = new Map<string, number>();

// Rotation constants
export const ROTATE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const ROTATE_LOCK = path.join(LOG_BASE, 'rotation.lock');
// In-process guard: prevents overlapping rotation attempts within the same process
let _rotationInProgress = false;

// ============================================
// Directory setup
// ============================================

let logDirsReady = false;

async function ensureReady(): Promise<void> {
  if (logDirsReady) return;
  await fs.mkdir(LOG_BASE, { recursive: true });
  await fs.mkdir(INDEX_DIR, { recursive: true });
  logDirsReady = true;
}

// ============================================
// Core write
// ============================================

/**
 * Write a unified log entry to current.jsonl and emit to SSE.
 * Respects the global log level — entries below the configured level are skipped.
 * Never throws — errors are caught and printed to console only.
 */
export async function writeLogEntry(entry: UnifiedLogEntry): Promise<void> {
  try {
    // Fast synchronous check — skip entries below current log level
    const moduleId = (entry.metadata as Record<string, unknown>)?.module as string | undefined;
    if (!shouldLog(entry.severity, moduleId)) return;

    await ensureReady();
    const line = JSON.stringify(entry) + '\n';
    await withFileLock(CURRENT_LOG, async () => {
      await fs.appendFile(CURRENT_LOG, line, 'utf-8');
    });
    // Emit to SSE live tail (lazy import avoids circular dep)
    import('./event-bus').then(({ eventBus }) => {
      eventBus.emitEvent('logs:entry', entry);
    }).catch(() => {});
    // Size-based rotation check — fire-and-forget, never blocks writes
    maybeRotate().catch(() => {});
  } catch (err) {
    console.error('[log-writer] write error:', err instanceof Error ? err.message : String(err));
  }
}

// ============================================
// Convenience helpers
// ============================================

/**
 * Title-pattern severity overrides — defensive normalisation for noise events that
 * legacy emitters tag too aggressively. Lets us tame in-flight long-running
 * processes without waiting for them to restart and pick up source-side fixes.
 *
 * Add entries here when an event type is unambiguously informational despite
 * arriving at a higher severity (e.g. an old agent on stale code, or a third-party
 * emitter we don't control). Keep the list short — the right long-term fix is
 * always at the source.
 *
 * 2026-05-19: "Inbox safety net" already lowered to 'info' in collab-claude.py +
 * collab-codex.py on 2026-05-18, but agents that haven't restarted since are
 * still sending 'high'. Defensive downgrade catches both classes.
 */
const NOISE_TITLE_DOWNGRADES: ReadonlyArray<{ pattern: RegExp; severity: LogSeverity }> = [
  { pattern: /^Inbox safety net:/i, severity: 'info' },
];

function normaliseSeverity(title: string, severity: LogSeverity): LogSeverity {
  for (const rule of NOISE_TITLE_DOWNGRADES) {
    if (rule.pattern.test(title)) return rule.severity;
  }
  return severity;
}

export function makeLogEntry(
  source: LogSource,
  severity: LogSeverity,
  title: string,
  metadata: Record<string, unknown> = {},
  details?: string,
): UnifiedLogEntry {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source,
    severity: normaliseSeverity(title, severity),
    title,
    details,
    metadata,
  };
}

export async function logEvent(
  source: LogSource,
  severity: LogSeverity,
  title: string,
  metadata: Record<string, unknown> = {},
  details?: string,
): Promise<void> {
  await writeLogEntry(makeLogEntry(source, severity, title, metadata, details));
}

/**
 * Emit a debug-level log entry. Only written when global level is 'debug'
 * or the specified module has verbose mode enabled.
 * Use for: request/response payloads, timing breakdowns, state transitions.
 */
export async function debugLog(
  module: string,
  title: string,
  metadata: Record<string, unknown> = {},
  details?: string,
): Promise<void> {
  await writeLogEntry(makeLogEntry('api', 'debug', title, { ...metadata, module }, details));
}

// ============================================
// Tool failure tracking
// ============================================

/**
 * Track consecutive tool failures for auto-escalation.
 * Returns 'critical' after 3+ consecutive failures from the same tool.
 */
export function trackToolFailure(tool: string, failed: boolean): LogSeverity {
  if (failed) {
    const count = (consecutiveToolFailures.get(tool) ?? 0) + 1;
    consecutiveToolFailures.set(tool, count);
    return count >= 3 ? 'critical' : 'high';
  } else {
    consecutiveToolFailures.delete(tool);
    return 'info';
  }
}

// ============================================
// Rotation helpers
// ============================================

/**
 * Fire-and-forget: checks size and rotates if threshold exceeded.
 * In-process guard prevents concurrent rotation within the same process.
 */
async function maybeRotate(): Promise<void> {
  if (_rotationInProgress) return;
  const needed = await checkRotationNeeded();
  if (!needed) return;
  _rotationInProgress = true;
  try {
    await rotateEventLogs(new Date());
  } finally {
    _rotationInProgress = false;
  }
}

// ============================================
// Rotation
// ============================================

/**
 * Rotate current.jsonl to {dateStr}[.jsonl or -{n}.jsonl] and start a fresh log.
 *
 * Size-based trigger: called from writeLogEntry() when file exceeds ROTATE_SIZE_BYTES.
 * Daily trigger: called from crash-recovery timer or cron — pass no targetDate (defaults to yesterday).
 *
 * Cross-process safety: O_EXCL lock file prevents concurrent rotation from multiple processes.
 * In-process safety: withFileLock(CURRENT_LOG) blocks concurrent Node.js writes during rename.
 */
export async function rotateEventLogs(targetDate?: Date): Promise<void> {
  try {
    await ensureReady();

    let stat: { size: number } | null = null;
    try { stat = await fs.stat(CURRENT_LOG); } catch { return; }
    if (!stat || stat.size === 0) return;

    const rotateDate = targetDate ?? (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d;
    })();

    const dateStr = rotateDate.toISOString().slice(0, 10);

    // Cross-process exclusive lock via O_EXCL — atomic on POSIX, prevents concurrent rotation
    let lockFd: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      lockFd = await fs.open(ROTATE_LOCK, 'wx'); // O_CREAT | O_EXCL — fails if already exists
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return; // another process rotating
      throw err;
    }

    try {
      // Find a non-conflicting archive name (handles multiple size-based rotations per day)
      let archivePath = path.join(LOG_BASE, `${dateStr}.jsonl`);
      let suffix = 1;
      while (true) {
        try { await fs.access(archivePath); } catch { break; } // doesn't exist — use it
        archivePath = path.join(LOG_BASE, `${dateStr}-${++suffix}.jsonl`);
      }

      // Rename + fresh file inside CURRENT_LOG in-process lock to block concurrent Node writes
      await withFileLock(CURRENT_LOG, async () => {
        // Re-check inside lock — may be empty if another rotation just ran
        let innerStat: { size: number } | null = null;
        try { innerStat = await fs.stat(CURRENT_LOG); } catch { return; }
        if (!innerStat || innerStat.size === 0) return;

        await fs.rename(CURRENT_LOG, archivePath);
        await fs.writeFile(CURRENT_LOG, '', 'utf-8');
      });

      console.log(`[log-writer] Rotated event logs → ${path.basename(archivePath)}`);
      generateDayIndex(archivePath, dateStr).catch(() => {});
      compressOldLogs().catch(() => {});
    } finally {
      await lockFd.close();
      await fs.unlink(ROTATE_LOCK).catch(() => {});
    }
  } catch (err) {
    console.error('[log-writer] rotation error:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Compress rotated .jsonl files older than 1 day into .jsonl.gz.
 * Skips current.jsonl and files that already have a .gz counterpart.
 * Called after rotation or on a schedule to reduce disk usage.
 */
export async function compressOldLogs(): Promise<number> {
  let compressed = 0;
  try {
    await ensureReady();
    const files = await fs.readdir(LOG_BASE);
    const today = new Date().toISOString().slice(0, 10);

    for (const file of files) {
      if (!file.endsWith('.jsonl') || file === 'current.jsonl') continue;

      // Extract date from filename (YYYY-MM-DD.jsonl)
      const dateStr = file.replace('.jsonl', '');
      if (dateStr >= today) continue; // Don't compress today's or future files

      const jsonlPath = path.join(LOG_BASE, file);
      const gzPath = path.join(LOG_BASE, `${dateStr}.jsonl.gz`);

      // Skip if already compressed
      try { await fs.access(gzPath); continue; } catch { /* expected — no .gz yet */ }

      // Stream-compress: read .jsonl → gzip → write .jsonl.gz
      try {
        await pipeline(
          createReadStream(jsonlPath),
          zlib.createGzip({ level: 6 }),
          createWriteStream(gzPath),
        );
        // Verify the .gz file was written before deleting the original
        const gzStat = await fs.stat(gzPath);
        if (gzStat.size > 0) {
          await fs.unlink(jsonlPath);
          compressed++;
          console.log(`[log-writer] Compressed ${file} → ${dateStr}.jsonl.gz`);
        }
      } catch (err) {
        // Clean up partial .gz on failure
        try { await fs.unlink(gzPath); } catch { /* ignore */ }
        console.error(`[log-writer] Failed to compress ${file}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error('[log-writer] compressOldLogs error:', err instanceof Error ? err.message : String(err));
  }
  return compressed;
}

/**
 * Returns true if current.jsonl has reached the rotation size threshold (5 MB).
 * Size-based check is reliable — mtime was unreliable (always today due to appends).
 */
export async function checkRotationNeeded(): Promise<boolean> {
  try {
    const stat = await fs.stat(CURRENT_LOG);
    return stat.size >= ROTATE_SIZE_BYTES;
  } catch {
    return false;
  }
}

// ============================================
// Index generation
// ============================================

async function generateDayIndex(logPath: string, dateStr: string): Promise<void> {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const counts: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let firstTs = '';
    let lastTs = '';

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as UnifiedLogEntry;
        counts[entry.source] = (counts[entry.source] ?? 0) + 1;
        bySeverity[entry.severity] = (bySeverity[entry.severity] ?? 0) + 1;
        if (!firstTs) firstTs = entry.timestamp;
        lastTs = entry.timestamp;
      } catch { /* skip malformed lines */ }
    }

    const index = { date: dateStr, totalEntries: lines.length, counts, bySeverity, firstTimestamp: firstTs, lastTimestamp: lastTs };
    await fs.writeFile(path.join(INDEX_DIR, `${dateStr}.json`), JSON.stringify(index, null, 2));
  } catch { /* index failure is non-fatal */ }
}
