/**
 * Shared Data I/O Utility
 *
 * Provides atomic file writes and per-file async locking for all JSON data files.
 * Prevents corruption from concurrent writes (the root cause of past collab bugs).
 *
 * Usage:
 *   import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
 *
 *   // Simple read/write
 *   const data = await readJsonFile<MyType>(path, defaultValue);
 *   await writeJsonFile(path, data);
 *
 *   // Locked read-modify-write (for shared files)
 *   await withFileLock(path, async () => {
 *     const data = await readJsonFile<MyType>(path, defaultValue);
 *     data.items.push(newItem);
 *     await writeJsonFile(path, data);
 *   });
 */

import { promises as fs } from 'fs';
import path from 'path';

declare global {
  // Next.js can evaluate this module in more than one compiled chunk inside
  // the same server process. Keep coordination state on globalThis so route
  // handlers and instrumentation monitors cannot hold independent locks or
  // stale caches for the same JSON file.
  var __devflowDataIoFileLocks: Map<string, Promise<void>> | undefined;
  var __devflowDataIoJsonCache: JsonCache | undefined;
}

// Per-file lock chains. Each key is an absolute file path.
// Value is a promise that resolves when the current holder releases.
const fileLocks = globalThis.__devflowDataIoFileLocks ??= new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// In-memory read cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 5_000; // 5s — long enough to collapse burst reads, short enough to stay fresh

/**
 * In-memory TTL cache for JSON file reads.
 *
 * - get()         — return cached value if fresh, otherwise read from disk and cache
 * - invalidate()  — remove a specific path from the cache (called by writeJsonFile)
 * - clear()       — flush all entries (useful in tests)
 *
 * Applied to all readJsonFile / writeJsonFile calls automatically.
 */
export class JsonCache {
  private cache = new Map<string, CacheEntry>();

  async get<T>(filePath: string, defaultValue: T, loader: () => Promise<T>): Promise<T> {
    const resolved = path.resolve(filePath);
    const entry = this.cache.get(resolved);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.data as T;
    }
    const data = await loader();
    this.cache.set(resolved, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  }

  invalidate(filePath: string): void {
    this.cache.delete(path.resolve(filePath));
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const jsonCache = globalThis.__devflowDataIoJsonCache ??= new JsonCache();

/**
 * Read and parse a JSON file. Returns `defaultValue` on any failure
 * (missing file, parse error). Parse errors are logged so they're visible.
 *
 * Results are cached for 5s to reduce disk I/O on hot files
 * (collab-channels.json, projects.json, api-tokens.json, roles.json).
 * Cache is automatically invalidated by writeJsonFile.
 */
const keptCorrupt = new Set<string>();

/**
 * A file that no longer parses is read as "empty", and the next write replaces it, so whatever was in it (api-tokens.json, for one)
 * would be gone. Keep a copy beside it first, once per version of the file.
 */
async function keepCorruptCopy(filePath: string): Promise<void> {
  try {
    const st = await fs.stat(filePath);
    const key = `${filePath}:${st.size}:${st.mtimeMs}`;
    if (keptCorrupt.has(key)) return;
    keptCorrupt.add(key);
    const copy = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(filePath, copy);
    await fs.chmod(copy, 0o600).catch(() => undefined);
    console.error(`[data-io] kept a copy of the unreadable ${filePath} as ${copy}`);
  } catch {
    // best effort: never make a read fail because the copy could not be made
  }
}

export class JsonFileCorruptError extends Error {
  readonly filePath: string;
  constructor(filePath: string, detail: string) {
    super(`${filePath} exists but is not valid JSON (${detail}). A copy was kept as ${filePath}.corrupt-*; fix or restore the file. Nothing was overwritten.`);
    this.name = 'JsonFileCorruptError';
    this.filePath = filePath;
  }
}

/**
 * Like readJsonFile, but a file that exists and does not parse is an ERROR, not "empty". For files whose loss would be silent and
 * serious (the token store): the caller must not carry on with defaults and write them over what is there. A missing file is
 * still the default (first run). Not cached.
 */
export async function readJsonFileStrict<T>(filePath: string, defaultValue: T): Promise<T> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return defaultValue;
    throw error;
  }
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    await keepCorruptCopy(filePath);
    console.error(`[data-io] ERROR: ${filePath} is not valid JSON and was NOT replaced with defaults:`, error instanceof Error ? error.message : error);
    throw new JsonFileCorruptError(filePath, error instanceof Error ? error.message : 'parse error');
  }
}

export async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  return jsonCache.get(filePath, defaultValue, async () => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      // Distinguish "file doesn't exist" (normal) from "parse error" (bug)
      if (error instanceof SyntaxError) {
        console.error(`[data-io] JSON parse error in ${filePath}:`, error.message);
        await keepCorruptCopy(filePath);
      }
      // ENOENT is expected for first-run; other errors get logged
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
        && !(error instanceof SyntaxError)
      ) {
        console.error(`[data-io] Read error for ${filePath}:`, error);
      }
      return defaultValue;
    }
  });
}

/**
 * Atomically write JSON data to a file.
 * Writes to a temp file first, then renames (atomic on POSIX).
 * Invalidates the read cache for this path so subsequent reads see fresh data.
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  const tempPath = filePath + `.tmp.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 0600 from the first byte: these files hold tokens and keys, and the rename below replaces the old file with this one's mode.
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(tempPath, filePath);
  // Invalidate cache so next read gets fresh data (not the stale pre-write snapshot)
  jsonCache.invalidate(filePath);
}

/**
 * Execute `fn` while holding an exclusive per-file lock.
 *
 * Locks are keyed by file path — writes to different files proceed in parallel.
 * Uses a promise-chain pattern (no external dependencies).
 *
 * Example:
 *   const result = await withFileLock(DATA_PATH, async () => {
 *     const data = await readJsonFile(DATA_PATH, defaultData);
 *     // ... mutate data ...
 *     await writeJsonFile(DATA_PATH, data);
 *     return data;
 *   });
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any existing lock on this file to be released
  const existingLock = fileLocks.get(filePath) ?? Promise.resolve();

  let releaseLock: () => void;
  const newLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  fileLocks.set(filePath, newLock);

  await existingLock;

  try {
    // A previous holder may have written through another Next.js bundle. Drop
    // this bundle's cached snapshot only after the shared lock is acquired.
    jsonCache.invalidate(filePath);
    return await fn();
  } finally {
    releaseLock!();
    // Clean up if we're the last holder (prevents unbounded Map growth)
    if (fileLocks.get(filePath) === newLock) {
      fileLocks.delete(filePath);
    }
  }
}
