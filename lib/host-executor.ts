/**
 * Routes tmux/process control to the machine an agent runs on. Agents on the DevFlow machine use local tmux;
 * agents on another machine go through that machine's agent-hostd (which dials out to us).
 * Host choice: the agent's own host (roster) first, then DEVFLOW_AGENT_HOST, else local.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { enqueue, getHostInfo, hostIds } from './host-registry';

const execFileAsync = promisify(execFile);
const g = globalThis as unknown as { __sessionHost?: Map<string, string> };
const sessionHost = (g.__sessionHost ??= new Map<string, string>());

/** Recorded for a session that runs on this machine, as opposed to one on an agent host. */
const THIS_MACHINE = '@this-machine';

export interface HostAgentRef { runLocation?: string; host?: string }

export function defaultHost(): string | null { return process.env.DEVFLOW_AGENT_HOST?.trim() || null; }

/** Host id an agent should run on, or null for this machine. */
export function hostFor(agent?: HostAgentRef | null): string | null {
  if (agent?.runLocation === 'server') return null;
  return agent?.host?.trim() || defaultHost();
}

/**
 * Host id that holds an agent's FILES (its working folder, scaffolding, project document), or null for this machine.
 * The same as hostFor() for every agent except one that runs on this machine (runLocation 'server') while its folders stay on the agent
 * machine: its process is here, its files are there.
 */
export function filesHostFor(agent?: HostAgentRef | null): string | null {
  return agent?.host?.trim() || defaultHost();
}

export function rememberSessionHost(session: string, host: string | null) {
  if (host) sessionHost.set(session, host); else sessionHost.delete(session);
}

/** Record that a session runs on this machine, so its tmux commands are never sent to the agent host. */
export function rememberLocalSession(session: string) {
  sessionHost.set(session, THIS_MACHINE);
  localSessionCache.at = 0;
}

export function sessionName(target: string): string {
  return target.replace(/^=/, '').split(/[:.]/)[0];
}

/** This machine's own tmux sessions, listed at most every 2 seconds. Empty when tmux is not running. */
const localSessionCache: { at: number; names: Set<string> } = { at: 0, names: new Set() };
export function localTmuxSessions(now = Date.now(), list: () => string = listLocalTmux): Set<string> {
  if (now - localSessionCache.at < 2000) return localSessionCache.names;
  let names = new Set<string>();
  try { names = new Set(list().split('\n').map(s => s.trim()).filter(Boolean)); } catch { /* no tmux server running */ }
  localSessionCache.at = now;
  localSessionCache.names = names;
  return names;
}
function listLocalTmux(): string {
  return execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Host that owns a tmux session: spawn record, then any host reporting it, then this machine if its own tmux has it
 * (an agent run here after a DevFlow restart), then the default host.
 */
export function hostForSession(session: string): string | null {
  const known = sessionHost.get(session);
  if (known === THIS_MACHINE) return null;
  if (known) return known;
  for (const id of hostIds()) if (getHostInfo(id)?.sessions.includes(session)) return id;
  if (defaultHost() && localTmuxSessions().has(session)) return null;
  return defaultHost();
}

export async function hostCall<T = unknown>(host: string, op: string, args: Record<string, unknown>, waitMs = 30_000): Promise<T> {
  const r = await enqueue(host, op, args, waitMs);
  if ('queued' in r) throw Object.assign(new Error(`host ${host} did not answer ${op} in time`), { code: 'EHOSTTIMEOUT' });
  if (!r.ok) throw Object.assign(new Error(r.error || `host ${host} ${op} failed`), { code: 'EHOSTOP' });
  return r.result as T;
}

export type HostState = 'online' | 'offline' | 'local';

/** Whether the agent's host is reachable right now (its poll is recent). */
export function hostState(host: string | null): HostState {
  if (!host) return 'local';
  return getHostInfo(host)?.fresh ? 'online' : 'offline';
}

/**
 * Session existence from the host's own session list.
 * 'unknown' while the host link is down, so a dropped link never reads as every agent having crashed.
 */
export function remoteSessionExists(host: string, session: string): boolean | 'unknown' {
  const info = getHostInfo(host);
  if (!info || !info.fresh) return 'unknown';
  return info.sessions.includes(session);
}

export function hostMemFreeMB(host: string): number | null {
  const v = getHostInfo(host)?.memMB.MemAvailable;
  return typeof v === 'number' ? v : null;
}

/** Drop-in for execFileAsync('tmux', args): runs on the host that owns the target session. */
export async function tmuxRun(args: string[], opts: { timeout?: number; maxBuffer?: number; encoding?: BufferEncoding } = {}): Promise<{ stdout: string; stderr: string }> {
  const ti = args.indexOf('-t');
  const host = ti >= 0 && args[ti + 1] ? hostForSession(sessionName(args[ti + 1])) : defaultHost();
  if (!host) return execFileAsync('tmux', args, opts) as Promise<{ stdout: string; stderr: string }>;
  const res = await hostCall<{ rc: number; stdout: string; stderr: string }>(host, 'tmux', { args }, opts.timeout ?? 30_000);
  if (res.rc !== 0) throw Object.assign(new Error(res.stderr || `tmux ${args[0]} failed`), { code: res.rc, stdout: res.stdout, stderr: res.stderr });
  return { stdout: res.stdout, stderr: res.stderr };
}

/** Paste text into a remote session's input (load-buffer + paste-buffer + Enter). */
export async function pasteRun(session: string, text: string, enter = true): Promise<void> {
  const host = hostForSession(session);
  if (!host) {
    const buf = `devflow-${session}`;
    await new Promise<void>((resolve, reject) => {
      const p = execFile('tmux', ['load-buffer', '-b', buf, '-'], err => err ? reject(err) : resolve());
      p.stdin?.end(text);
    });
    await execFileAsync('tmux', ['paste-buffer', '-b', buf, '-d', '-t', session]);
    if (enter) await execFileAsync('tmux', ['send-keys', '-t', session, 'Enter']);
    return;
  }
  await hostCall(host, 'paste', { session, text, enter });
}
