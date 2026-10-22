/**
 * Host-Bridge Client
 *
 * Abstraction layer for system-level operations (PM2, PTY, scripts).
 * When HOST_BRIDGE_URL is set (Docker mode), calls go to the bridge daemon.
 * When unset (local mode), falls back to direct exec for backward compatibility.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  BridgeResponse,
  PM2StatusResponse,
  PM2ExecRequest,
  PM2ExecResponse,
  PM2LogsResponse,
  ScriptRunRequest,
  ScriptRunResponse,
  HealthResponse,
} from './types';
import type { PM2Process, PM2Response } from '../types';
import { parsePM2Processes, getPortsInUse, overlayActualPorts } from '../pm2-utils';
import { getActualListeningPorts, getChildPidMap } from '../port-utils';

const execAsync = promisify(exec);
const PM2_JLIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// ============================================
// Bridge Connection
// ============================================

function getBridgeUrl(): string | null {
  return process.env.HOST_BRIDGE_URL || null;
}

function getBridgeToken(): string | null {
  return process.env.HOST_BRIDGE_TOKEN || null;
}

/** Whether the host-bridge is active (Docker/remote mode) */
export function isBridgeMode(): boolean {
  return !!getBridgeUrl();
}

/** Authenticated fetch to the host-bridge daemon */
async function bridgeFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; timeout?: number } = {}
): Promise<BridgeResponse<T>> {
  const url = getBridgeUrl();
  if (!url) throw new Error('HOST_BRIDGE_URL not configured');

  const token = getBridgeToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);

  try {
    const res = await fetch(`${url}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    return await res.json() as BridgeResponse<T>;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================
// PM2 Operations
// ============================================

// In-process cache for pm2Status — avoids repeated pm2 jlist calls within the same
// polling window. The SSE loop (5s) keeps this warm; HTTP requests hit cache instead
// of spawning a new subprocess on every page load.
const PM2_CACHE_TTL_MS = 4000; // slightly under the 5s SSE interval
let pm2StatusCache: { result: { processes: PM2Process[]; portsInUse: Record<number, string> }; ts: number } | null = null;
let pm2RevalidateInFlight = false;
let pm2LastLoggedError = '';

async function revalidatePm2Cache(): Promise<void> {
  if (pm2RevalidateInFlight) return;
  pm2RevalidateInFlight = true;
  try {
    const { stdout } = await execAsync('pm2 jlist', {
      timeout: 10000,
      maxBuffer: PM2_JLIST_MAX_BUFFER_BYTES,
    });
    const rawProcesses = parsePM2Processes(stdout);
    const [actualPorts, childPidMap] = await Promise.all([
      getActualListeningPorts(),
      getChildPidMap(),
    ]);
    const processes = overlayActualPorts(rawProcesses, actualPorts, childPidMap);
    const portsInUse = getPortsInUse(processes);
    pm2StatusCache = { result: { processes, portsInUse }, ts: Date.now() };
  } catch (err) {
    // A fresh install has no PM2 (or its daemon is not running): that is "no services", not an error. Answer with an empty list so the
    // Services and Overview panels render, and do not try again before the cache time is up. An older good answer keeps being served.
    // 22 Oct 2026: /api/pm2 answered 500 here, the panels showed nothing and the browser polled the failing route in a tight loop.
    if (pm2StatusCache) pm2StatusCache.ts = Date.now();
    else pm2StatusCache = { result: { processes: [], portsInUse: {} }, ts: Date.now() };
    const message = err instanceof Error ? err.message : String(err);
    if (message !== pm2LastLoggedError) {                       // once per distinct problem, not every poll
      pm2LastLoggedError = message;
      console.error('[pm2Status] Background revalidation failed:', err);
    }
  } finally {
    pm2RevalidateInFlight = false;
  }
}

/**
 * Get all PM2 processes with port overlay.
 *
 * Bridge mode: GET /pm2/status (bridge does its own parsing)
 * Local mode: exec pm2 jlist + parse + TCP port overlay
 *
 * Stale-while-revalidate: if cached (even stale), return immediately and refresh in background.
 * SSE keeps the UI current anyway — stale data for one cycle is acceptable.
 */
export async function pm2Status(): Promise<{
  processes: PM2Process[];
  portsInUse: Record<number, string>;
}> {
  if (isBridgeMode()) {
    const res = await bridgeFetch<PM2StatusResponse>('/pm2/status', { timeout: 10000 });
    if (!res.success) throw new Error(res.error || 'Bridge pm2 status failed');
    // Bridge PM2ProcessInfo is structurally identical to PM2Process
    const processes = (res.data?.processes || []) as unknown as PM2Process[];
    const portsInUse = res.data?.portsInUse || {};
    return { processes, portsInUse };
  }

  // Stale-while-revalidate: serve cache immediately (even if expired), refresh in background
  if (pm2StatusCache) {
    if (Date.now() - pm2StatusCache.ts >= PM2_CACHE_TTL_MS) {
      revalidatePm2Cache().catch(() => {}); // fire-and-forget
    }
    return pm2StatusCache.result;
  }

  // No cache yet — fetch synchronously to avoid returning empty data
  await revalidatePm2Cache();
  return pm2StatusCache!.result;
}

/**
 * Get raw PM2 process list (without port overlay).
 * Used by callers that do their own port resolution.
 */
export async function pm2List(): Promise<PM2Process[]> {
  if (isBridgeMode()) {
    const res = await bridgeFetch<PM2StatusResponse>('/pm2/status', { timeout: 10000 });
    if (!res.success) throw new Error(res.error || 'Bridge pm2 list failed');
    return (res.data?.processes || []) as unknown as PM2Process[];
  }

  const { stdout } = await execAsync('pm2 jlist', {
    timeout: 10000,
    maxBuffer: PM2_JLIST_MAX_BUFFER_BYTES,
  });
  return parsePM2Processes(stdout);
}

/**
 * Execute a PM2 action (start/stop/restart).
 *
 * Bridge mode: POST /pm2/exec
 * Local mode: exec('pm2 {action} {target}')
 */
export async function pm2Exec(
  action: 'start' | 'stop' | 'restart' | 'delete',
  target: string,
  options?: { port?: number; timeout?: number }
): Promise<{ output: string; stderr: string }> {
  if (isBridgeMode()) {
    const body: PM2ExecRequest = {
      action: action as 'start' | 'stop' | 'restart',
      target,
      port: options?.port,
    };
    const res = await bridgeFetch<PM2ExecResponse>('/pm2/exec', {
      method: 'POST',
      body,
      timeout: options?.timeout || 30000,
    });
    if (!res.success) throw new Error(res.error || `Bridge pm2 ${action} failed`);
    return { output: res.data?.output || '', stderr: '' };
  }

  const command = `pm2 ${action} ${target}`;
  const { stdout, stderr } = await execAsync(command, { timeout: options?.timeout || 30000 });
  return { output: stdout, stderr };
}

/**
 * Get PM2 logs for a process.
 *
 * Bridge mode: GET /pm2/logs?name={name}&lines={lines}
 * Local mode: exec('pm2 logs {name} --nostream --lines {lines}')
 */
export async function pm2Logs(
  name: string,
  lines = 50,
  timeout = 15000
): Promise<{ lines: string[]; count: number }> {
  if (isBridgeMode()) {
    const res = await bridgeFetch<PM2LogsResponse>(
      `/pm2/logs?name=${encodeURIComponent(name)}&lines=${lines}`,
      { timeout }
    );
    if (!res.success) throw new Error(res.error || 'Bridge pm2 logs failed');
    return {
      lines: res.data?.lines || [],
      count: res.data?.count || 0,
    };
  }

  const command = `pm2 logs ${name} --nostream --lines ${lines}`;
  const { stdout, stderr } = await execAsync(command, { timeout });
  const allOutput = (stdout + '\n' + stderr).trim();
  const logLines = allOutput.split('\n').filter(line => line.trim().length > 0);
  return { lines: logLines, count: logLines.length };
}

// ============================================
// Script Execution
// ============================================

/**
 * Run an allowlisted script from scripts/.
 *
 * Bridge mode: POST /script/run
 * Local mode: exec the script directly
 */
export async function scriptRun(
  script: string,
  args: string[] = [],
  options?: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (isBridgeMode()) {
    const body: ScriptRunRequest = {
      script,
      args,
      cwd: options?.cwd,
      timeout: options?.timeout,
    };
    const res = await bridgeFetch<ScriptRunResponse>('/script/run', {
      method: 'POST',
      body,
      timeout: options?.timeout || 60000,
    });
    if (!res.success) throw new Error(res.error || `Bridge script run failed: ${script}`);
    return {
      stdout: res.data?.stdout || '',
      stderr: res.data?.stderr || '',
      exitCode: res.data?.exitCode || 0,
    };
  }

  const devflowHome = process.env.DEVFLOW_HOME || `${process.env.HOME}/DevFlow`;
  const scriptPath = `${devflowHome}/scripts/${script}`;
  const argsStr = args.length > 0 ? ' ' + args.join(' ') : '';
  const { stdout, stderr } = await execAsync(
    `"${scriptPath}"${argsStr}`,
    { timeout: options?.timeout || 60000, cwd: options?.cwd || devflowHome }
  );
  return { stdout, stderr, exitCode: 0 };
}

// ============================================
// tmux Primitives (for collab-pty)
// ============================================

/**
 * Check if a tmux session exists.
 * Local mode only — in Docker mode, use bridge PTY endpoints.
 */
export async function tmuxHasSession(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t ${sessionName} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a raw tmux command.
 * Local mode only — callers must check isBridgeMode() for Docker compatibility.
 */
export async function tmuxExec(
  command: string,
  timeout = 10000
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execAsync(command, { timeout });
  return { stdout, stderr };
}

// ============================================
// Health
// ============================================

/** Check bridge daemon health. Returns null if not in bridge mode. */
export async function bridgeHealth(): Promise<HealthResponse | null> {
  const url = getBridgeUrl();
  if (!url) return null;

  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    return await res.json() as HealthResponse;
  } catch {
    return null;
  }
}
