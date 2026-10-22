/**
 * Directory Sync Watcher
 *
 * Single chokidar process that manages N sync pairs internally.
 * Per-pair error isolation: if one pair throws, log + set status to "error"
 * without killing the whole watcher.
 *
 * Structured events are emitted to an in-memory ring buffer so the API
 * can expose them for UI polling.
 */

import { watch as chokidarWatch, FSWatcher } from 'chokidar';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import type {
  DirectorySyncPair,
  DirectorySyncData,
  DirectorySyncStats,
  DirectorySyncEventEntry,
  SyncStatus,
} from '@/lib/types';

// ============================================================================
// Constants
// ============================================================================

const DATA_PATH = DataPaths.directorySync;
const LOGS_DIR = DataPaths.directorySyncLogs;
const RING_BUFFER_MAX = 500;
const DEBOUNCE_MS = 2000;

const DEFAULT_DATA: DirectorySyncData = {
  pairs: [],
  lastUpdated: '',
};

// ============================================================================
// Event ring buffer
// ============================================================================

class EventRingBuffer {
  private events: DirectorySyncEventEntry[] = [];
  private sequence = 0;

  push(
    type: DirectorySyncEventEntry['type'],
    syncId: string,
    payload: Record<string, unknown> = {}
  ): void {
    this.sequence++;
    this.events.push({
      type,
      syncId,
      timestamp: new Date().toISOString(),
      payload,
      sequence: this.sequence,
    });
    if (this.events.length > RING_BUFFER_MAX) {
      this.events.splice(0, this.events.length - RING_BUFFER_MAX);
    }
  }

  getSince(since: string): DirectorySyncEventEntry[] {
    if (!since) return [...this.events];
    const sinceDate = new Date(since).getTime();
    return this.events.filter(e => new Date(e.timestamp).getTime() > sinceDate);
  }
}

// ============================================================================
// Sync execution
// ============================================================================

/** Build rsync exclusion arguments from glob patterns */
function buildExclusionArgs(exclusions: string[]): string[] {
  return exclusions.flatMap(pattern => ['--exclude', pattern]);
}

/** Build the default exclusion list for a pair */
function defaultExclusions(pair: DirectorySyncPair): string[] {
  // Always exclude our own temp files
  return [...pair.exclusions, '.dsync-tmp-*'];
}

/** Itemize-change line pattern: the 11-char sequence that starts every rsync change line */
const ITEMIZE_RE = /^[.>][fdL][.c][.s][.t][.p][.o][.g][.u][.a]/;

/**
 * Execute rsync for a sync pair.
 * Uses --archive (recursive + preserve), --delete (mirror deletions),
 * --itemize-changes for the log.
 *
 * If onProgress is provided, it's called periodically with the running file count
 * so callers can emit live progress events.
 */
async function executeRsync(
  pair: DirectorySyncPair,
  dryRun: boolean,
  onProgress?: (filesProcessed: number) => void
): Promise<{ stats: DirectorySyncStats; files: string[]; log: string }> {
  const exclusions = defaultExclusions(pair);
  const args = [
    '--archive',
    '--delete',
    '--itemize-changes',
    '--stats',
    // NOTE: do NOT pass --human-readable — it breaks parseRsyncStats regex
    ...buildExclusionArgs(exclusions),
  ];

  if (dryRun) {
    args.push('--dry-run');
  }

  // Ensure trailing slash on source so rsync copies contents, not the dir itself
  const source = pair.sourcePath.endsWith('/')
    ? pair.sourcePath
    : pair.sourcePath + '/';
  args.push(source, pair.destPath);

  return new Promise((resolve, reject) => {
    const proc = spawn('rsync', args, { env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    let fileCount = 0;

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;

      // Count itemize-change lines for live progress
      if (onProgress) {
        for (const line of text.split('\n')) {
          if (ITEMIZE_RE.test(line) || line.startsWith('*deleting')) {
            fileCount++;
          }
        }
        if (fileCount > 0) {
          onProgress(fileCount);
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(stderr.trim() || `rsync exited with code ${code}`));
        return;
      }

      const stats = parseRsyncStats(stdout);
      const files = parseRsyncFiles(stdout);

      resolve({ stats, files, log: stdout });
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/** Parse rsync --stats output into DirectorySyncStats */
function parseRsyncStats(output: string): DirectorySyncStats {
  const filesCopied = extractNumber(output, /Number of regular files transferred:\s*(\d+)/i);
  const filesDeleted = extractNumber(output, /Number of deleted files:\s*(\d+)/i);
  const bytesMatch = output.match(/Total file size:\s*([\d,.]+)\s*bytes/i);
  let bytesTransferred = 0;
  if (bytesMatch) {
    bytesTransferred = parseInt(bytesMatch[1].replace(/[,.]/g, ''), 10) || 0;
  }
  const durationMatch = output.match(/total size is.*in\s+([\d.]+)\s+seconds/i);
  const durationMs = durationMatch ? Math.round(parseFloat(durationMatch[1]) * 1000) : 0;

  return { filesCopied, filesDeleted, bytesTransferred, durationMs };
}

/** Parse rsync --itemize-changes output into a list of changed files */
function parseRsyncFiles(output: string): string[] {
  const lines = output.split('\n');
  return lines
    .filter(line => /^[.>][fdL][.c][.s][.t][.p][.o][.g][.u][.a]/.test(line) || /^\*deleting/.test(line))
    .map(line => line.slice(11).trim())
    .filter(Boolean);
}

function extractNumber(text: string, regex: RegExp): number {
  const match = text.match(regex);
  return match ? parseInt(match[1].replace(/[,.]/g, ''), 10) || 0 : 0;
}

/** Append a JSONL log entry for this sync run */
async function appendSyncLog(pairId: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    const logFile = path.join(LOGS_DIR, `${pairId}.jsonl`);
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(logFile, line);
  } catch {
    // Non-fatal: logging failure shouldn't block the sync
  }
}

// ============================================================================
// DirectorySyncWatcher
// ============================================================================

class DirectorySyncWatcher {
  private watchers = new Map<string, FSWatcher>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private pairStatus = new Map<string, SyncStatus>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private events = new EventRingBuffer();

  /**
   * Load config from disk and start watchers/intervals for all enabled pairs.
   */
  async reload(): Promise<void> {
    const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);

    // Stop watchers/intervals for pairs that no longer exist or are disabled
    for (const [id] of this.watchers) {
      const pair = data.pairs.find(p => p.id === id);
      if (!pair || !pair.enabled) {
        this.stopPair(id);
      }
    }
    for (const [id] of this.intervals) {
      const pair = data.pairs.find(p => p.id === id);
      if (!pair || !pair.enabled || pair.mode !== 'periodic') {
        this.stopInterval(id);
      }
    }

    // Start watchers/intervals for enabled pairs
    for (const pair of data.pairs) {
      if (!pair.enabled) {
        this.pairStatus.set(pair.id, 'idle');
        continue;
      }

      if (pair.mode === 'watch') {
        this.startWatcher(pair);
      } else if (pair.mode === 'periodic') {
        this.startInterval(pair);
      }
    }
  }

  /** Start a chokidar watch on the source directory for a single pair */
  private startWatcher(pair: DirectorySyncPair): void {
    // Don't double-watch
    if (this.watchers.has(pair.id)) return;

    this.pairStatus.set(pair.id, 'idle');

    const onFileEvent = (filePath: string) => {
      const existing = this.debounceTimers.get(pair.id);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(
        pair.id,
        setTimeout(() => this.runSync(pair), DEBOUNCE_MS)
      );
    };

    try {
      const watcher = chokidarWatch(pair.sourcePath, {
        persistent: true,
        ignoreInitial: true,
      });

      watcher.on('add', onFileEvent);
      watcher.on('change', onFileEvent);
      watcher.on('unlink', onFileEvent);

      watcher.on('error', (err) => {
        this.events.push('watcher-error', pair.id, {
          error: err.message,
          sourcePath: pair.sourcePath,
        });
        this.pairStatus.set(pair.id, 'error');
      });

      this.watchers.set(pair.id, watcher);
    } catch (err) {
      this.pairStatus.set(pair.id, 'error');
      this.events.push('watcher-error', pair.id, {
        error: err instanceof Error ? err.message : String(err),
        sourcePath: pair.sourcePath,
      });
    }
  }

  /** Start a periodic interval for a single pair */
  private startInterval(pair: DirectorySyncPair): void {
    if (this.intervals.has(pair.id)) return;

    this.pairStatus.set(pair.id, 'idle');

    // Run once immediately on startup
    this.runSync(pair);

    const intervalMs = pair.intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      this.runSync(pair);
    }, intervalMs);

    this.intervals.set(pair.id, timer);
  }

  /** Stop watcher and debounce timer for a pair */
  private stopPair(id: string): void {
    const debounce = this.debounceTimers.get(id);
    if (debounce) {
      clearTimeout(debounce);
      this.debounceTimers.delete(id);
    }

    const watcher = this.watchers.get(id);
    if (watcher) {
      watcher.close().catch(() => {});
      this.watchers.delete(id);
    }

    this.stopInterval(id);
    this.pairStatus.delete(id);
  }

  /** Stop periodic interval for a pair */
  private stopInterval(id: string): void {
    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }
  }

  /** Execute a sync for a given pair (called by watcher debounce or periodic interval) */
  private async runSync(pair: DirectorySyncPair): Promise<void> {
    this.pairStatus.set(pair.id, 'syncing');
    this.events.push('sync-start', pair.id, {
      sourcePath: pair.sourcePath,
      destPath: pair.destPath,
    });

    const startTime = Date.now();

    try {
      const { stats, files } = await executeRsync(pair, false, (fileCount) => {
        this.events.push('sync-progress', pair.id, {
          filesProcessed: fileCount,
          elapsedMs: Date.now() - startTime,
        });
      });
      const durationMs = Date.now() - startTime;
      stats.durationMs = durationMs;

      this.pairStatus.set(pair.id, 'idle');
      this.events.push('sync-complete', pair.id, {
        ...stats,
        fileCount: files.length,
      });

      // Update the persisted pair stats
      await this.updatePairStats(pair.id, stats);

      // Log to JSONL
      await appendSyncLog(pair.id, {
        type: 'sync',
        timestamp: new Date().toISOString(),
        stats: { ...stats, durationMs },
        fileCount: files.length,
      });
    } catch (err) {
      this.pairStatus.set(pair.id, 'error');
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.events.push('sync-error', pair.id, { error: errorMsg });

      // Update the persisted pair with error
      await this.updatePairError(pair.id, errorMsg);

      // Log to JSONL
      await appendSyncLog(pair.id, {
        type: 'error',
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });
    }
  }

  /** Run a sync immediately for a specific pair (called from API run-now) */
  async runSyncNow(pair: DirectorySyncPair): Promise<DirectorySyncStats> {
    this.pairStatus.set(pair.id, 'syncing');
    this.events.push('sync-start', pair.id, {
      sourcePath: pair.sourcePath,
      destPath: pair.destPath,
    });

    const startTime = Date.now();

    try {
      const { stats, files } = await executeRsync(pair, false, (fileCount) => {
        this.events.push('sync-progress', pair.id, {
          filesProcessed: fileCount,
          elapsedMs: Date.now() - startTime,
        });
      });
      stats.durationMs = Date.now() - startTime;

      this.pairStatus.set(pair.id, 'idle');
      this.events.push('sync-complete', pair.id, {
        ...stats,
        fileCount: files.length,
      });

      await this.updatePairStats(pair.id, stats);
      await appendSyncLog(pair.id, {
        type: 'manual-sync',
        timestamp: new Date().toISOString(),
        stats: { ...stats, durationMs: stats.durationMs },
        fileCount: files.length,
      });

      return stats;
    } catch (err) {
      this.pairStatus.set(pair.id, 'error');
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.events.push('sync-error', pair.id, { error: errorMsg });
      await this.updatePairError(pair.id, errorMsg);
      throw err; // Re-throw so the API can return the error
    }
  }

  /** Run a dry-run for a specific pair (called from API dry-run) */
  async dryRun(
    pair: DirectorySyncPair
  ): Promise<DirectorySyncStats & { files: string[] }> {
    this.events.push('dry-run-complete', pair.id, { phase: 'start' });

    const { stats, files } = await executeRsync(pair, true);

    this.events.push('dry-run-complete', pair.id, {
      ...stats,
      fileCount: files.length,
    });

    return { ...stats, files };
  }

  /** Get the live status of a pair (from the in-memory watcher state) */
  getPairStatus(id: string): SyncStatus | undefined {
    return this.pairStatus.get(id);
  }

  /** Get events since a timestamp (for polling) */
  getEventsSince(since: string): DirectorySyncEventEntry[] {
    return this.events.getSince(since);
  }

  /** Update pair stats in the persisted config after a sync */
  private async updatePairStats(id: string, stats: DirectorySyncStats): Promise<void> {
    try {
      const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
      const pair = data.pairs.find(p => p.id === id);
      if (!pair) return;

      pair.stats = stats;
      pair.lastSync = new Date().toISOString();
      pair.lastError = null;
      pair.status = 'idle';
      pair.updatedAt = new Date().toISOString();
      data.lastUpdated = pair.updatedAt;

      // Use atomic write (writeJsonFile does tmp + rename)
      await writeJsonFile(DATA_PATH, data);
    } catch {
      // Non-fatal: stats persistence failure shouldn't crash the watcher
    }
  }

  /** Update pair error in the persisted config after a failure */
  private async updatePairError(id: string, error: string): Promise<void> {
    try {
      const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
      const pair = data.pairs.find(p => p.id === id);
      if (!pair) return;

      pair.lastError = error;
      pair.status = 'error';
      pair.updatedAt = new Date().toISOString();
      data.lastUpdated = pair.updatedAt;
      await writeJsonFile(DATA_PATH, data);
    } catch {
      // Non-fatal
    }
  }

  /** Shut down all watchers and intervals gracefully */
  async shutdown(): Promise<void> {
    for (const [, watcher] of this.watchers) {
      watcher.close().catch(() => {});
    }
    this.watchers.clear();

    for (const [, interval] of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();

    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.pairStatus.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let _instance: DirectorySyncWatcher | null = null;

/** Get or create the singleton watcher instance */
export function getSyncWatcher(): DirectorySyncWatcher {
  if (!_instance) {
    _instance = new DirectorySyncWatcher();
    // Fire-and-forget initial load — don't block the first API call
    _instance.reload().catch((err) => {
      console.error('[DevFlow] Directory Sync watcher init failed:', err);
    });
  }
  return _instance;
}

/** Start the watcher explicitly (called from PM2 startup script or instrumentation) */
export function startDirectorySyncWatcher(): DirectorySyncWatcher {
  const watcher = getSyncWatcher();
  console.log('[DevFlow] Directory Sync watcher started');
  return watcher;
}
