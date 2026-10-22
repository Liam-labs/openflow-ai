/**
 * Where the Live Feed reads an agent's transcript files from.
 *
 * DevFlow runs on the server, but agents run on the agent host (the desktop) and write their transcripts there. So the stream code
 * reads through a StreamFs: the local one is plain node fs (agents that run on this machine); the remote one asks that machine's
 * agent-hostd through its `stream-fs` op (scripts/agent-hostd.py), which only serves transcript data. The resolvers and the tail
 * reader are written once against this interface, so the two cases cannot drift apart.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getHomeDir } from '@/lib/home-dir';
import { hostCall } from '@/lib/host-executor';

export interface StreamStat { size: number; mtimeMs: number; isFile: boolean; isDir: boolean }
export interface StreamDirEntry extends StreamStat { name: string }
export interface StreamFileInfo { path: string; size: number; mtimeMs: number }
export interface FindFilesFilter { prefix?: string; suffix?: string; name?: string; maxDepth: number }
export interface RangeRead { data: Buffer; size: number; offset: number }

export interface StreamFs {
  /** True when the files are on another machine. */
  readonly remote: boolean;
  home(): Promise<string>;
  /** The first `maxBytes` of a small file as text; null when it is missing or not readable. */
  readText(path: string, maxBytes?: number): Promise<string | null>;
  stat(path: string): Promise<StreamStat | null>;
  readdir(path: string): Promise<StreamDirEntry[] | null>;
  findFiles(root: string, filter: FindFilesFilter): Promise<StreamFileInfo[]>;
  /** Up to `length` bytes from `offset`; `size` is the file's current size. */
  readRange(path: string, offset: number, length: number): Promise<RangeRead | null>;
  /** The last up-to `maxBytes` bytes; `offset` is where they start in the file. */
  readTail(path: string, maxBytes: number): Promise<RangeRead | null>;
}

/** The agent host did not answer: the caller should say so instead of reporting "no session". */
export class StreamHostOfflineError extends Error {
  readonly code = 'HOST_OFFLINE' as const;
  constructor(host: string) { super(`The agent host ${host} is not answering`); }
}

export const MAX_RANGE_BYTES = 1 << 20;

// ── Local ────────────────────────────────────────────────────────────────────

async function collectLocal(root: string, filter: FindFilesFilter): Promise<StreamFileInfo[]> {
  const out: StreamFileInfo[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > filter.maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await visit(path, depth + 1); return; }
      if (!entry.isFile()) return;
      if (filter.name && entry.name !== filter.name) return;
      if (filter.prefix && !entry.name.startsWith(filter.prefix)) return;
      if (filter.suffix && !entry.name.endsWith(filter.suffix)) return;
      try {
        const st = await fs.stat(path);
        out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* a session may rotate between listing and stat */ }
    }));
  }
  await visit(root, 0);
  return out;
}

export function localStreamFs(homeDir?: string): StreamFs {
  return {
    remote: false,
    async home() { return homeDir ?? getHomeDir(); },
    async readText(path, maxBytes = 64 * 1024) {
      let handle;
      try {
        handle = await fs.open(path, 'r');
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
        return buf.subarray(0, bytesRead).toString('utf-8');
      } catch { return null; } finally { await handle?.close().catch(() => {}); }
    },
    async stat(path) {
      try {
        const st = await fs.stat(path);
        return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDir: st.isDirectory() };
      } catch { return null; }
    },
    async readdir(path) {
      let names: string[];
      try { names = await fs.readdir(path); } catch { return null; }
      const entries = await Promise.all(names.map(async (name) => {
        try {
          const st = await fs.stat(join(path, name));
          return { name, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDir: st.isDirectory() };
        } catch { return null; }
      }));
      return entries.filter((e): e is StreamDirEntry => e !== null);
    },
    findFiles: collectLocal,
    async readRange(path, offset, length) {
      let handle;
      try {
        handle = await fs.open(path, 'r');
        const size = (await handle.stat()).size;
        const want = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buf, 0, want, offset);
        return { data: buf.subarray(0, bytesRead), size, offset };
      } catch { return null; } finally { await handle?.close().catch(() => {}); }
    },
    async readTail(path, maxBytes) {
      const st = await this.stat(path);
      if (!st || !st.isFile) return null;
      return this.readRange(path, Math.max(0, st.size - maxBytes), maxBytes);
    },
  };
}

// ── Remote (through the agent host's stream-fs op) ───────────────────────────

type HostCaller = (host: string, op: string, args: Record<string, unknown>, waitMs?: number) => Promise<unknown>;
const CALL_WAIT_MS = 8_000;

/**
 * An expected refusal or a missing file is "no answer" (null); an unreachable host throws StreamHostOfflineError.
 */
export function remoteStreamFs(host: string, call: HostCaller = hostCall): StreamFs {
  let homeCache: string | null = null;
  async function ask<T>(args: Record<string, unknown>): Promise<T | null> {
    try {
      return (await call(host, 'stream-fs', args, CALL_WAIT_MS)) as T;
    } catch (error) {
      if ((error as { code?: string })?.code === 'EHOSTTIMEOUT') throw new StreamHostOfflineError(host);
      return null;                                   // EHOSTOP: the host refused the path or the file is gone
    }
  }
  const decode = (r: { exists?: boolean; data?: string; size?: number; offset?: number } | null): RangeRead | null =>
    r && r.exists !== false && typeof r.data === 'string' ? { data: Buffer.from(r.data, 'base64'), size: r.size ?? 0, offset: r.offset ?? 0 } : null;
  return {
    remote: true,
    async home() {
      if (homeCache) return homeCache;
      const r = await ask<{ home?: string }>({ action: 'home' });
      if (!r?.home) throw new StreamHostOfflineError(host);
      return (homeCache = r.home);
    },
    async readText(path, maxBytes = 64 * 1024) {
      const r = await ask<{ exists?: boolean; text?: string }>({ action: 'text', path, max: maxBytes });
      return r && r.exists !== false && typeof r.text === 'string' ? r.text : null;
    },
    async stat(path) {
      const r = await ask<{ exists?: boolean; size?: number; mtimeMs?: number; isFile?: boolean; isDir?: boolean }>({ action: 'stat', path });
      return r && r.exists ? { size: r.size ?? 0, mtimeMs: r.mtimeMs ?? 0, isFile: !!r.isFile, isDir: !!r.isDir } : null;
    },
    async readdir(path) {
      const r = await ask<{ exists?: boolean; entries?: StreamDirEntry[] }>({ action: 'list', path });
      return r && r.exists !== false && Array.isArray(r.entries) ? r.entries : null;
    },
    async findFiles(root, filter) {
      const r = await ask<{ files?: StreamFileInfo[] }>({ action: 'files', root, ...filter });
      return Array.isArray(r?.files) ? r!.files! : [];
    },
    async readRange(path, offset, length) {
      return decode(await ask({ action: 'read', path, offset, length: Math.min(length, MAX_RANGE_BYTES) }));
    },
    async readTail(path, maxBytes) {
      return decode(await ask({ action: 'tail', path, max: Math.min(maxBytes, MAX_RANGE_BYTES) }));
    },
  };
}
