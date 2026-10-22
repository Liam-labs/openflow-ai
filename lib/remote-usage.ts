/**
 * Token usage and transcript liveness of the sessions that live on the agent host.
 *
 * DevFlow runs on the server while the agents' Claude transcripts are written on the agent host, so lib/token-usage.ts and
 * lib/frozen-detection-jsonl.ts, which read this machine's disk, saw nothing for those agents (21 Oct 2026: every usage figure
 * read 0). The host answers from its own index (scripts/hostd_usage.py), so only totals cross the link, not transcripts.
 * Every call is best-effort: an unreachable host gives "no data", never an error, and a short cache keeps the 1-second
 * polling of the panels from becoming one host call per agent per second.
 */
import { defaultHost, hostCall } from '@/lib/host-executor';

export interface TokenCountsLike { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
export interface RemoteFileUsage {
  path: string;
  size: number;
  mtimeMs: number;
  tokens: TokenCountsLike;
  modelTokens: Record<string, TokenCountsLike>;
  messageCount: number;
  lastActivity: string | null;
}
export interface RemoteWindow { tokens: number; sessionStartMs: number | null }

export type HostCaller = (host: string, op: string, args: Record<string, unknown>, waitMs?: number) => Promise<unknown>;

const CALL_WAIT_MS = 8_000;
const FRESH_MS = 4_000;

const g = globalThis as unknown as { __remoteUsageCache?: Map<string, { at: number; value: unknown }> };
const cache = (g.__remoteUsageCache ??= new Map());

/** Tests only. */
export function resetRemoteUsageCache(): void { cache.clear(); }

/** The machine whose transcripts are not on this one, or null when everything is local. */
export function usageHost(): string | null { return defaultHost(); }

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > 60_000) cache.delete(k);
  return value;
}

async function ask<T>(call: HostCaller, args: Record<string, unknown>, op = 'usage-facts'): Promise<T | null> {
  const host = usageHost();
  if (!host) return null;
  try {
    return (await call(host, op, args, CALL_WAIT_MS)) as T;
  } catch {
    return null;
  }
}

/** Per-file totals of the host's sessions modified since `sinceMs`. Empty when there is no host or it does not answer. */
export async function remoteFilesSince(sinceMs: number, call: HostCaller = hostCall): Promise<RemoteFileUsage[]> {
  return cached(`files:${Math.floor(sinceMs / 60_000)}`, FRESH_MS, async () => {
    const r = await ask<{ files?: RemoteFileUsage[] }>(call, { action: 'files', sinceMs });
    return Array.isArray(r?.files) ? r!.files! : [];
  });
}

/** Tokens in the rolling window and when its first message was sent, summed by the host. Null when there is no host or it does not answer. */
export async function remoteWindow(windowStartMs: number, call: HostCaller = hostCall): Promise<RemoteWindow | null> {
  return cached(`window:${Math.floor(windowStartMs / 60_000)}`, FRESH_MS, async () => {
    const r = await ask<{ tokens?: number; sessionStartMs?: number | null }>(call, { action: 'window', windowStartMs });
    return r && typeof r.tokens === 'number' ? { tokens: r.tokens, sessionStartMs: r.sessionStartMs ?? null } : null;
  });
}

/** Totals of one session file on the host (a path inside its ~/.claude/projects). */
export async function remoteFile(path: string, call: HostCaller = hostCall): Promise<RemoteFileUsage | null> {
  return cached(`file:${path}`, FRESH_MS, async () => {
    const r = await ask<{ file?: RemoteFileUsage | null }>(call, { action: 'file', path });
    return r?.file ?? null;
  });
}

/**
 * Modified time of each agent folder's active transcript on the host (ms), refreshed in the background. The caller is synchronous
 * (the frozen-agent check runs inside message handlers), so this returns what is known now and starts a refresh: the first call for a
 * folder returns undefined and a later one has the answer. Folders asked about in the same tick share one host call.
 */
const mtimes = new Map<string, { ms: number | null; at: number }>();
const wantedDirs = new Map<string, string | undefined>();
let refreshing = false;
let scheduled = false;
const MTIME_FRESH_MS = 10_000;

function flushMtimes(call: HostCaller): void {
  scheduled = false;
  if (refreshing || wantedDirs.size === 0) return;
  refreshing = true;
  const dirs = [...wantedDirs].map(([dir, sessionId]) => ({ dir, ...(sessionId ? { sessionId } : {}) }));
  wantedDirs.clear();
  void ask<{ mtimes?: Record<string, number | null> }>(call, { dirs }, 'transcript-mtimes')
    .then((r) => {
      for (const [dir, ms] of Object.entries(r?.mtimes ?? {})) mtimes.set(dir, { ms, at: Date.now() });
    })
    .finally(() => { refreshing = false; });
}

export function remoteTranscriptMtime(dir: string, sessionId?: string, call: HostCaller = hostCall): number | null | undefined {
  if (!usageHost()) return undefined;
  const known = mtimes.get(dir);
  if (!known || Date.now() - known.at > MTIME_FRESH_MS) {
    wantedDirs.set(dir, sessionId);
    if (!scheduled) { scheduled = true; setTimeout(() => flushMtimes(call), 0); }   // one call for every folder asked about in this tick
  }
  return known ? known.ms : undefined;
}

/** Tests only: wait for the refresh in flight, forget everything. */
export async function settleRemoteMtimes(): Promise<void> {
  for (let i = 0; i < 50 && (scheduled || refreshing); i++) await new Promise((r) => setTimeout(r, 5));
}
export function resetRemoteMtimes(): void { mtimes.clear(); wantedDirs.clear(); refreshing = false; scheduled = false; }
