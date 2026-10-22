/** In-memory queue between DevFlow and agent-hostd (which dials out). Commands are ephemeral by design. */
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { DataPaths } from './data-paths';

export interface HostCommand { id: string; op: string; args: Record<string, unknown> }
export interface HostResult { id: string; ok: boolean; result?: unknown; error?: string }
interface Host {
  id: string; lastSeen: number; version?: number; status?: unknown;
  queue: HostCommand[]; waiters: Array<() => void>;
  results: Map<string, { r?: HostResult; resolve?: (r: HostResult) => void }>;
}

const g = globalThis as unknown as { __hosts?: Map<string, Host> };
const hosts = (g.__hosts ??= new Map<string, Host>());
export const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function host(id: string): Host {
  let h = hosts.get(id);
  if (!h) { h = { id, lastSeen: 0, queue: [], waiters: [], results: new Map() }; hosts.set(id, h); }
  return h;
}

export function listHosts() {
  return [...hosts.values()].map(h => ({
    id: h.id, lastSeen: h.lastSeen, online: Date.now() - h.lastSeen < 60_000,
    version: h.version, status: h.status, queued: h.queue.length,
  }));
}

export async function pollHost(id: string, status: unknown, version: number | undefined, waitSec: number) {
  const h = host(id);
  h.lastSeen = Date.now(); h.status = status; h.version = version;
  if (!h.queue.length && waitSec > 0) {
    await new Promise<void>(res => {
      const t = setTimeout(() => { h.waiters = h.waiters.filter(w => w !== done); res(); }, Math.min(waitSec, 30) * 1000);
      const done = () => { clearTimeout(t); res(); };
      h.waiters.push(done);
    });
  }
  h.lastSeen = Date.now();
  return h.queue.splice(0, h.queue.length);
}

export function enqueue(id: string, op: string, args: Record<string, unknown>, waitMs: number): Promise<HostResult | { id: string; queued: true }> {
  const h = host(id);
  const cmd: HostCommand = { id: randomUUID(), op, args };
  const slot: { r?: HostResult; resolve?: (r: HostResult) => void } = {};
  h.results.set(cmd.id, slot);
  setTimeout(() => h.results.delete(cmd.id), 10 * 60_000).unref?.();
  h.queue.push(cmd);
  h.waiters.splice(0).forEach(w => w());
  if (waitMs <= 0) return Promise.resolve({ id: cmd.id, queued: true as const });
  return new Promise(res => {
    const t = setTimeout(() => res({ id: cmd.id, queued: true as const }), waitMs);
    slot.resolve = r => { clearTimeout(t); res(r); };
  });
}

export function recordResult(id: string, r: HostResult) {
  const slot = host(id).results.get(r.id);
  if (!slot) return false;
  slot.r = r; slot.resolve?.(r);
  return true;
}

/** Each host id is bound to its own secret; only the SHA-256 is stored in .AppData/host-tokens.json. */
export function verifyHostToken(id: string, presented: string | null): boolean {
  if (!presented) return false;
  try {
    const map = JSON.parse(readFileSync(`${DataPaths.base}/host-tokens.json`, 'utf8')) as Record<string, string>;
    const want = map[id];
    if (!want) return false;
    const got = createHash('sha256').update(presented).digest('hex');
    return want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
  } catch { return false; }
}

export function getHostInfo(id: string) {
  const h = hosts.get(id);
  if (!h) return null;
  const st = (h.status ?? {}) as { sessions?: string[]; memMB?: { MemTotal?: number; MemAvailable?: number } };
  return { id, lastSeen: h.lastSeen, fresh: Date.now() - h.lastSeen < 45_000, sessions: st.sessions ?? [], memMB: st.memMB ?? {} };
}

export function hostIds(): string[] { return [...hosts.keys()]; }
