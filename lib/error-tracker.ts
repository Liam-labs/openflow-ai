/**
 * Error Tracker
 *
 * In-memory ring buffer (last 500 errors) with:
 * - File persistence to .AppData/error-log.json
 * - Deduplication: same message+source within 60s collapses into one entry (incrementing count)
 * - Query API: filter by severity, source, time range
 * - Stats: counts by category for last 1h and 24h
 *
 * Consumers:
 *   import { errorTracker } from '@/lib/error-tracker';
 *   errorTracker.record({ type: 'error:api', severity: 'high', source: '...', message: '...' });
 *
 * The event bus integration is wired in instrumentation.ts so errors are
 * captured from SSE events as they're emitted.
 */

import path from 'path';
import { promises as fs } from 'fs';
import type { ErrorEventPayload, SSEEventType } from '@/lib/event-bus';
import { appPath } from '@/lib/app-paths';

// ============================================
// Types
// ============================================

export interface TrackedError {
  id: string;
  type: 'error:api' | 'error:collab' | 'error:agent';
  severity: ErrorEventPayload['severity'];
  source: string;
  message: string;
  stack?: string;
  requestId?: string;
  context?: Record<string, unknown>;
  firstSeen: string;   // ISO timestamp of first occurrence
  lastSeen: string;    // ISO timestamp of most recent occurrence
  count: number;       // How many times this (message+source) was seen
}

// Legacy JSON format (for migration from .AppData/error-log.json)
interface ErrorLogFile {
  version: 1;
  errors: TrackedError[];
  lastFlushed: string;
}

// ============================================
// Constants
// ============================================

const RING_BUFFER_SIZE = 500;
const DEDUP_WINDOW_MS = 60_000;       // 60 seconds
const PERSIST_DEBOUNCE_MS = 5_000;   // Flush to disk at most once per 5s

// ============================================
// Error Tracker Singleton
// ============================================

class ErrorTracker {
  private buffer: TrackedError[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPath: string;
  private loaded = false;

  constructor() {
    // Persist to logs/errors.jsonl (JSONL, one TrackedError per line).
    // Legacy: was .AppData/error-log.json (JSON format — migrated on first load).
    this.persistPath = appPath('logs', 'errors.jsonl');
  }

  /**
   * Record an error. Called by SSE event listeners or directly.
   */
  record(
    type: 'error:api' | 'error:collab' | 'error:agent',
    payload: ErrorEventPayload
  ): TrackedError {
    const { severity, source, message, stack, requestId, context, timestamp } = payload;
    const now = timestamp || new Date().toISOString();
    const dedupKey = `${source}::${message}`;
    const windowCutoff = Date.now() - DEDUP_WINDOW_MS;

    // Check for a recent duplicate
    const existing = this.buffer.find(
      e =>
        e.type === type &&
        e.source === source &&
        e.message === message &&
        new Date(e.lastSeen).getTime() >= windowCutoff
    );

    if (existing) {
      existing.count++;
      existing.lastSeen = now;
      if (stack) existing.stack = stack;
      if (requestId) existing.requestId = requestId;
      this.schedulePersist();
      return existing;
    }

    // New error entry
    const entry: TrackedError = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      severity,
      source,
      message,
      stack,
      requestId,
      context,
      firstSeen: now,
      lastSeen: now,
      count: 1,
    };

    this.buffer.push(entry);

    // Ring buffer — evict oldest when full
    if (this.buffer.length > RING_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-RING_BUFFER_SIZE);
    }

    this.schedulePersist();

    // Persist to unified event log (fire-and-forget)
    import('@/lib/log-writer').then(({ writeLogEntry, makeLogEntry }) => {
      writeLogEntry(makeLogEntry(
        'error',
        entry.severity,
        `${entry.source}: ${entry.message}`,
        { errorType: type, errorSource: entry.source, requestId: entry.requestId, context: entry.context },
        entry.stack,
      ));
    }).catch(() => {});

    return entry;
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * List errors with optional filters.
   */
  list(opts: {
    severity?: TrackedError['severity'];
    source?: string;
    type?: TrackedError['type'];
    since?: string;    // ISO timestamp — only errors with lastSeen >= since
    limit?: number;
    offset?: number;
  } = {}): { errors: TrackedError[]; total: number } {
    let results = [...this.buffer].reverse(); // newest first

    if (opts.severity) {
      results = results.filter(e => e.severity === opts.severity);
    }
    if (opts.source) {
      results = results.filter(e => e.source.includes(opts.source!));
    }
    if (opts.type) {
      results = results.filter(e => e.type === opts.type);
    }
    if (opts.since) {
      const cutoff = new Date(opts.since).getTime();
      results = results.filter(e => new Date(e.lastSeen).getTime() >= cutoff);
    }

    const total = results.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    return { errors: results.slice(offset, offset + limit), total };
  }

  /**
   * Stats: error counts bucketed by category and severity for last 1h and 24h.
   */
  stats(): {
    last1h: StatsSnapshot;
    last24h: StatsSnapshot;
    total: number;
    bufferSize: number;
  } {
    const now = Date.now();
    const h1Cutoff = now - 60 * 60 * 1000;
    const h24Cutoff = now - 24 * 60 * 60 * 1000;

    return {
      last1h: this.snapshot(this.buffer.filter(e => new Date(e.lastSeen).getTime() >= h1Cutoff)),
      last24h: this.snapshot(this.buffer.filter(e => new Date(e.lastSeen).getTime() >= h24Cutoff)),
      total: this.buffer.length,
      bufferSize: RING_BUFFER_SIZE,
    };
  }

  private snapshot(errors: TrackedError[]): StatsSnapshot {
    const byType: Record<string, number> = { 'error:api': 0, 'error:collab': 0, 'error:agent': 0 };
    const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };

    for (const e of errors) {
      // Count 1 per entry — e.count is a lifetime total that spans beyond the
      // window being measured. Using it would inflate window stats with
      // historical occurrences from before the window cutoff.
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    }

    return {
      count: errors.length,
      uniqueErrors: errors.length,
      byType: byType as Record<TrackedError['type'], number>,
      bySeverity: bySeverity as Record<TrackedError['severity'], number>,
    };
  }

  // ============================================
  // Persistence
  // ============================================

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush().catch(err =>
        console.error('[error-tracker] flush failed:', err)
      );
    }, PERSIST_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    // Write the full ring buffer as JSONL (one TrackedError per line).
    // Atomic: write to temp file then rename.
    const tempPath = this.persistPath + `.tmp.${process.pid}`;
    try {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + (this.buffer.length ? '\n' : '');
      await fs.writeFile(tempPath, lines, 'utf-8');
      await fs.rename(tempPath, this.persistPath);
    } catch (err) {
      console.error('[error-tracker] write error:', err);
      try { await fs.unlink(tempPath); } catch { /* ignore */ }
    }
  }

  /**
   * Load persisted errors on first access. Call once during startup.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.persistPath, 'utf-8');
      const errors: TrackedError[] = [];

      // Try JSONL format (new) first — one TrackedError per line
      for (const line of raw.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as TrackedError;
          // Basic validation — must have required fields
          if (parsed.id && parsed.type && parsed.source && parsed.message) {
            errors.push(parsed);
          }
        } catch { /* skip malformed lines */ }
      }

      if (errors.length > 0) {
        // Merge: prepend historical errors behind any new ones that arrived
        // during the async file read (boot race — new errors already in buffer).
        this.buffer = [...errors, ...this.buffer].slice(-RING_BUFFER_SIZE);
        return;
      }

      // Fall back: try legacy JSON format { version: 1, errors: [...] }
      try {
        const data = JSON.parse(raw) as ErrorLogFile;
        if (data.version === 1 && Array.isArray(data.errors)) {
          this.buffer = [...data.errors, ...this.buffer].slice(-RING_BUFFER_SIZE);
        }
      } catch { /* ignore — file may be empty or partial */ }
    } catch {
      // ENOENT on first run — normal. Tracker starts with empty buffer.
      // Try legacy path as fallback
      try {
        const appData = process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData';
        const legacyPath = appPath(appData, 'error-log.json');
        const raw = await fs.readFile(legacyPath, 'utf-8');
        const data = JSON.parse(raw) as ErrorLogFile;
        if (data.version === 1 && Array.isArray(data.errors)) {
          this.buffer = [...data.errors, ...this.buffer].slice(-RING_BUFFER_SIZE);
          // Migrate: flush to new path
          this.schedulePersist();
        }
      } catch { /* no legacy file — normal on fresh install */ }
    }
  }
}

export interface StatsSnapshot {
  count: number;
  uniqueErrors: number;
  byType: Record<TrackedError['type'], number>;
  bySeverity: Record<TrackedError['severity'], number>;
}

// ============================================
// Singleton (survives hot reloads)
// ============================================

const globalForTracker = globalThis as typeof globalThis & {
  __errorTracker?: ErrorTracker;
};

export const errorTracker: ErrorTracker =
  globalForTracker.__errorTracker ?? new ErrorTracker();

globalForTracker.__errorTracker = errorTracker;

// ============================================
// SSE Event Bus Integration
// ============================================

/**
 * Wire the error tracker to the SSE event bus.
 * Call once from instrumentation.ts after both singletons are initialized.
 */
export function wireErrorTrackerToEventBus(): void {
  // Lazy import to avoid circular dependency at module load time
  import('@/lib/event-bus').then(({ eventBus }) => {
    // Load persisted errors from last run
    errorTracker.load().catch(() => {});

    // Listen for error events emitted by API routes / collab system
    eventBus.on('sse-event', (event: { type: SSEEventType; data: unknown }) => {
      if (
        event.type === 'error:api' ||
        event.type === 'error:collab' ||
        event.type === 'error:agent'
      ) {
        errorTracker.record(event.type, event.data as ErrorEventPayload);
      }
    });
  }).catch(() => {});
}
