/**
 * Log Reader — JSONL query engine for the DevFlow Logs Dashboard
 *
 * Reads from logs/event-logs/current.jsonl (today) and
 * logs/event-logs/{YYYY-MM-DD}.jsonl (archives).
 *
 * queryLogs() uses line-by-line filtering with a safety cap of 50,000
 * matched entries to prevent OOM on large date ranges.
 * Stats/timeline functions still load full files (bounded by 31-day cap).
 */

import path from 'path';
import { promises as fs } from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';
import type { UnifiedLogEntry, LogSource, LogSeverity } from './log-types';
import { LOG_BASE, CURRENT_LOG } from './log-writer';

const gunzip = promisify(zlib.gunzip);

// ============================================
// Types
// ============================================

export interface LogQuery {
  sources?: LogSource[];
  severity?: LogSeverity[];
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
  agentName?: string;
  channelId?: string;
  serviceName?: string;
}

export interface LogQueryResult {
  entries: UnifiedLogEntry[];
  total: number;
  sources: Record<string, number>;
  timeRange: { from: string; to: string };
}

export interface LogStats {
  total: number;
  bySource: Record<string, number>;
  bySeverity: Record<string, number>;
  hourlyBreakdown: Array<{ hour: string; count: number; bySource: Record<string, number> }>;
  storageBytes: number;
  timeRange: { from: string; to: string };
}

export interface TimelineBucket {
  bucket: string;          // ISO timestamp of bucket start
  total: number;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
}

export interface TimelineResult {
  buckets: TimelineBucket[];
  bucketSizeMinutes: number;
  timeRange: { from: string; to: string };
}

// ============================================
// File path helpers
// ============================================

function getFilePath(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return dateStr === today ? CURRENT_LOG : path.join(LOG_BASE, `${dateStr}.jsonl`);
}

function getGzPath(dateStr: string): string {
  return path.join(LOG_BASE, `${dateStr}.jsonl.gz`);
}

/** Generate list of YYYY-MM-DD strings spanning the given range (inclusive). */
function getDateRange(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);

  // Safety: cap at 31 days to prevent runaway reads
  const maxDays = 31;
  let count = 0;

  while (d <= end && count < maxDays) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
    count++;
  }
  return dates;
}

// ============================================
// File reading
// ============================================

async function readLogFile(filePath: string): Promise<UnifiedLogEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    // Plain file missing — try the compressed version
    try {
      const dateStr = path.basename(filePath, '.jsonl');
      const gzPath = getGzPath(dateStr);
      const compressed = await fs.readFile(gzPath);
      content = (await gunzip(compressed)).toString('utf-8');
    } catch {
      return []; // Neither exists — normal for days with no events
    }
  }

  const entries: UnifiedLogEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as UnifiedLogEntry);
    } catch { /* skip malformed lines */ }
  }
  return entries;
}

// ============================================
// Filtering
// ============================================

function matchesSearch(entry: UnifiedLogEntry, search: string): boolean {
  const lower = search.toLowerCase();
  if (entry.title.toLowerCase().includes(lower)) return true;
  if (entry.details?.toLowerCase().includes(lower)) return true;
  try {
    if (JSON.stringify(entry.metadata).toLowerCase().includes(lower)) return true;
  } catch { /* ignore */ }
  return false;
}

function matchesQuery(
  entry: UnifiedLogEntry,
  query: LogQuery,
  fromIso: string,
  toIso: string,
): boolean {
  if (entry.timestamp < fromIso) return false;
  if (entry.timestamp > toIso) return false;
  if (query.sources?.length && !query.sources.includes(entry.source)) return false;
  if (query.severity?.length && !query.severity.includes(entry.severity)) return false;
  if (query.search && !matchesSearch(entry, query.search)) return false;
  const meta = entry.metadata as Record<string, unknown>;
  if (query.agentName && meta.agentName !== query.agentName) return false;
  if (query.channelId && meta.channelId !== query.channelId) return false;
  if (query.serviceName && meta.serviceName !== query.serviceName) return false;
  return true;
}

// ============================================
// Public API
// ============================================

/** Safety cap: max matched entries held in memory before stopping collection */
const MATCH_CAP = 50_000;

/**
 * Query log entries with filtering and pagination.
 * Default time range: last 24 hours.
 *
 * Filters line-by-line per file with early termination once MATCH_CAP is reached.
 * This prevents OOM on large date ranges.
 */
export async function queryLogs(query: LogQuery): Promise<LogQueryResult> {
  const now = new Date();
  const from = query.from ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const to = query.to ?? now;
  const limit = Math.min(query.limit ?? 100, 1000);
  const offset = query.offset ?? 0;

  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const dates = getDateRange(from, to);

  // Filter line-by-line per file, collect only matching entries up to MATCH_CAP
  const matched: UnifiedLogEntry[] = [];
  const sources: Record<string, number> = {};
  let capped = false;

  for (const date of dates) {
    if (capped) break;
    const entries = await readLogFile(getFilePath(date));
    for (const entry of entries) {
      if (!matchesQuery(entry, query, fromIso, toIso)) continue;
      sources[entry.source] = (sources[entry.source] ?? 0) + 1;
      matched.push(entry);
      if (matched.length >= MATCH_CAP) {
        capped = true;
        break;
      }
    }
  }

  // Sort descending (newest first)
  matched.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    entries: matched.slice(offset, offset + limit),
    total: matched.length,
    sources,
    timeRange: { from: fromIso, to: toIso },
  };
}

/**
 * Aggregate stats for the given time range.
 */
export async function getLogStats(from: Date, to: Date): Promise<LogStats> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const dates = getDateRange(from, to);

  const bySource: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  // hourly: { "2026-03-16T14": { count: N, bySource: {...} } }
  const hourlyMap = new Map<string, { count: number; bySource: Record<string, number> }>();
  let total = 0;

  for (const date of dates) {
    const entries = await readLogFile(getFilePath(date));
    for (const e of entries) {
      if (e.timestamp < fromIso || e.timestamp > toIso) continue;
      total++;
      bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;

      const hourKey = e.timestamp.slice(0, 13); // "2026-03-16T14"
      if (!hourlyMap.has(hourKey)) {
        hourlyMap.set(hourKey, { count: 0, bySource: {} });
      }
      const slot = hourlyMap.get(hourKey)!;
      slot.count++;
      slot.bySource[e.source] = (slot.bySource[e.source] ?? 0) + 1;
    }
  }

  // Build hourly breakdown sorted ascending
  const hourlyBreakdown = Array.from(hourlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, data]) => ({
      hour: `${hour}:00:00.000Z`,
      count: data.count,
      bySource: data.bySource,
    }));

  const storageBytes = await getLogStorageBytes();

  return {
    total,
    bySource,
    bySeverity,
    hourlyBreakdown,
    storageBytes,
    timeRange: { from: fromIso, to: toIso },
  };
}

/**
 * Bucketed event counts for the timeline scrubber.
 * Bucket size is auto-selected based on range:
 *   ≤ 2h  → 5min buckets
 *   ≤ 24h → 30min buckets
 *   ≤ 7d  → 6h buckets
 *   > 7d  → 1d buckets
 */
export async function getLogTimeline(from: Date, to: Date): Promise<TimelineResult> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const rangeMs = to.getTime() - from.getTime();
  const rangeDays = rangeMs / (1000 * 60 * 60 * 24);

  let bucketMinutes: number;
  if (rangeDays <= (2 / 24)) bucketMinutes = 1;         // ≤ 2h → 1min
  else if (rangeDays <= (12 / 24)) bucketMinutes = 5;   // ≤ 12h → 5min
  else if (rangeDays <= 1) bucketMinutes = 30;           // ≤ 24h → 30min
  else if (rangeDays <= 7) bucketMinutes = 60 * 6;       // ≤ 7d → 6h
  else bucketMinutes = 60 * 24;                          // > 7d → 1d

  const bucketMs = bucketMinutes * 60 * 1000;
  const bucketMap = new Map<number, TimelineBucket>();

  const dates = getDateRange(from, to);
  for (const date of dates) {
    const entries = await readLogFile(getFilePath(date));
    for (const e of entries) {
      if (e.timestamp < fromIso || e.timestamp > toIso) continue;
      const ts = new Date(e.timestamp).getTime();
      const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
      if (!bucketMap.has(bucketStart)) {
        bucketMap.set(bucketStart, {
          bucket: new Date(bucketStart).toISOString(),
          total: 0,
          bySeverity: {},
          bySource: {},
        });
      }
      const b = bucketMap.get(bucketStart)!;
      b.total++;
      b.bySeverity[e.severity] = (b.bySeverity[e.severity] ?? 0) + 1;
      b.bySource[e.source] = (b.bySource[e.source] ?? 0) + 1;
    }
  }

  // Fill in zero-count buckets between from and to (so the frontend has a complete array)
  const buckets: TimelineBucket[] = [];
  const startBucket = Math.floor(from.getTime() / bucketMs) * bucketMs;
  const endBucket = Math.floor(to.getTime() / bucketMs) * bucketMs;
  for (let t = startBucket; t <= endBucket; t += bucketMs) {
    buckets.push(bucketMap.get(t) ?? {
      bucket: new Date(t).toISOString(),
      total: 0,
      bySeverity: {},
      bySource: {},
    });
  }

  return {
    buckets,
    bucketSizeMinutes: bucketMinutes,
    timeRange: { from: fromIso, to: toIso },
  };
}

/**
 * Total bytes used by all .jsonl files in the event-logs directory.
 */
export async function getLogStorageBytes(): Promise<number> {
  try {
    let total = 0;
    const files = await fs.readdir(LOG_BASE);
    await Promise.all(
      files.filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')).map(async (f) => {
        const stat = await fs.stat(path.join(LOG_BASE, f));
        total += stat.size;
      })
    );
    return total;
  } catch {
    return 0;
  }
}
