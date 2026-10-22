/**
 * Canonical types + I/O for the outlook-watcher store.
 *
 * Two writers contend on this file: DevFlow's Next.js API route at
 * /api/outlook/watches (and its action equivalents on /api/agent), and the
 * outlook-watcher PM2 process (services/outlook-watcher). They live in
 * different processes — DevFlow's in-process withFileLock cannot synchronise
 * across them. We use an O_EXCL sidecar lockfile (`<file>.lock`) which both
 * processes contend on identically.
 *
 * Both sides import this module — the watcher via a relative path
 * (`../../../lib/outlook-watches-store`). Single source of truth.
 *
 * See `services/outlook-watcher/PROJECT.md` § 3 for the schema rationale.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';

import type { NotifyTemplate } from './outlook-events';

// ---------- Schema ----------

export interface WatchFilter {
  /** Sender email substring match, case-insensitive. Any-match (OR) within array. */
  from?: string[];
  /** Subject substring match, case-insensitive. Any-match. */
  subjectContains?: string[];
  /** bodyPreview substring match, case-insensitive. Any-match. */
  bodyContains?: string[];
  /** true = require attachments, false = require none, undefined = ignore. */
  hasAttachment?: boolean;
  importance?: 'low' | 'normal' | 'high';
  /** Typically false — react only to unread mail. undefined = ignore. */
  isRead?: boolean;
}

export interface Watch {
  id: string;
  ownerParticipantId: string;
  channelId: string;
  filter: WatchFilter;
  folderId?: string;
  userId?: string;
  intervalMs: number;
  enabled: boolean;
  /** Delivery engine. Omitted on legacy records and treated as `poll`. */
  deliveryMode?: 'poll' | 'push';
  notifyTemplate?: NotifyTemplate;

  lastSeenMessageId?: string;
  lastChecked: string;
  dedupRing: string[];

  createdAt: string;
  updatedAt: string;
  failureCount: number;
  lastError?: {
    kind: 'transport' | 'rpc' | 'tool' | 'parse' | 'logic';
    message: string;
    at: string;
  };
}

export interface WatchStore {
  version: 1;
  watches: Watch[];
  lastUpdated: string;
}

export const SCHEMA_VERSION = 1 as const;

// ---------- Path resolution ----------

/**
 * The watch-store file lives in DevFlow's .AppData (runtime state, regenerable),
 * NOT data/ (git-tracked product data). DataPaths in `lib/data-paths.ts` is the
 * canonical resolver inside DevFlow's Next.js process; the watcher (a separate
 * PM2 process with its own CWD) cannot import that module without dragging in
 * Next.js — so we mirror its resolution here.
 *
 * Order:
 *   1. OUTLOOK_WATCHER_STORE env var (explicit override)
 *   2. DEVFLOW_APP_DATA_DIR env var as base + 'outlook-watches.json'
 *   3. DEVFLOW_DATA_DIR env var (legacy alias for AppData) as base
 *   4. ~/DevFlow/.AppData/outlook-watches.json (the owner's standard install)
 */
function resolveAppDataBase(): string {
  if (process.env.DEVFLOW_APP_DATA_DIR) {
    const v = process.env.DEVFLOW_APP_DATA_DIR;
    return path.isAbsolute(v) ? v : path.join(homedir(), 'DevFlow', v);
  }
  if (process.env.DEVFLOW_DATA_DIR) {
    const v = process.env.DEVFLOW_DATA_DIR;
    return path.isAbsolute(v) ? v : path.join(homedir(), 'DevFlow', v);
  }
  return path.join(homedir(), 'DevFlow', '.AppData');
}

export function getStorePath(): string {
  if (process.env.OUTLOOK_WATCHER_STORE) return process.env.OUTLOOK_WATCHER_STORE;
  return path.join(resolveAppDataBase(), 'outlook-watches.json');
}

// ---------- Cross-process advisory lock (O_EXCL) ----------

const STALE_AFTER_MS = 30_000;
const POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 5_000;

async function acquireFileLock(targetPath: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lockPath = `${targetPath}.lock`;
  const start = Date.now();

  while (true) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.write(`${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        await fh.close();
      }
      return async () => {
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw err;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`acquireFileLock timeout (${timeoutMs}ms) on ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

// ---------- I/O ----------

export function emptyStore(): WatchStore {
  return { version: SCHEMA_VERSION, watches: [], lastUpdated: new Date().toISOString() };
}

export async function readWatchStore(): Promise<WatchStore> {
  const target = getStorePath();
  try {
    const raw = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WatchStore>;
    return normalize(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return emptyStore();
    throw err;
  }
}

export async function writeWatchStore(store: WatchStore): Promise<void> {
  const target = getStorePath();
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  store.lastUpdated = new Date().toISOString();
  store.version = SCHEMA_VERSION;
  const tmp = `${target}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export async function withWatchStoreLock<T>(
  fn: (store: WatchStore) => Promise<{ store: WatchStore; result: T }>,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const target = getStorePath();
  const release = await acquireFileLock(target, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const store = await readWatchStore();
    const { store: next, result } = await fn(store);
    await writeWatchStore(next);
    return result;
  } finally {
    await release();
  }
}

// ---------- Validation helpers ----------

export const MIN_INTERVAL_MS = 30_000;
export const MAX_INTERVAL_MS = 3_600_000;

export function isFilterMeaningful(filter: WatchFilter | undefined): boolean {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.from) && filter.from.length > 0) return true;
  if (Array.isArray(filter.subjectContains) && filter.subjectContains.length > 0) return true;
  if (Array.isArray(filter.bodyContains) && filter.bodyContains.length > 0) return true;
  if (typeof filter.hasAttachment === 'boolean') return true;
  if (filter.importance) return true;
  if (typeof filter.isRead === 'boolean') return true;
  return false;
}

export function coerceFilter(input: unknown): WatchFilter {
  const filter: WatchFilter = {};
  if (!input || typeof input !== 'object') return filter;
  const src = input as Record<string, unknown>;

  if (Array.isArray(src.from)) {
    const list = src.from.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (list.length > 0) filter.from = list;
  }
  if (Array.isArray(src.subjectContains)) {
    const list = src.subjectContains.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (list.length > 0) filter.subjectContains = list;
  }
  if (Array.isArray(src.bodyContains)) {
    const list = src.bodyContains.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (list.length > 0) filter.bodyContains = list;
  }
  if (typeof src.hasAttachment === 'boolean') filter.hasAttachment = src.hasAttachment;
  if (src.importance === 'low' || src.importance === 'normal' || src.importance === 'high') {
    filter.importance = src.importance;
  }
  if (typeof src.isRead === 'boolean') filter.isRead = src.isRead;
  return filter;
}

// ---------- Internal ----------

function normalize(parsed: Partial<WatchStore>): WatchStore {
  const watches: Watch[] = Array.isArray(parsed.watches) ? parsed.watches.map(coerceWatch) : [];
  return {
    version: SCHEMA_VERSION,
    watches,
    lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : new Date().toISOString(),
  };
}

function coerceWatch(w: Partial<Watch>): Watch {
  return {
    id: String(w.id ?? ''),
    ownerParticipantId: String(w.ownerParticipantId ?? ''),
    channelId: String(w.channelId ?? ''),
    filter: w.filter && typeof w.filter === 'object' ? w.filter : {},
    folderId: typeof w.folderId === 'string' ? w.folderId : undefined,
    userId: typeof w.userId === 'string' ? w.userId : undefined,
    intervalMs: typeof w.intervalMs === 'number' ? w.intervalMs : 60_000,
    enabled: w.enabled !== false,
    deliveryMode: w.deliveryMode === 'push' ? 'push' : 'poll',
    notifyTemplate: w.notifyTemplate,
    lastSeenMessageId: typeof w.lastSeenMessageId === 'string' ? w.lastSeenMessageId : undefined,
    lastChecked: typeof w.lastChecked === 'string' ? w.lastChecked : new Date(0).toISOString(),
    dedupRing: Array.isArray(w.dedupRing) ? w.dedupRing.slice(-64) : [],
    createdAt: typeof w.createdAt === 'string' ? w.createdAt : new Date().toISOString(),
    updatedAt: typeof w.updatedAt === 'string' ? w.updatedAt : new Date().toISOString(),
    failureCount: typeof w.failureCount === 'number' ? w.failureCount : 0,
    lastError: w.lastError,
  };
}
