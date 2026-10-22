/**
 * Collab PTY Session Manager (tmux-based)
 *
 * Manages Claude sessions using tmux for persistent pseudo-terminal support.
 * tmux provides a real TTY that Claude CLI recognizes as interactive.
 *
 * Flow:
 * 1. spawnCollabPtySession() - Creates Claude session in a tmux session
 * 2. sendToPty() - Uses `tmux send-keys` to send message to session
 * 3. Output can be captured via `tmux capture-pane`
 * 4. closePtySession() - Kills the tmux session
 *
 * Roster-aware features:
 * - forceKillPtySession() - Hard kills a session and cleans up temp files
 * - captureClaudeSessionId() - Captures session ID for resume support
 * - Crash detection polling - Detects dead tmux sessions for roster agents
 */

import { exec, execFile, spawn, ChildProcess } from 'child_process';
import { buildDeepSeekShellEnv, buildDeepSeekProcessEnv } from '@/lib/deepseek-env';
import { scrubClaudeSpawnEnv, claudeSpawnUnsetPrefix } from '@/lib/claude-spawn-env';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import type { CollabPtySession, PtySessionStatus, CollabParticipant, AgentRosterEntry, CollabChannelsData } from './types';
import { isWindowsPerMessageAgent } from './roster-spawn-mode';
import { generateAgentName, generateAgentColor } from './collab-utils';
import { DataPaths } from './data-paths';
import { readJsonFile, writeJsonFile } from './data-io';
import { commitMonitorChanges } from './collab-roster-merge';
import { mutateChannels, saveChannels } from './collab-channel-store';
import { emitAgentError } from './event-bus';
import { logEvent } from './log-writer';
import { isAgentAlive } from './agent-liveness';
import { availableMemoryMB, isPidAlive as procIsPidAlive, readProcCmdline as procCmdline, readProcChildren as procChildren } from './proc-info';
import { postStabilityAlert } from './stability-alerts';
import { getDevFlowApiToken } from './api-auth';
import { readChannelMessages } from './collab-message-io';
import os from 'os';
import path from 'path';
import { resolveApiIdForModel } from './model-registry';

const execAsync = promisify(exec);

const AGENT_NICE = 10;
const AGENT_PRIORITY_PREFIX = `renice ${AGENT_NICE} -p $$ >/dev/null 2>&1;`;
const execFileAsync = promisify(execFile);
import { tmuxRun, hostForSession, remoteSessionExists, hostFor, rememberSessionHost, rememberLocalSession, localTmuxSessions, hostMemFreeMB, defaultHost } from '@/lib/host-executor';
import { prepareLaptopLaunch } from '@/lib/laptop-view';
import { claudeWrapperSpec, parseLaunchCommand, pushFile, spawnOnHost } from '@/lib/remote-spawn';
import { CLAUDE_EXE_WSL } from './windows-spawn-availability';
import { getDevflowHome, getHomeDir } from '@/lib/home-dir';
import { selfOrigin } from '@/lib/self-origin';
const DATA_PATH = DataPaths.collabPtySessions;
const CHANNELS_PATH = DataPaths.collabChannels;

// Prefix for tmux session names to avoid conflicts
const TMUX_SESSION_PREFIX = 'collab-agent-';

// Validate tmux session name to prevent shell injection
const SAFE_TMUX_NAME = /^[a-zA-Z0-9_\-:.]+$/;
function validateTmuxName(name: string): string {
  if (!name || name.length > 256 || !SAFE_TMUX_NAME.test(name)) {
    throw new Error(`Invalid tmux session name: ${name.substring(0, 50)}`);
  }
  return name;
}

// Validate claudeFlags — only allow known safe flag patterns
const SAFE_FLAG = /^--?[a-zA-Z][a-zA-Z0-9\-]*$/;
const SAFE_FLAG_VALUE = /^[a-zA-Z0-9_\-.:\/\[\]@,]+$/;
export function validateClaudeFlags(flags: string[]): string[] {
  for (const flag of flags) {
    if (!SAFE_FLAG.test(flag) && !SAFE_FLAG_VALUE.test(flag)) {
      throw new Error(`Invalid CLI flag: ${flag.substring(0, 50)}`);
    }
  }
  return flags;
}

// Full paths for binaries (PM2 env may not include ~/bin in PATH)
// ~/bin/collab-claude is a link to scripts/collab-claude.py that only our own machines have; a fresh install runs the script itself.
// The claude program is wherever its installer put it (~/.local/bin, or an npm/nvm folder on PATH).
const COLLAB_CLAUDE_BIN = existsSync(`${getHomeDir()}/bin/collab-claude`) ? `${getHomeDir()}/bin/collab-claude` : `${getDevflowHome()}/scripts/collab-claude.py`;
const CLAUDE_BIN = existsSync(`${getHomeDir()}/.local/bin/claude`) ? `${getHomeDir()}/.local/bin/claude` : 'claude';
const COLLAB_GROK_BIN = `${getDevflowHome()}/scripts/collab-grok.py`;
const COLLAB_GROK_ACP_BIN = `${getDevflowHome()}/scripts/collab-grok-acp.py`;
const COLLAB_CODEX_BIN = `${getDevflowHome()}/scripts/collab-codex.py`;
const COLLAB_ANTIGRAVITY_BIN = `${getDevflowHome()}/scripts/collab-antigravity.py`;

// Windows-side Claude binary (WSL path to Windows executable)
const TASKKILL_EXE = '/mnt/c/WINDOWS/system32/taskkill.exe';

// Crash detection interval (30 seconds)
const CRASH_DETECT_INTERVAL_MS = 30_000;

// Starting status timeout (30 seconds) - if still starting, mark crashed
const STARTING_TIMEOUT_MS = 30_000;

// Staggered respawn: delay between auto-respawn requests (prevents thundering herd)
const RESPAWN_STAGGER_MS = 5_000;

// A shutdown/restart still unfinished this long after it began has been abandoned.
const STALE_TRANSITION_MS = 3 * 60_000;

// Minimum memory (MB) required to allow auto-respawn (matches spawn gate in route.ts)
const RESPAWN_MIN_MEMORY_MB = 2048;

// Respawn queue: when multiple agents die simultaneously (e.g. tmux crash),
// respawns are queued and processed one at a time with RESPAWN_STAGGER_MS delay.
// crashedSession lets the drain skip an agent that was already brought back by
// another route; a duplicate respawn would kill that healthy new session.
type RespawnItem = { channelId: string; agentId: string; agentName: string; shutdownAt: string; crashedSession?: string };
// The server bundles this module into more than one chunk. Module-level state
// would give each copy its own monitor and queue: two copies detected the same
// crash and wrote the same crash report concurrently (2026-10-04). Keep the
// monitor, queue and drain flag process-wide so only one ever runs.
const crashMonitor = ((globalThis as typeof globalThis & {
  __devflowCrashMonitor?: { interval: ReturnType<typeof setInterval> | null; respawnQueue: RespawnItem[]; drainRunning: boolean };
}).__devflowCrashMonitor ??= { interval: null, respawnQueue: [], drainRunning: false });
const respawnQueue = crashMonitor.respawnQueue;

// Crash correlation: sliding window for mass-crash detection
const recentCrashes: Array<{ agentName: string; channelId: string; timestamp: number }> = [];
const CRASH_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
const MASS_CRASH_THRESHOLD = 3;
let lastMassIncidentTime = 0;

async function getAvailableMemoryMB(): Promise<number | null> {
  return availableMemoryMB();
}

/**
 * True when the queued agent already runs in a session other than the one that
 * crashed (manual respawn, or an earlier queue item). Duplicate detections while
 * a host was going down queued one agent six times on 2026-10-04, and each item
 * killed the healthy session the previous item had just started.
 */
async function agentAlreadyReplaced(item: { channelId: string; agentId: string; crashedSession?: string }): Promise<boolean> {
  if (!item.crashedSession) return false;
  try {
    const data = await readJsonFile<CollabChannelsData>(CHANNELS_PATH, { channels: [], lastUpdated: '' });
    const agent = data.channels.find(c => c.id === item.channelId)?.roster?.agents.find(a => a.id === item.agentId);
    if (!agent?.tmuxSessionName || agent.tmuxSessionName === item.crashedSession) return false;
    if (!['running', 'starting', 'away'].includes(agent.status)) return false;
    return await tmuxSessionExists(agent.tmuxSessionName);
  } catch {
    return false;
  }
}

function enqueueRespawn(item: RespawnItem): boolean {
  if (respawnQueue.some(q => q.channelId === item.channelId && q.agentId === item.agentId)) return false;
  respawnQueue.push(item);
  return true;
}

async function drainRespawnQueue(): Promise<void> {
  if (crashMonitor.drainRunning) return; // Already draining
  crashMonitor.drainRunning = true;
  try {
    while (respawnQueue.length > 0) {
      // Memory gate: if system is low on memory, abort the entire queue.
      // This breaks the kill→respawn→kill death spiral.
      const availMB = await getAvailableMemoryMB();
      if (availMB !== null && availMB < RESPAWN_MIN_MEMORY_MB) {
        const dropped = respawnQueue.length;
        const names = respawnQueue.map(q => q.agentName).join(', ');
        respawnQueue.length = 0;
        logEvent('agent', 'critical', `Respawn queue cleared: ${dropped} agents dropped (low memory: ${availMB}MB)`, {
          event: 'respawn-blocked',
          droppedAgents: names,
          availableMemoryMB: availMB,
          threshold: RESPAWN_MIN_MEMORY_MB,
        }).catch(() => {});
        break;
      }

      const item = respawnQueue.shift()!;
      if (await agentAlreadyReplaced(item)) {
        logEvent('agent', 'info', `${item.agentName} auto-respawn skipped: already running in a newer session`, {
          event: 'respawn-skipped', agentName: item.agentName, channelId: item.channelId, crashedSession: item.crashedSession,
        }).catch(() => {});
        continue;
      }
      try {
        const res = await fetch(`${selfOrigin()}/api/collab/pty`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getDevFlowApiToken()}`,
          },
          body: JSON.stringify({ action: 'roster_respawn', channelId: item.channelId, agentId: item.agentId }),
        });
        // A respawned agent starts idle — tell it to resume the interrupted work.
        if (res.ok) {
          // Lazy import: agent-restart-notice → collab-delivery → collab-pty is a cycle.
          const { sendRestartResumeNotice } = await import('./agent-restart-notice');
          await sendRestartResumeNotice({
            channelId: item.channelId,
            agentId: item.agentId,
            shutdownAt: item.shutdownAt,
          }).catch(err => {
            console.error(`[PTY] Resume notice failed for "${item.agentName}":`, err instanceof Error ? err.message : err);
          });
        }
      } catch (err) {
        console.error(`[PTY] Staggered respawn failed for "${item.agentName}":`, err instanceof Error ? err.message : err);
      }
      if (respawnQueue.length > 0) {
        await new Promise(r => setTimeout(r, RESPAWN_STAGGER_MS));
      }
    }
  } finally {
    crashMonitor.drainRunning = false;
  }
}

/**
 * Record a crash for mass-crash correlation. Prunes entries outside the 5-minute window,
 * then emits a 'mass-crash' incident event if the threshold is crossed.
 */
function recordCrashForCorrelation(agentName: string, channelId: string): void {
  const now = Date.now();
  recentCrashes.push({ agentName, channelId, timestamp: now });

  // Prune entries outside the window
  const cutoff = now - CRASH_WINDOW_MS;
  while (recentCrashes.length > 0 && recentCrashes[0].timestamp < cutoff) {
    recentCrashes.shift();
  }

  const count = recentCrashes.length;
  if (count >= MASS_CRASH_THRESHOLD && (now - lastMassIncidentTime) > CRASH_WINDOW_MS) {
    lastMassIncidentTime = now;
    const names = [...new Set(recentCrashes.map(c => c.agentName))];
    const incidentId = randomUUID();
    logEvent('crash', 'critical', `Mass crash: ${count} agents in 5min`, {
      event: 'mass-crash',
      incidentId,
      agentsCrashed: names,
      windowMinutes: 5,
      triggerCount: count,
    }).catch(() => {});
    postStabilityAlert(
      `Mass crash: ${count} agents in 5 minutes`,
      'critical',
      `Agents: ${names.join(', ')}\nIncident ID: ${incidentId}`,
    ).catch(() => {});
  }
}

// Crash log directory for pipe-pane output and crash reports
const CRASH_LOG_DIR = DataPaths.crashLogs;

/**
 * Ensure crash log directory exists
 */
async function ensureCrashLogDir(): Promise<void> {
  await fs.mkdir(CRASH_LOG_DIR, { recursive: true });
}

/**
 * Get the pipe-pane log path for a tmux session
 */
function getPipeLogPath(tmuxSessionName: string): string {
  return `${CRASH_LOG_DIR}/${tmuxSessionName}.log`;
}

/**
 * Write a structured crash report when an agent dies
 */
async function writeCrashReport(agent: AgentRosterEntry, channelId: string, channelName: string): Promise<string> {
  await ensureCrashLogDir();
  const pipeLogPath = agent.tmuxSessionName ? getPipeLogPath(agent.tmuxSessionName) : null;
  let lastOutput = '';

  if (pipeLogPath) {
    try {
      const raw = await fs.readFile(pipeLogPath, 'utf-8');
      const lines = raw.split('\n');
      // Keep last 200 lines for crash context
      lastOutput = lines.slice(-200).join('\n');
    } catch {
      lastOutput = '(no pipe-pane log found)';
    }
  }

  const report = {
    agentName: agent.name,
    agentId: agent.id,
    channelId,
    channelName,
    tmuxSession: agent.tmuxSessionName || 'unknown',
    crashCount: agent.crashCount || 1,
    detectedAt: new Date().toISOString(),
    lastStartedAt: agent.lastStartedAt || null,
    lastStoppedAt: new Date().toISOString(),
    lastOutput,
  };

  // Sanitize agent name for filesystem safety — strip path separators and dots
  const safeName = agent.name.replace(/[\/\\\.]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  const reportPath = `${CRASH_LOG_DIR}/${safeName}-crash-${Date.now()}.json`;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  // Clean up pipe log after capturing
  if (pipeLogPath) {
    try { await fs.unlink(pipeLogPath); } catch {}
  }

  return reportPath;
}

/**
 * Strip ANSI escape codes from terminal output
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\x1B\[[<>=?!]*[0-9;]*[a-zA-Z@`]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Extract a bounded, credential-safe cause from a wrapper's startup output.
 *
 * A short-lived child can take the tmux server down with it before capture-pane
 * runs. pipe-pane survives that lifecycle, so its log is the authoritative
 * source for errors such as failed preflights and missing executables.
 */
export function extractSpawnFailureDiagnostic(raw: string): string | null {
  const tail = stripAnsi(raw.slice(-64 * 1024))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    );
  const diagnosticLine = /\b(\w*error|failed|failure|fatal|\w*exception|traceback|unavailable|permission denied|not found|no such file|cannot|refused|invalid|missing|required)\b/i;
  const lines = tail
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && diagnosticLine.test(line));
  if (lines.length === 0) return null;
  const summary = lines.slice(-6).join(' ').replace(/\s+/g, ' ').trim();
  if (summary.length <= 800) return summary;
  return `…${summary.slice(-(800 - 1))}`;
}

async function readSpawnFailureDiagnostic(pipeLogPath: string): Promise<string | null> {
  try {
    return extractSpawnFailureDiagnostic(await fs.readFile(pipeLogPath, 'utf-8'));
  } catch {
    return null;
  }
}

// Type for active session data
export interface ActiveSessionData {
  session: CollabPtySession;
  tmuxSessionName: string;
  emitter: EventEmitter;
  pollInterval?: ReturnType<typeof setInterval>;
  lastOutput: string;
  rosterAgentId?: string;     // Links to roster entry for crash detection
  // PowerShell (per-message) session fields
  backend: 'tmux' | 'windows-pm'; // tmux = WSL, windows-pm = per-message claude.exe
  windowsSessionId?: string;        // Claude session ID for --resume (from JSON output)
  windowsWorkDir?: string;           // Windows-side working directory
  activeChild?: ChildProcess;        // Currently-running claude.exe process (only during message processing)
  consecutiveFailures?: number;      // Track consecutive message failures for crash detection
}

// In-memory store of active sessions
export const activeSessions = new Map<string, ActiveSessionData>();

// Crash detection interval handle

// Background session prune interval handle (60s)
let sessionPruneInterval: ReturnType<typeof setInterval> | null = null;

interface PtySessionsData {
  sessions: CollabPtySession[];
  lastUpdated: string;
}

const DEFAULT_PTY_SESSIONS_DATA: PtySessionsData = {
  sessions: [],
  lastUpdated: new Date().toISOString(),
};

/**
 * Read PTY sessions data from file
 */
async function readSessionsData(): Promise<PtySessionsData> {
  return readJsonFile<PtySessionsData>(DATA_PATH, DEFAULT_PTY_SESSIONS_DATA);
}

/**
 * Write PTY sessions data to file
 */
async function writeSessionsData(data: PtySessionsData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(DATA_PATH, data);
}

/**
 * Update a session in the data file
 */
export async function updateSessionInFile(session: CollabPtySession): Promise<void> {
  const data = await readSessionsData();
  const index = data.sessions.findIndex(s => s.id === session.id);
  if (index >= 0) {
    data.sessions[index] = session;
  } else {
    data.sessions.push(session);
  }
  await writeSessionsData(data);
}

/**
 * Remove a session from the data file
 */
async function removeSessionFromFile(sessionId: string): Promise<void> {
  const data = await readSessionsData();
  data.sessions = data.sessions.filter(s => s.id !== sessionId);
  await writeSessionsData(data);
}

/**
 * Check if a PID is alive (/proc on Linux, kill -0 elsewhere)
 */
async function isPidAlive(pid: number): Promise<boolean> {
  return procIsPidAlive(pid);
}

/**
 * Batch-check which tmux sessions are alive — one `tmux list-sessions` call
 * instead of N `tmux has-session` calls. Cache TTL 10s for crash detection polling.
 */
let tmuxSessionCache: { sessions: Set<string>; timestamp: number } = { sessions: new Set(), timestamp: 0 };
const TMUX_CACHE_TTL_MS = 10_000;

async function refreshTmuxSessionCache(): Promise<Set<string>> {
  const now = Date.now();
  if (now - tmuxSessionCache.timestamp < TMUX_CACHE_TTL_MS) {
    return tmuxSessionCache.sessions;
  }
  const sessions = new Set<string>();
  try {
    const { stdout } = await tmuxRun(['list-sessions', '-F', '#{session_name}']);
    for (const line of stdout.trim().split('\n')) {
      if (line.trim()) sessions.add(line.trim());
    }
  } catch {
    // `tmux list-sessions` failed — could be "server not running" (legitimately
    // empty) or a transient command-socket error. The caller cannot distinguish
    // these from the empty set. Spawn-hot-path verification uses
    // `tmuxHasSessionDirect` to avoid this ambiguity (T2.1).
  }
  tmuxSessionCache = { sessions, timestamp: now };
  return sessions;
}

/**
 * Check if a tmux session exists (uses batch cache)
 */
export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  const sessions = await refreshTmuxSessionCache();
  if (sessions.has(sessionName)) return true;
  // Agents on another machine: use that machine's own session list. While its link is down the answer is
  // "unknown", which counts as alive so a dropped link is never mistaken for every agent crashing.
  const host = hostForSession(sessionName);
  if (!host) {
    // With an agent host set, the list above is that host's sessions, so a session that runs on this machine (an agent on the Remote DevFlow
    // Server) has to be looked for in this machine's own tmux, or it would be reported as crashed the moment it started.
    return defaultHost() ? localTmuxSessions().has(sessionName) : false;
  }
  const remote = remoteSessionExists(host, sessionName);
  return remote === 'unknown' ? true : remote;
}

/**
 * Direct, targeted, non-cached tmux session check using `tmux has-session`.
 * Three-way result so callers can distinguish real absence from transient
 * server-side failures (see T2.1 investigation).
 *
 * - 'present': exit 0 → session exists
 * - 'absent':  exit 1 with stderr "can't find session" → session does not exist
 * - 'server-error': any other failure (tmux server flap, socket error, exit ≥ 2) → caller should retry
 *
 * Used by the spawn hot path where the generic list-sessions cache was
 * producing false-positive "failed to start" errors under burst concurrency.
 */
export type TmuxHasSessionResult = 'present' | 'absent' | 'server-error';
export async function tmuxHasSessionDirect(sessionName: string): Promise<TmuxHasSessionResult> {
  try {
    validateTmuxName(sessionName);
  } catch {
    return 'absent';
  }
  try {
    await tmuxRun(['has-session', '-t', sessionName]);
    return 'present';
  } catch (err: unknown) {
    const e = err as { code?: number; stderr?: string; message?: string };
    const stderr = (e.stderr || e.message || '').toString();
    if (e.code === 1 && /can't find session|no such session|session not found/i.test(stderr)) {
      return 'absent';
    }
    return 'server-error';
  }
}

/**
 * Verify a freshly-spawned tmux session is alive. Retries once on transient
 * server-error conditions before giving up. This is the spawn hot-path variant
 * of tmuxSessionExists that avoids the cache (and its silent empty-set fallback
 * on tmux command failures).
 */
export async function verifySpawnedSession(sessionName: string): Promise<boolean> {
  const first = await tmuxHasSessionDirect(sessionName);
  if (first === 'present') return true;
  if (first === 'absent') return false;
  // server-error — retry once after a short delay
  await new Promise(r => setTimeout(r, 500));
  const second = await tmuxHasSessionDirect(sessionName);
  if (second === 'present') return true;
  if (second === 'absent') return false;
  // Both attempts hit a tmux server error — can't confirm, treat as failure
  // (matches prior pessimistic behavior but via an explicit path, not the
  // silent empty-set fallback in refreshTmuxSessionCache).
  console.error(`[PTY] verifySpawnedSession: tmux server error twice for ${sessionName}, giving up`);
  return false;
}

/**
 * Build a map of running tmux sessions → agent info (name, channel, pid).
 * Extracts agent metadata from the collab-claude wrapper process args.
 * Cached for 15s to avoid repeated ps lookups.
 */
type TmuxAgentInfo = { name: string; channelId: string; pid: number; tmuxSession: string };
let tmuxAgentMapCache: { map: Map<string, TmuxAgentInfo>; timestamp: number } = { map: new Map(), timestamp: 0 };
const TMUX_AGENT_MAP_TTL_MS = 15_000;

async function readProcCmdline(pid: string): Promise<string> {
  return procCmdline(pid);
}

async function readProcChildren(pid: string): Promise<string[]> {
  return procChildren(pid);
}

async function refreshTmuxAgentMap(): Promise<Map<string, TmuxAgentInfo>> {
  const now = Date.now();
  if (now - tmuxAgentMapCache.timestamp < TMUX_AGENT_MAP_TTL_MS) {
    return tmuxAgentMapCache.map;
  }

  const map = new Map<string, TmuxAgentInfo>();
  const sessions = new Set(await refreshTmuxSessionCache());

  // One tmux call for every pane, then /proc reads: the old per-session
  // tmux/ps/pgrep spawns (~4 x 44 sessions every 15 s) took 38% of DevFlow's
  // event loop under load on 1 Oct 2026 and channels stopped loading.
  let panes = '';
  try {
    ({ stdout: panes } = await tmuxRun(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'], { timeout: 3000 },
    ));
  } catch { /* no tmux server: empty map */ }
  const firstPanePid = new Map<string, string>();
  for (const line of panes.split('\n')) {
    const [sess, pid] = line.split('\t');
    if (sess && pid && sessions.has(sess) && !firstPanePid.has(sess)) firstPanePid.set(sess, pid);
  }

  for (const [sess, pid] of firstPanePid) {
    try {
      const args = await readProcCmdline(pid);
      const nameMatch = args.match(/--name\s+"?(\w+)"?/);
      const chanMatch = args.match(/--channel\s+"?([a-f0-9-]+)"?/);
      if (!nameMatch || !chanMatch) continue;

      // The actual Claude binary PID: a child or grandchild of the wrapper.
      let claudePid = 0;
      for (const child of await readProcChildren(pid)) {
        if ((await readProcCmdline(child)).includes('bin/claude')) { claudePid = Number(child); break; }
        for (const grandchild of await readProcChildren(child)) {
          if ((await readProcCmdline(grandchild)).includes('bin/claude')) { claudePid = Number(grandchild); break; }
        }
        if (claudePid) break;
      }

      const key = `${nameMatch[1]}::${chanMatch[1]}`;
      map.set(key, {
        name: nameMatch[1],
        channelId: chanMatch[1],
        pid: claudePid || parseInt(pid, 10),
        tmuxSession: sess,
      });
    } catch { /* skip unreachable session */ }
  }

  tmuxAgentMapCache = { map, timestamp: now };
  return map;
}

/**
 * Reconcile roster agents whose status is 'stopped' but who are actually
 * alive in a tmux session. This covers the gap after tmux server crashes
 * where auto-respawn creates new sessions but the roster doesn't update.
 */
async function reconcileStoppedAgents(): Promise<void> {
  const agentMap = await refreshTmuxAgentMap();
  if (agentMap.size === 0) return;

  const DEFAULT_CHANNELS_DATA: CollabChannelsData = { channels: [], lastUpdated: new Date().toISOString() };
  const channelsData = await readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);

  let modified = false;
  const now = new Date().toISOString();

  for (const channel of channelsData.channels) {
    if (!channel.roster?.agents?.length) continue;

    for (const agent of channel.roster.agents) {
      if (agent.status !== 'stopped' && agent.status !== 'crashed') continue;
      // Skip claude per-message (Windows) agents — they don't use tmux.
      // Codex+powershell IS a tmux-launched persistent wrapper, so it is NOT skipped.
      if (isWindowsPerMessageAgent(agent)) continue;

      const key = `${agent.name}::${channel.id}`;
      const real = agentMap.get(key);
      if (real && real.pid > 0) {
        // Verify the PID is actually alive
        try {
          process.kill(real.pid, 0);
        } catch {
          continue; // PID is dead — don't reconcile
        }

        // Read-only here: the snapshot is the shared read cache. The change is applied below,
        // inside the channel store, to a fresh copy.
        modified = true;

        logEvent('agent', 'info', `${agent.name} reconciled (stopped → running)`, {
          event: 'reconcile',
          agentName: agent.name,
          channelId: channel.id,
          channelName: channel.name,
          tmuxSession: real.tmuxSession,
          pid: real.pid,
        }).catch(() => {});
      }
    }
  }

  if (modified) {
    // Slow tmux work stays outside the lock.
    const freshMap = await refreshTmuxAgentMap();
    await mutateChannels('pty-reconcile-stopped', async freshData => {
      for (const channel of freshData.channels) {
        if (!channel.roster?.agents?.length) continue;
        for (const agent of channel.roster.agents) {
          if (agent.status !== 'stopped' && agent.status !== 'crashed') continue;
          if (isWindowsPerMessageAgent(agent)) continue;

          const key = `${agent.name}::${channel.id}`;
          const real = freshMap.get(key);
          if (real && real.pid > 0) {
            try { process.kill(real.pid, 0); } catch { continue; }
            agent.status = 'running';
            agent.pid = real.pid;
            agent.tmuxSessionName = real.tmuxSession;
            agent.lastStartedAt = now;
          }
        }
      }

      await saveChannels(freshData);
    });
  }
}

/**
 * Get output from tmux pane
 */
async function getTmuxPaneOutput(sessionName: string, lines: number = 50): Promise<string> {
  try {
    const { stdout } = await tmuxRun(['capture-pane', '-t', validateTmuxName(sessionName), '-p', '-S', `-${lines}`]);
    return stripAnsi(stdout);
  } catch {
    return '';
  }
}

export interface SpawnPtyOptions {
  replace?: boolean;
  channelId: string;
  channelName: string;
  participantName?: string;
  systemPrompt?: string;
  workingDirectory?: string;  // Directory to run Claude in (for isolated session files)
  onData: (chunk: string) => void;
  onEnd: (fullResponse: string) => void;
  onError: (error: Error) => void;
  onStatusChange: (status: PtySessionStatus) => void;
  // Roster-aware options
  resumeSessionId?: string;           // For `claude --resume {id}`
  useCollabWrapper?: boolean;          // Use collab-claude wrapper instead of raw claude
  dangerouslySkipPermissions?: boolean; // Default: true
  claudeFlags?: string[];             // Additional CLI flags
  appendSystemPromptFile?: string;    // Path to file containing system prompt to append (shell-safe)
  rosterAgentId?: string;             // Link to roster entry for crash detection
  participantId?: string;             // Use existing participant ID (for respawn)
  participantColor?: string;          // Use existing participant color (for respawn)
  customCommand?: string;             // Override entire command (for non-Claude agents like Gemini)
  spawnMode?: 'wsl' | 'powershell';  // Execution environment (default: 'wsl')
  alreadyCreatesSession?: boolean;   // When true, customCommand creates its own tmux session
  sessionId?: string;                 // Pre-generated session ID (used with alreadyCreatesSession)
  runLocation?: string;               // 'server' = run on this machine; otherwise on the agent host
  host?: string;                      // Explicit agent-host id (overrides DEVFLOW_AGENT_HOST)
}

export interface SpawnPtyResult {
  session: CollabPtySession;
  participant: CollabParticipant;
  emitter: EventEmitter;
}

/**
 * Spawn a new Claude PTY session using tmux
 */
export async function spawnCollabPtySession(options: SpawnPtyOptions): Promise<SpawnPtyResult> {
  const {
    channelId,
    channelName,
    participantName,
    systemPrompt,
    workingDirectory,
    onData,
    onEnd,
    onError,
    onStatusChange,
    resumeSessionId,
    useCollabWrapper = false,
    dangerouslySkipPermissions = true,
    claudeFlags = [],
    appendSystemPromptFile,
    rosterAgentId,
    participantId: existingParticipantId,
    participantColor: existingColor,
    alreadyCreatesSession = false,
    sessionId: preGeneratedSessionId,
  } = options;

  const sessionId = preGeneratedSessionId || randomUUID();
  const agentName = participantName || generateAgentName();
  const agentColor = existingColor || generateAgentColor(agentName);
  const now = new Date().toISOString();
  const tmuxSessionName = `${TMUX_SESSION_PREFIX}${sessionId.slice(0, 8)}`;

  // Create participant record
  const participant: CollabParticipant = {
    id: existingParticipantId || `pty-${sessionId}`,
    type: 'claude-terminal',
    name: agentName,
    source: useCollabWrapper ? 'Collab Wrapper' : 'DevFlow PTY',
    joinedAt: now,
    lastSeen: now,
    color: agentColor,
  };

  // Create session record
  const session: CollabPtySession = {
    id: sessionId,
    participantId: participant.id,
    channelId,
    status: 'starting',
    createdAt: now,
    lastActivity: now,
    model: (() => {
      // Derive model name from claudeFlags or default
      const modelIdx = claudeFlags.indexOf('--model');
      const modelName = modelIdx >= 0 && claudeFlags[modelIdx + 1] ? claudeFlags[modelIdx + 1] : 'opus';
      const modelLabels: Record<string, string> = {
        // Shortcut IDs (what agents typically have in roster.model)
        opus: 'Opus 5.5 (1M)',
        'opus[1m]': 'Opus 5.5 (1M)',
        sonnet: 'Sonnet 5',
        haiku: 'Haiku 4.5',
        'opus-5-5': 'Opus 5.5 (1M)',
        'claude-opus-5-5': 'Opus 5.5 (1M)',
        // Versioned short IDs (registry id field)
        'opus-4-8': 'Opus 4.8',
        'opus-4-7-1m': 'Opus 4.7 (1M)',
        'opus-4-7': 'Opus 4.7',
        'opus-4-6-1m': 'Opus 4.6 (1M)',
        'opus-4-6': 'Opus 4.6',
        'opus-4-5': 'Opus 4.5',
        'sonnet-5-5': 'Sonnet 5.5 (1M)',
        'sonnet-5': 'Sonnet 5',
        'sonnet-1m': 'Sonnet 4.6 (1M)',
        'sonnet-4-6': 'Sonnet 4.6',
        'sonnet-4-5': 'Sonnet 4.5',
        // Full apiId keys (used when --model flag is a raw apiId)
        'claude-opus-4-8[1m]': 'Opus 4.8 (1M)',
        'claude-opus-4-8': 'Opus 4.8',
        'claude-opus-4-7[1m]': 'Opus 4.7 (1M)',
        'claude-opus-4-7': 'Opus 4.7',
        'claude-opus-4-6[1m]': 'Opus 4.6 (1M)',
        'claude-opus-4-6': 'Opus 4.6',
        'claude-opus-4-5-20251101': 'Opus 4.5',
        'claude-sonnet-5-5': 'Sonnet 5.5 (1M)',
        'claude-sonnet-5': 'Sonnet 5',
        'claude-sonnet-4-6[1m]': 'Sonnet 4.6 (1M)',
        'claude-sonnet-4-6': 'Sonnet 4.6',
        'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
        'claude-haiku-4-5-20251001': 'Haiku 4.5',
      };
      return modelLabels[modelName] || modelName;
    })(),
  };

  const emitter = new EventEmitter();
  const remoteHost = hostFor({ runLocation: options.runLocation, host: options.host });
  // runLocation 'server': the agent program runs on this machine (the DevFlow server) while its folders live on the desktop. It starts inside a
  // private view of the desktop's shared folders (lib/laptop-view.ts). With no desktop host configured there is nothing to share, so it is an
  // ordinary local agent.
  const laptopRun = options.runLocation === 'server' && !!defaultHost();
  if (laptopRun && alreadyCreatesSession) throw new Error('This kind of agent cannot run on the Remote server yet.');

  // Pre-spawn session count limit — prevent runaway spawning.
  // 50 = operator-approved 2026-09-15 after the live fleet reached the former
  // 40-session ceiling. The independent memory gate still blocks unsafe spawns.
  const MAX_TMUX_SESSIONS = 50;
  try {
    if (remoteHost) throw new Error('remote host: session limit is enforced on that machine');
    const { stdout: tmuxList } = await execAsync('tmux list-sessions 2>/dev/null | wc -l || echo 0');
    const activeCount = parseInt(tmuxList.trim(), 10) || 0;
    if (activeCount >= MAX_TMUX_SESSIONS) {
      throw new Error(`Session limit reached (${activeCount}/${MAX_TMUX_SESSIONS}). Kill idle sessions before spawning new ones.`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('Session limit')) throw e;
    // tmux not running or list failed — safe to proceed
  }

  // Validate working directory exists before spawning (a remote host checks its own filesystem; a laptop-run agent's folder is checked in its view below)
  if (workingDirectory && !remoteHost && !laptopRun) {
    try {
      const stat = await fs.stat(workingDirectory);
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${workingDirectory}`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Working directory does not exist: ${workingDirectory}`);
      }
      throw err;
    }
  }

  try {
    // Build the command based on options
    let claudeCommand: string;

    if (options.customCommand) {
      // Custom command override (for non-Claude agents like Gemini)
      claudeCommand = options.customCommand;
    } else if (useCollabWrapper) {
      // Use collab-claude wrapper which handles channel joining automatically
      // Use full path because PM2 env may not include ~/bin in PATH
      const wrapperArgs = [
        COLLAB_CLAUDE_BIN,
        `--name "${agentName}"`,
        `--channel "${channelId}"`,
      ];
      if (dangerouslySkipPermissions) {
        wrapperArgs.push('--dangerously-skip-permissions');
      }
      if (resumeSessionId) {
        wrapperArgs.push(`--resume "${resumeSessionId}"`);
      }
      for (const flag of validateClaudeFlags(claudeFlags)) {
        wrapperArgs.push(flag);
      }
      // Use --system-prompt-file to pass role content safely (avoids shell interpretation
      // of backticks/$ in markdown content that breaks $(cat ...) inside double quotes)
      if (appendSystemPromptFile) {
        wrapperArgs.push(`--system-prompt-file "${appendSystemPromptFile}"`);
      }
      claudeCommand = wrapperArgs.join(' ');
    } else {
      // Use raw claude CLI (full path for PM2 env safety)
      const cliArgs = [CLAUDE_BIN];
      if (dangerouslySkipPermissions) {
        cliArgs.push('--dangerously-skip-permissions');
      }
      if (resumeSessionId) {
        cliArgs.push('--resume', resumeSessionId);
      }
      for (const flag of claudeFlags) {
        cliArgs.push(flag);
      }
      // Note: appendSystemPromptFile is handled via _SP_CONTENT variable below
      claudeCommand = cliArgs.join(' ');
    }

    // Unset CLAUDECODE to prevent "nested session" detection when spawned from a Claude context.
    // Unset ANTHROPIC_API_KEY so Claude agents authenticate via the Max subscription OAuth
    // (~/.claude/.credentials.json) instead of the pay-per-token API. The key is exported in
    // ~/.secrets so it's present in the spawn env; without this, headless/raw claude calls leak
    // to API billing. Mirrors the DeepSeek path (lib/deepseek-env.ts:129) which already unsets it.
    // For non-wrapper case with appendSystemPromptFile: use variable assignment to safely
    // pass file content without shell interpretation of backticks/$ in markdown
    // Agents and everything they launch (ffmpeg, Blender, builds) run below the
    // priority of DevFlow and pm2 services, so heavy agent work cannot starve
    // the UI. They still use all idle CPU.
    let envSetup = AGENT_PRIORITY_PREFIX + (options.customCommand ? '' : claudeSpawnUnsetPrefix());
    // DeepSeek V4 backbone-swap: when --model is deepseek-v4-pro/flash, prepend
    // the shell prefix that points the Anthropic SDK at api.deepseek.com.
    // No-op for sonnet/opus/haiku/non-Claude agents.
    if (!options.customCommand) {
      // Pass workingDirectory so the trust dialog is pre-approved for the correct path,
      // not the tmux launch dir (which is what $PWD would capture before the cd runs).
      envSetup = buildDeepSeekShellEnv(claudeFlags, workingDirectory) + envSetup;
    }
    let effectiveCommand = claudeCommand;
    if (!options.customCommand && !useCollabWrapper && appendSystemPromptFile) {
      envSetup += ` _SP_CONTENT=$(cat '${appendSystemPromptFile}');`;
      effectiveCommand += ' --append-system-prompt "$_SP_CONTENT"';
    }
    // exec replaces the launch shell, so the tmux pane PID stays the agent
    // process PID. The renice prefix stops bash from doing that implicitly, and
    // Codex durable delivery fences claims on the roster PID matching the
    // wrapper's own PID.
    const fullCommand = workingDirectory
      ? `${envSetup} cd "${workingDirectory}" && exec ${effectiveCommand}`
      : `${envSetup} exec ${effectiveCommand}`;

    // A laptop-run agent is checked and wrapped here: every desktop folder it needs must be shared and answering right now, or it does not start.
    let viewWrap: ((command: string) => string) | null = null;
    if (laptopRun) {
      if (!workingDirectory) throw new Error('An agent on the Remote server needs a working folder.');
      viewWrap = (await prepareLaptopLaunch({ workingDirectory, agentName })).wrap;
      rememberLocalSession(tmuxSessionName);
    }
    const launchCommand = viewWrap ? viewWrap(fullCommand) : fullCommand;

    const remoteLaunch = async (withResume: boolean) => {
      if (!remoteHost || !workingDirectory) throw new Error('remote spawn needs a working directory');
      if (!options.customCommand && buildDeepSeekShellEnv(claudeFlags, workingDirectory).trim()) {
        throw new Error('DeepSeek agents cannot run on a remote host yet');
      }
      let promptPath = appendSystemPromptFile;
      if (appendSystemPromptFile && useCollabWrapper && !options.customCommand) {
        promptPath = await pushFile(remoteHost, await fs.readFile(appendSystemPromptFile, 'utf8'), `${tmuxSessionName}-role.md`);
      }
      let spec;
      if (options.customCommand) spec = parseLaunchCommand(options.customCommand);
      else if (useCollabWrapper) {
        spec = claudeWrapperSpec({
          agentName, channelId, skipPermissions: dangerouslySkipPermissions,
          resumeSessionId: withResume ? resumeSessionId : undefined,
          flags: validateClaudeFlags(claudeFlags), systemPromptFile: promptPath,
        });
      } else throw new Error('raw claude sessions cannot run on a remote host');
      rememberSessionHost(tmuxSessionName, remoteHost);
      await spawnOnHost(remoteHost, { session: tmuxSessionName, cwd: workingDirectory, spec, selfSession: alreadyCreatesSession, replace: options.replace });
    };

    // Ensure tmux socket directory exists (wiped on WSL restart)
    const uid = remoteHost ? undefined : process.getuid?.();
    if (uid !== undefined) {
      try {
        await fs.mkdir(`/tmp/tmux-${uid}`, { mode: 0o700, recursive: true });
      } catch {}
    }

    // Ensure crash log directory exists (used by pipe-pane in default path below)
    await ensureCrashLogDir();
    const pipeLogPath = getPipeLogPath(tmuxSessionName);

    // When alreadyCreatesSession is true, the customCommand (e.g. agy-launch.sh)
    // creates its own tmux session with pipe-pane, scrollback, and mouse config.
    // Run it directly instead of wrapping in `tmux new-session`.
    if (remoteHost) {
      await remoteLaunch(true);
    } else if (alreadyCreatesSession) {
      try {
        await execAsync(fullCommand);
      } catch (tmuxError: unknown) {
        const errMsg = tmuxError instanceof Error ? tmuxError.message : String(tmuxError);
        console.error(`[PTY] customCommand error: ${errMsg.substring(0, 500)}`);
        if (tmuxError && typeof tmuxError === 'object' && 'stderr' in tmuxError) {
          console.error(`[PTY] customCommand stderr: ${String((tmuxError as { stderr: string }).stderr).substring(0, 500)}`);
        }
        throw tmuxError;
      }
    } else {
      // Use single quotes for tmux to preserve $() command substitution
      // Set generous scrollback (50k lines) and enable mouse for scroll-wheel support
      // pipe-pane captures all output to a log file for crash diagnostics
      const tmuxCmd = `tmux new-session -d -s ${tmuxSessionName} '${launchCommand.replace(/'/g, "'\\''")}'` +
        ` \\; set-option -t ${tmuxSessionName} history-limit 50000` +
        ` \\; set-option -t ${tmuxSessionName} mouse on` +
        ` \\; pipe-pane -t ${tmuxSessionName} -o 'cat >> ${pipeLogPath}'`;
      try {
        await execAsync(tmuxCmd);
      } catch (tmuxError: unknown) {
        const errMsg = tmuxError instanceof Error ? tmuxError.message : String(tmuxError);
        console.error(`[PTY] tmux new-session error: ${errMsg.substring(0, 500)}`);
        // Check if the error contains useful info about shell failure
        if (tmuxError && typeof tmuxError === 'object' && 'stderr' in tmuxError) {
          console.error(`[PTY] tmux stderr: ${String((tmuxError as { stderr: string }).stderr).substring(0, 500)}`);
        }
        throw tmuxError;
      }
    }

    // Wait a moment for the process to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Invalidate the shared tmux session cache — other code paths (polling,
    // roster enrichment) still use it; we want them to pick up the new session.
    tmuxSessionCache = { sessions: new Set(), timestamp: 0 };
    if (laptopRun) rememberLocalSession(tmuxSessionName);      // this machine's own session list must show the new session at once

    // Verify session is running via a direct `tmux has-session` check so we
    // don't hit the cache's silent empty-set fallback under burst concurrency
    // (T2.1: `tmux list-sessions` can transiently fail, producing false
    // "session failed to start" errors for sessions that are fully alive).
    let exists = await verifySpawnedSession(tmuxSessionName);
    if (!exists && resumeSessionId) {
      // Resume failed (stale/wrong session ID) - retry without --resume
      logEvent('agent', 'medium', '[PTY] Session died with --resume, retrying without resume', { tmuxSession: tmuxSessionName, staleSessionId: resumeSessionId }).catch(() => {});

      // Rebuild command without --resume
      let retryCommand: string;
      if (useCollabWrapper) {
        const retryArgs = [
          COLLAB_CLAUDE_BIN,
          `--name "${agentName}"`,
          `--channel "${channelId}"`,
        ];
        if (dangerouslySkipPermissions) {
          retryArgs.push('--dangerously-skip-permissions');
        }
        for (const flag of claudeFlags) {
          retryArgs.push(flag);
        }
        if (appendSystemPromptFile) {
          retryArgs.push(`--system-prompt-file "${appendSystemPromptFile}"`);
        }
        retryCommand = retryArgs.join(' ');
      } else {
        const retryArgs = [CLAUDE_BIN];
        if (dangerouslySkipPermissions) {
          retryArgs.push('--dangerously-skip-permissions');
        }
        for (const flag of claudeFlags) {
          retryArgs.push(flag);
        }
        retryCommand = retryArgs.join(' ');
        // appendSystemPromptFile is handled by _SP_CONTENT variable in envSetup
        if (appendSystemPromptFile) {
          retryCommand += ' --append-system-prompt "$_SP_CONTENT"';
        }
      }

      const retryFull = workingDirectory
        ? `${envSetup} cd "${workingDirectory}" && ${retryCommand}`
        : `${envSetup} ${retryCommand}`;

      if (remoteHost) {
        await remoteLaunch(false);
      } else {
        await execAsync(
          `tmux new-session -d -s ${tmuxSessionName} '${(viewWrap ? viewWrap(retryFull) : retryFull).replace(/'/g, "'\\''")}'` +
          ` \\; set-option -t ${tmuxSessionName} history-limit 50000` +
          ` \\; set-option -t ${tmuxSessionName} mouse on` +
          ` \\; pipe-pane -t ${tmuxSessionName} -o 'cat >> ${pipeLogPath}'`
        );
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      tmuxSessionCache = { sessions: new Set(), timestamp: 0 };
      exists = await verifySpawnedSession(tmuxSessionName);
    }

    if (!exists) {
      // Try to capture any output from the dying session for debugging
      const failOutput = await getTmuxPaneOutput(tmuxSessionName, 20);
      if (failOutput) {
        console.error(`[PTY] Session ${tmuxSessionName} died. Last output:\n${failOutput.substring(0, 500)}`);
      }
      const startupDiagnostic = await readSpawnFailureDiagnostic(pipeLogPath);
      if (startupDiagnostic) {
        console.error(`[PTY] Session ${tmuxSessionName} startup cause: ${startupDiagnostic}`);
        throw new Error(
          `Agent process exited during startup (session: ${tmuxSessionName}): ${startupDiagnostic}`,
        );
      }
      throw new Error(`tmux session failed to start (session: ${tmuxSessionName})`);
    }

    // Get PID of the process inside tmux
    let tmuxPid: number | undefined;
    try {
      const { stdout } = await tmuxRun(['list-panes', '-t', validateTmuxName(tmuxSessionName), '-F', '#{pane_pid}']);
      tmuxPid = remoteHost ? undefined : parseInt(stdout.trim(), 10) || undefined;
    } catch (error) {
      logEvent('agent', 'medium', '[PTY] Failed to get pane PID', { tmuxSession: tmuxSessionName, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }

    // Get initial output to confirm Claude started
    const initialOutput = await getTmuxPaneOutput(tmuxSessionName);

    session.status = 'ready';
    session.pid = tmuxPid;
    onStatusChange('ready');

    // Store session info
    const sessionData: ActiveSessionData = {
      session,
      tmuxSessionName,
      emitter,
      lastOutput: initialOutput,
      rosterAgentId,
      backend: 'tmux',
    };
    activeSessions.set(sessionId, sessionData);

    // Start polling for output changes (for streaming responses back to channel)
    const pollInterval = setInterval(async () => {
      try {
        const exists = await tmuxSessionExists(tmuxSessionName);
        if (!exists) {
          clearInterval(pollInterval);
          session.status = 'closed';
          onStatusChange('closed');
          onEnd(sessionData.lastOutput);
          activeSessions.delete(sessionId);
          removeSessionFromFile(sessionId).catch(console.error);
          return;
        }

        const currentOutput = await getTmuxPaneOutput(tmuxSessionName, 100);
        if (currentOutput !== sessionData.lastOutput) {
          const newContent = currentOutput.slice(sessionData.lastOutput.length);
          if (newContent.trim()) {
            session.lastActivity = new Date().toISOString();
            onData(newContent);
            emitter.emit('data', newContent);
          }
          sessionData.lastOutput = currentOutput;
        }
      } catch (err) {
        console.error(`[PTY] Poll error for ${tmuxSessionName}:`, err);
      }
    }, 1000);

    sessionData.pollInterval = pollInterval;

    // Fix 5: Cap sessions per channel at 20 — remove oldest when exceeded
    const capData = await readSessionsData();
    const channelSessions = capData.sessions
      .filter(s => s.channelId === channelId && s.status !== 'closed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (channelSessions.length >= 20) {
      const toRemove = channelSessions.slice(0, channelSessions.length - 19);
      const removeIds = new Set(toRemove.map(s => s.id));
      capData.sessions = capData.sessions.filter(s => !removeIds.has(s.id));
      logEvent('agent', 'medium', '[PTY] Channel hit session cap', { channelId, removed: toRemove.length }).catch(() => {});
      await writeSessionsData(capData);
    }

    // Persist to file
    await updateSessionInFile(session);

    // Send initial system prompt if provided (not for collab wrapper - it handles its own setup)
    if (systemPrompt && !useCollabWrapper) {
      setTimeout(() => {
        sendToPty(sessionId, systemPrompt);
      }, 3000);
    }

    // Ensure crash detection is running
    startCrashDetection();

    return { session, participant, emitter };

  } catch (error) {
    console.error(`[PTY] Failed to spawn tmux session:`, error);
    session.status = 'error';
    session.error = error instanceof Error ? error.message : 'Failed to spawn';
    onError(error instanceof Error ? error : new Error('Failed to spawn'));
    onStatusChange('error');
    throw error;
  }
}

/**
 * Send a message to a PTY session via tmux send-keys
 */
export function sendToPty(sessionId: string, message: string): boolean {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) {
    console.error(`[PTY] Session not found: ${sessionId}`);
    return false;
  }

  // Dispatch to Windows per-message handler (fire-and-forget from caller's perspective)
  if (sessionData.backend === 'windows-pm') {
    sendToWindowsPty(sessionId, message).catch(err => {
      console.error(`[PTY-WIN] sendToWindowsPty error:`, err);
    });
    return true;
  }

  const { tmuxSessionName, session } = sessionData;

  // Use execFile (async, non-blocking) with -l flag — tmux handles literal escaping
  const safeName = validateTmuxName(tmuxSessionName);
  tmuxRun(['send-keys', '-t', safeName, '-l', message])
    .then(() => tmuxRun(['send-keys', '-t', safeName, 'Enter']))
    .then(() => {
      session.status = 'responding';
      session.lastActivity = new Date().toISOString();
      updateSessionInFile(session).catch(console.error);
    })
    .catch(error => {
      console.error(`[PTY ${sessionId}] Failed to send:`, error);
    });

  return true;
}

/**
 * Close a PTY session by killing the tmux session
 */
export async function closePtySession(sessionId: string): Promise<boolean> {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) {
    console.error(`[PTY] Session not found: ${sessionId}`);
    return false;
  }

  // Dispatch to Windows handler
  if (sessionData.backend === 'windows-pm') {
    return closeWindowsPtySession(sessionId);
  }

  const { tmuxSessionName, session, pollInterval } = sessionData;

  // Stop polling
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  try {
    // Kill the tmux session
    await tmuxRun(['kill-session', '-t', validateTmuxName(tmuxSessionName)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: string }).code !== 'ENOENT') {
      logEvent('agent', 'low', '[PTY] tmux kill-session failed on close', { tmuxSession: tmuxSessionName, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
  }

  session.status = 'closed';
  await updateSessionInFile(session);
  activeSessions.delete(sessionId);

  return true;
}

// ============================================
// PowerShell (Windows) Per-Message Spawn
// ============================================

/**
 * Convert WSL path to Windows path for claude.exe --cwd
 */
function toWindowsPath(wslPath: string): string {
  if (wslPath.startsWith('/mnt/')) {
    const parts = wslPath.split('/');
    return `${parts[2].toUpperCase()}:\\${parts.slice(3).join('\\')}`;
  }
  // WSL paths accessed from Windows via \\wsl$
  return `\\\\wsl$\\Ubuntu${wslPath.replace(/\//g, '\\\\')}`;
}

/**
 * Arguments that give a Windows (PowerShell) agent the same context as its WSL
 * twin. Evidence: SG-1/plans/evidence/ps-parity/README.md.
 * - Memory: Windows keys auto-memory to its own home, so point it at the WSL
 *   folder through the mapped drive (claude.exe rejects UNC paths here).
 * - Transport: the final response is posted for the agent; without saying so it
 *   tries the WSL-only collab_helper.py from Git Bash.
 * Side effect: approves the project's external @-imports in Windows' own
 * .claude.json; print mode otherwise skips them silently, dropping role and
 * personality.
 */
async function windowsParityArgs(wslCwd: string | undefined, model: string | undefined): Promise<string[]> {
  const args: string[] = [];
  if (model) args.push('--model', resolveApiIdForModel(model));
  if (!wslCwd) return args;
  let root = wslCwd;
  try {
    const { stdout } = await execFileAsync('git', ['-C', wslCwd, 'rev-parse', '--show-toplevel']);
    if (stdout.trim()) root = stdout.trim();
  } catch { /* not a git repo: Claude keys memory to the cwd */ }
  const drive = process.env.WINDOWS_WSL_DRIVE || 'Z:';
  const slug = root.replace(/[^a-zA-Z0-9\-_]/g, '-');
  args.push('--settings', JSON.stringify({
    autoMemoryDirectory: `${drive}${os.homedir()}/.claude/projects/${slug}/memory`,
  }));
  args.push('--append-system-prompt',
    'AgentChat transport: your final response is posted to the channel for you. ' +
    'Reply normally; do not call collab_helper.py.');
  await approveWindowsProject([wslCwd, root]);
  return args;
}

async function approveWindowsProject(wslPaths: string[]): Promise<void> {
  const configPath = path.join(path.dirname(path.dirname(path.dirname(CLAUDE_EXE_WSL))), '.claude.json');
  const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const projects = config.projects ??= {};
    let changed = false;
    for (const p of new Set(wslPaths)) {
      const entry = projects[`//wsl.localhost/${distro}${p}`] ??= {};
      if (entry.hasClaudeMdExternalIncludesApproved && entry.hasTrustDialogAccepted) continue;
      Object.assign(entry, {
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      });
      changed = true;
    }
    if (changed) {
      const tmp = `${configPath}.devflow-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(config, null, 2));
      await fs.rename(tmp, configPath);
    }
  } catch (err) {
    console.error('[PTY-WIN] Could not approve project imports in Windows .claude.json:', err);
  }
}

/**
 * Spawn a Windows PowerShell agent session (per-message invocation pattern).
 *
 * Unlike tmux sessions, Windows sessions use claude.exe with -p per message.
 * First message creates a new session; subsequent messages use --resume.
 * Each message = spawn claude.exe → collect response → process exits.
 */
export async function spawnWindowsPtySession(options: SpawnPtyOptions): Promise<SpawnPtyResult> {
  const {
    channelId,
    channelName,
    participantName,
    workingDirectory,
    onData,
    onEnd,
    onError,
    onStatusChange,
    resumeSessionId,
    dangerouslySkipPermissions = true,
    claudeFlags = [],
    appendSystemPromptFile,
    rosterAgentId,
    participantId: existingParticipantId,
    participantColor: existingColor,
  } = options;

  const sessionId = randomUUID();
  const agentName = participantName || generateAgentName();
  const agentColor = existingColor || generateAgentColor(agentName);
  const now = new Date().toISOString();

  // For Windows per-message sessions the participant ID is always pty-{sessionId}.
  // handleRosterSpawn overwrites agent.participantId to pty-{session.id} after spawn,
  // so using existingParticipantId here would leave the session file with a stale ID
  // that sendToWindowsPty uses to post responses — causing silent delivery failures.
  const windowsParticipantId = `pty-${sessionId}`;
  const participant: CollabParticipant = {
    id: windowsParticipantId,
    type: 'claude-terminal',
    name: agentName,
    source: 'PowerShell',
    joinedAt: now,
    lastSeen: now,
    color: agentColor,
  };

  const session: CollabPtySession = {
    id: sessionId,
    participantId: windowsParticipantId,
    channelId,
    status: 'starting',
    createdAt: now,
    lastActivity: now,
    model: (() => {
      const modelIdx = claudeFlags.indexOf('--model');
      const modelName = modelIdx >= 0 && claudeFlags[modelIdx + 1] ? claudeFlags[modelIdx + 1] : 'opus';
      const modelLabels: Record<string, string> = {
        // Shortcut IDs (what agents typically have in roster.model)
        opus: 'Opus 5.5 (1M)',
        'opus[1m]': 'Opus 5.5 (1M)',
        sonnet: 'Sonnet 5',
        haiku: 'Haiku 4.5',
        'opus-5-5': 'Opus 5.5 (1M)',
        'claude-opus-5-5': 'Opus 5.5 (1M)',
        // Versioned short IDs (registry id field)
        'opus-4-8': 'Opus 4.8',
        'opus-4-7-1m': 'Opus 4.7 (1M)',
        'opus-4-7': 'Opus 4.7',
        'opus-4-6-1m': 'Opus 4.6 (1M)',
        'opus-4-6': 'Opus 4.6',
        'opus-4-5': 'Opus 4.5',
        'sonnet-5-5': 'Sonnet 5.5 (1M)',
        'sonnet-5': 'Sonnet 5',
        'sonnet-1m': 'Sonnet 4.6 (1M)',
        'sonnet-4-6': 'Sonnet 4.6',
        'sonnet-4-5': 'Sonnet 4.5',
        // Full apiId keys (used when --model flag is a raw apiId)
        'claude-opus-4-8[1m]': 'Opus 4.8 (1M)',
        'claude-opus-4-8': 'Opus 4.8',
        'claude-opus-4-7[1m]': 'Opus 4.7 (1M)',
        'claude-opus-4-7': 'Opus 4.7',
        'claude-opus-4-6[1m]': 'Opus 4.6 (1M)',
        'claude-opus-4-6': 'Opus 4.6',
        'claude-opus-4-5-20251101': 'Opus 4.5',
        'claude-sonnet-5-5': 'Sonnet 5.5 (1M)',
        'claude-sonnet-5': 'Sonnet 5',
        'claude-sonnet-4-6[1m]': 'Sonnet 4.6 (1M)',
        'claude-sonnet-4-6': 'Sonnet 4.6',
        'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
        'claude-haiku-4-5-20251001': 'Haiku 4.5',
      };
      return modelLabels[modelName] || modelName;
    })(),
  };

  const emitter = new EventEmitter();

  // Determine Windows working directory
  const windowsWorkDir = workingDirectory ? toWindowsPath(workingDirectory) : undefined;

  try {
    // Verify claude.exe exists
    try {
      await fs.access(CLAUDE_EXE_WSL);
    } catch {
      throw new Error(`claude.exe not found at ${CLAUDE_EXE_WSL}`);
    }

    // Send a test message to verify claude.exe works and get the session ID
    const initPrompt = appendSystemPromptFile
      ? `You are ${agentName}. Read your instructions and acknowledge you are ready.`
      : `You are ${agentName}. Reply with: "Ready."`;

    const cliArgs: string[] = [];
    if (dangerouslySkipPermissions) cliArgs.push('--dangerously-skip-permissions');
    if (resumeSessionId) cliArgs.push('--resume', resumeSessionId);
    for (const flag of claudeFlags) cliArgs.push(flag);
    cliArgs.push(...await windowsParityArgs(workingDirectory, undefined));
    cliArgs.push('--output-format', 'json');
    cliArgs.push('-p', initPrompt);

    // scrubClaudeSpawnEnv merges process.env + DeepSeek overrides, then strips
    // CLAUDECODE, CLAUDE_CODE_ENTRYPOINT and ANTHROPIC_API_KEY (the last enforces
    // Max-subscription auth — see lib/claude-spawn-env.ts). Setting vars to
    // undefined doesn't remove them on Windows (empty string breaks claude.exe);
    // the helper deletes them outright.
    const initEnv = scrubClaudeSpawnEnv(buildDeepSeekProcessEnv(claudeFlags));
    const spawnOpts: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv } = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: initEnv,
    };
    // Use WSL path for cwd (Node runs in WSL, but claude.exe handles translation)
    if (workingDirectory) spawnOpts.cwd = workingDirectory;

    const initResult = await new Promise<{ sessionId: string; response: string }>((resolve, reject) => {
      const child = spawn(CLAUDE_EXE_WSL, cliArgs, spawnOpts);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.stdin.end();

      const hasChrome = claudeFlags.includes('--chrome');
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        const chromeHint = hasChrome && !stderr
          ? ' This is a --chrome session with empty stderr — Edge must be running with the Claude extension active.'
          : '';
        reject(new Error(`claude.exe init timed out after 60s.${chromeHint} stderr: ${stderr.substring(0, 500)}`));
      }, 60_000);

      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`claude.exe exited with code ${code}. stderr: ${stderr.substring(0, 500)}`));
          return;
        }
        // Parse JSONL output for session_id
        let claudeSessionId = '';
        let response = '';
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed)) {
              for (const obj of parsed) {
                if (obj.session_id) claudeSessionId = obj.session_id;
                if (obj.type === 'assistant') {
                  // Extract text from content blocks
                  const textBlocks = (obj.message?.content || []).filter((b: { type: string }) => b.type === 'text');
                  response = textBlocks.map((b: { text: string }) => b.text).join('\n');
                }
              }
            } else {
              if (parsed.session_id) claudeSessionId = parsed.session_id;
            }
          } catch {
            // Not JSON — skip
          }
        }
        if (!claudeSessionId) {
          reject(new Error(`No session_id in claude.exe output. stdout: ${stdout.substring(0, 500)}`));
          return;
        }
        resolve({ sessionId: claudeSessionId, response });
      });
    });

    session.status = 'ready';
    onStatusChange('ready');

    const sessionData: ActiveSessionData = {
      session,
      tmuxSessionName: '', // Not used for Windows sessions
      emitter,
      lastOutput: initResult.response,
      rosterAgentId,
      backend: 'windows-pm',
      windowsSessionId: initResult.sessionId,
      windowsWorkDir: windowsWorkDir,
    };
    activeSessions.set(sessionId, sessionData);

    await updateSessionInFile(session);
    startCrashDetection();

    return { session, participant, emitter };
  } catch (error) {
    console.error(`[PTY-WIN] Failed to spawn Windows session:`, error);
    session.status = 'error';
    session.error = error instanceof Error ? error.message : 'Failed to spawn';
    onError(error instanceof Error ? error : new Error('Failed to spawn'));
    onStatusChange('error');
    throw error;
  }
}

/**
 * Post a windows-pm turn result to the channel as the agent participant.
 * Image posts go via /api/collab (base64 support); text-only via /api/agent.
 */
function postWindowsPmToChannel(
  session: CollabPtySession,
  sessionId: string,
  content: string,
  images: Array<{ data: string; name: string; type: string }> = [],
): void {
  if ((!content && images.length === 0) || !session.channelId || !session.participantId) return;
  const token = getDevFlowApiToken();
  if (!token) return;
  const hasImages = images.length > 0;
  const url = hasImages
    ? `${selfOrigin()}/api/collab`
    : `${selfOrigin()}/api/agent`;
  const body = hasImages
    ? { action: 'message', channelId: session.channelId, participantId: session.participantId, content, images }
    : { action: 'collab.message', channelId: session.channelId, participantId: session.participantId, content };
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }).catch((err: Error) => {
    console.error(`[PTY-WIN ${sessionId}] Failed to post response to channel: ${err.message}`);
  });
}

/**
 * Send a message to a Windows per-message session.
 * Spawns claude.exe with -p and --resume, collects the response.
 * Returns a promise that resolves when the response is collected.
 */
export async function sendToWindowsPty(sessionId: string, message: string): Promise<string> {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData || sessionData.backend !== 'windows-pm') {
    console.error(`[PTY-WIN] Session not found or wrong backend: ${sessionId}`);
    return '';
  }

  const { session } = sessionData;

  // Single roster lookup: pulls cwd, model, and claudeFlags (e.g. --chrome) so we
  // don't read the channels file twice. Per-message Windows spawns need claudeFlags
  // on every invocation because --resume doesn't restore MCP tool configs.
  let perMessageModel: string | undefined;
  let perMessageCwd: string | undefined;
  let perMessageFlags: string[] = [];
  if (session.channelId) {
    try {
      const channelsData = await readJsonFile<CollabChannelsData>(CHANNELS_PATH, { channels: [], lastUpdated: '' });
      const channel = channelsData.channels.find(c => c.id === session.channelId);
      const agent = channel?.roster?.agents.find(a => a.ptySessionId === sessionId);
      perMessageModel = agent?.model;
      perMessageCwd = agent?.effectiveWorkingDirectory;
      perMessageFlags = agent?.claudeFlags || [];
    } catch { /* roster read failed — fall through with no overrides */ }
  }

  // --chrome sessions cannot use --resume: resuming a session with Chrome MCP state causes
  // the Native Messaging reconnection to block on stdin (piped from Node.js), hanging forever.
  // Skip --resume for chrome sessions — each message is stateless/independent, which is fine
  // for browser automation tasks.
  const hasChrome = perMessageFlags.includes('--chrome');
  const cliArgs: string[] = ['--dangerously-skip-permissions'];
  if (!hasChrome && sessionData.windowsSessionId) {
    cliArgs.push('--resume', sessionData.windowsSessionId);
  }
  for (const flag of perMessageFlags) cliArgs.push(flag);
  // --resume does not restore the model reliably, so pin it on every message.
  cliArgs.push(...await windowsParityArgs(
    perMessageCwd,
    perMessageFlags.includes('--model') ? undefined : perMessageModel,
  ));
  cliArgs.push('--output-format', 'json', '-p', message);
  const deepseekProcessEnv = perMessageModel
    ? buildDeepSeekProcessEnv(['--model', perMessageModel])
    : {};

  // Expose channel identity and auth token so the agent can post follow-up
  // messages (e.g. screenshots saved to disk) without DevFlow's auto-post path.
  const channelEnv: Record<string, string> = {};
  if (session.channelId) channelEnv.DEVFLOW_CHANNEL_ID = session.channelId;
  if (session.participantId) channelEnv.DEVFLOW_PARTICIPANT_ID = session.participantId;
  const apiToken = getDevFlowApiToken();
  if (apiToken) channelEnv.DEVFLOW_API_TOKEN = apiToken;

  // Routed through the shared scrub helper so this path also strips
  // ANTHROPIC_API_KEY (Max-subscription auth) alongside the nested-session
  // markers — see lib/claude-spawn-env.ts.
  const msgEnv = scrubClaudeSpawnEnv({ ...deepseekProcessEnv, ...channelEnv });
  const spawnOpts: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv } = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: msgEnv,
  };
  if (perMessageCwd) {
    spawnOpts.cwd = perMessageCwd;
  }

  return new Promise<string>((resolve) => {
    const turnStartedAtMs = Date.now();
    const child = spawn(CLAUDE_EXE_WSL, cliArgs, spawnOpts);
    sessionData.activeChild = child;
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      sessionData.emitter.emit('data', d.toString());
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdin.end();

    session.status = 'responding';
    session.lastActivity = new Date().toISOString();
    updateSessionInFile(session).catch(console.error);

    // 5 minutes: browser tasks (navigate + screenshot + wait for render) can take time
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      console.error(`[PTY-WIN ${sessionId}] Message timed out after 300s`);
      // A silent timeout reads as "agent ignored me" — surface it in the channel.
      postWindowsPmToChannel(session, sessionId,
        '⚠️ (turn timed out after 5 minutes — no response was captured. Resend the message to retry.)');
      resolve('(message timed out)');
    }, 300_000);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      sessionData.activeChild = undefined;
      session.status = 'ready';
      session.lastActivity = new Date().toISOString();
      updateSessionInFile(session).catch(console.error);

      if (code !== 0) {
        console.error(`[PTY-WIN ${sessionId}] claude.exe exited ${code}: ${stderr.substring(0, 300)}`);
        sessionData.consecutiveFailures = (sessionData.consecutiveFailures || 0) + 1;
        if (sessionData.consecutiveFailures >= 3) {
          console.error(`[PTY-WIN ${sessionId}] 3 consecutive failures — marking session as error`);
          session.status = 'error';
          session.error = `claude.exe failed ${sessionData.consecutiveFailures} times consecutively`;
        }
      } else {
        sessionData.consecutiveFailures = 0;
      }

      // Parse response from JSONL — extract text AND any screenshot images from tool results
      let response = '';
      const capturedImages: Array<{data: string; name: string; type: string}> = [];
      let imgSeq = 0;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const obj of items) {
            if (obj.type === 'assistant') {
              const content = obj.message?.content || [];
              const textBlocks = content.filter((b: { type: string }) => b.type === 'text');
              response += textBlocks.map((b: { text: string }) => b.text).join('\n');
              // Also check for inline image blocks in assistant content
              for (const block of content) {
                if (block?.type === 'image' && block.source?.type === 'base64' && block.source.data) {
                  const mime = block.source.media_type || 'image/png';
                  capturedImages.push({ data: `data:${mime};base64,${block.source.data}`, name: `screenshot-${++imgSeq}.png`, type: mime });
                }
              }
            }
            // Capture screenshot images from tool_result content blocks
            if (obj.type === 'tool_result') {
              const content = Array.isArray(obj.content) ? obj.content : (obj.content ? [obj.content] : []);
              for (const block of content) {
                if (block?.type === 'image' && block.source?.type === 'base64' && block.source.data) {
                  const mime = block.source.media_type || 'image/png';
                  capturedImages.push({ data: `data:${mime};base64,${block.source.data}`, name: `screenshot-${++imgSeq}.png`, type: mime });
                }
              }
            }
            // Update session ID if it changed
            if (obj.session_id) sessionData.windowsSessionId = obj.session_id;
          }
        } catch {
          // Not JSON
        }
      }

      sessionData.lastOutput = response;

      // Post response back to the channel so other participants can see it — UNLESS
      // the agent already posted itself mid-turn. windows-pm agents get channel env
      // vars (DEVFLOW_CHANNEL_ID/PARTICIPANT_ID/API_TOKEN) and often self-post their
      // answer via the API; auto-posting the full turn text on top duplicates the
      // agent's internal narration as a second out-of-order message.
      if ((response || capturedImages.length > 0) && session.channelId && session.participantId) {
        void (async () => {
          let selfPosted = false;
          try {
            const msgs = await readChannelMessages(session.channelId);
            selfPosted = msgs.messages.some(m =>
              m.from?.id === session.participantId &&
              new Date(m.timestamp).getTime() >= turnStartedAtMs
            );
          } catch { /* dedupe check failed — fall through to posting (complete beats silent) */ }
          if (selfPosted && capturedImages.length === 0) {
            console.log(`[PTY-WIN ${sessionId}] Agent self-posted during turn — skipping auto-post`);
            return;
          }
          // Agent self-posted but captured images exist: post the images without
          // repeating the text. Otherwise post the full turn response.
          postWindowsPmToChannel(session, sessionId, selfPosted ? '' : response, capturedImages);
        })();
      }

      resolve(response);
    });
  });
}

/**
 * Close a Windows per-message session.
 * Kills any active child process and removes session tracking.
 */
export async function closeWindowsPtySession(sessionId: string): Promise<boolean> {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData || sessionData.backend !== 'windows-pm') {
    console.error(`[PTY-WIN] Session not found: ${sessionId}`);
    return false;
  }

  // Kill any active child process
  if (sessionData.activeChild) {
    sessionData.activeChild.kill('SIGTERM');
  }

  sessionData.session.status = 'closed';
  await updateSessionInFile(sessionData.session);
  activeSessions.delete(sessionId);

  return true;
}

/**
 * Force-kill a Windows per-message session
 */
export async function forceKillWindowsPtySession(sessionId: string): Promise<boolean> {
  const sessionData = activeSessions.get(sessionId);
  if (sessionData?.activeChild) {
    sessionData.activeChild.kill('SIGTERM');
  }
  if (sessionData) {
    sessionData.session.status = 'closed';
    await updateSessionInFile(sessionData.session);
    activeSessions.delete(sessionId);
  }
  return true;
}

/**
 * Force-kill a PTY session: kills tmux + process, cleans up temp files
 */
export async function forceKillPtySession(sessionId: string): Promise<boolean> {
  const sessionData = activeSessions.get(sessionId);

  // Dispatch Windows sessions to their own handler
  if (sessionData?.backend === 'windows-pm') {
    return forceKillWindowsPtySession(sessionId);
  }

  // Stop polling if session is tracked
  if (sessionData) {
    if (sessionData.pollInterval) {
      clearInterval(sessionData.pollInterval);
    }

    const { tmuxSessionName, session } = sessionData;

    // Kill tmux session
    try {
      await tmuxRun(['kill-session', '-t', validateTmuxName(tmuxSessionName)]);
    } catch (error) {
      logEvent('agent', 'low', '[PTY] forceKill: tmux kill-session failed', { tmuxSession: tmuxSessionName, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }

    // Kill process by PID if available, with validation
    if (session.pid) {
      await safeKillProcess(session.pid);
    }

    // Clean up temp files for this PID
    if (session.pid) {
      await cleanupTempFiles(session.pid);
    }

    session.status = 'closed';
    await updateSessionInFile(session);
    activeSessions.delete(sessionId);
    return true;
  }

  // Session not in memory - try to find and kill by sessionId pattern
  const tmuxName = `${TMUX_SESSION_PREFIX}${sessionId.slice(0, 8)}`;
  try {
    await execAsync(`tmux kill-session -t ${tmuxName} 2>/dev/null`);
  } catch (error) {
    logEvent('agent', 'low', '[PTY] forceKill orphan: tmux kill-session failed', { tmuxSession: tmuxName, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
  }

  await removeSessionFromFile(sessionId);
  return true;
}

/**
 * Force-kill by tmux session name directly (for roster agents)
 */
export async function forceKillByTmuxName(tmuxSessionName: string, pid?: number): Promise<boolean> {
  // Find and remove from activeSessions
  for (const [id, data] of activeSessions) {
    if (data.tmuxSessionName === tmuxSessionName) {
      if (data.pollInterval) clearInterval(data.pollInterval);
      activeSessions.delete(id);
      break;
    }
  }

  // Kill tmux session
  try {
    await tmuxRun(['kill-session', '-t', validateTmuxName(tmuxSessionName)]);
  } catch { /* already gone */ }

  // Kill process by PID if provided
  if (pid) {
    await safeKillProcess(pid);
    await cleanupTempFiles(pid);
  }

  // Clean up pipe-pane log (clean shutdown = no crash data needed)
  try { await fs.unlink(getPipeLogPath(tmuxSessionName)); } catch {}

  return true;
}

/**
 * Safely kill a process by PID, validating it's a claude/collab process first
 */
export async function safeKillProcess(pid: number): Promise<void> {
  try {
    const cmdline = (await procCmdline(pid)).toLowerCase();
    if (cmdline.includes('claude') || cmdline.includes('collab') || cmdline.includes('grok')) {
      await execAsync(`kill -9 ${pid} 2>/dev/null`);
    }
  } catch {
    // Process already gone or not readable
  }
}

/**
 * Clean up collab temp files for a given PID
 */
export async function cleanupTempFiles(pid: number): Promise<void> {
  const files = [
    `/tmp/collab-ready-${pid}.json`,
    `/tmp/collab-session-${pid}.json`,
    `/tmp/collab-invite-${pid}.json`,
  ];
  for (const file of files) {
    try {
      await fs.unlink(file);
    } catch { /* file doesn't exist */ }
  }
}

/**
 * Sweep /tmp/ for stale collab files whose PIDs are no longer alive.
 * Called during roster.remove and roster.kill to clean up orphaned files
 * from prior incarnations of agents (e.g., after restarts).
 */
export async function sweepStaleCollabFiles(): Promise<number> {
  let cleaned = 0;
  try {
    const tmpFiles = await fs.readdir('/tmp');
    const prefixes = ['collab-session-', 'collab-ready-', 'collab-invite-'];

    for (const filename of tmpFiles) {
      if (!filename.endsWith('.json')) continue;
      const prefix = prefixes.find(p => filename.startsWith(p));
      if (!prefix) continue;

      const pidStr = filename.replace(prefix, '').replace('.json', '');
      if (!pidStr) {
        // Empty PID file (e.g., collab-session-.json) — always remove
        try { await fs.unlink(`/tmp/${filename}`); cleaned++; } catch { /* gone */ }
        continue;
      }

      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) continue;

      // Read platform from the session file (Windows agents write platform='windows')
      const filePath = `/tmp/${filename}`;
      let sessionPlatform: 'wsl' | 'windows' = 'wsl';
      try {
        const sessionData = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        if (sessionData.platform === 'windows') sessionPlatform = 'windows';
      } catch { /* malformed or gone — fall through with default */ }

      // Check if PID is alive, branching on platform
      if (!(await isAgentAlive(pid, sessionPlatform))) {
        try { await fs.unlink(filePath); cleaned++; } catch { /* gone */ }
      }
    }
  } catch (err) {
    console.error('[PTY] sweepStaleCollabFiles error:', err);
  }
  return cleaned;
}

/**
 * Kill any orphaned collab-claude wrapper processes for an agent by name and channel.
 * This catches duplicates that may have lost their tmux session tracking.
 */
export async function killOrphanedWrapperProcesses(agentName: string, channelId: string, excludePid?: number): Promise<number> {
  let killed = 0;
  try {
    // Find all collab-claude wrapper processes matching this agent name + channel.
    // Use exact quoted args in the pattern to require both "--name \"agentName\"" and "--channel channelId".
    const safeName = agentName.replace(/['"]/g, '');
    const { stdout } = await execAsync(
      `pgrep -f "collab-claude.*--name \\"${safeName}\\".*--channel.*${channelId}" 2>/dev/null || true`
    );
    if (!stdout.trim()) return 0;

    for (const line of stdout.trim().split('\n')) {
      const pid = parseInt(line.split(/\s+/)[0], 10);
      if (!pid || isNaN(pid)) continue;
      if (excludePid && pid === excludePid) continue;

      // Validate: read the process command line and confirm it contains BOTH the agent name AND channelId
      const cmdlineStr = await procCmdline(pid);
      if (!cmdlineStr.includes(safeName) || !cmdlineStr.includes(channelId)) {
        continue;
      }

      try {
        await execAsync(`kill -9 ${pid} 2>/dev/null`);
        killed++;
        // Clean up temp files for this orphaned process
        await cleanupTempFiles(pid);
      } catch { /* already dead */ }
    }
  } catch { /* pgrep not found or other error */ }
  return killed;
}

/**
 * Kill any orphaned collab-codex.py processes for an agent by name and channel.
 * Mirrors the claude/grok orphan-kill pattern.
 */
export async function killOrphanedCodexProcesses(agentName: string, channelId: string, excludePid?: number): Promise<number> {
  let killed = 0;
  try {
    const safeName = agentName.replace(/['"]/g, '');
    const { stdout } = await execAsync(
      `pgrep -f "collab-codex.*--name \\"${safeName}\\".*--channel.*${channelId}" 2>/dev/null || true`
    );
    if (!stdout.trim()) return 0;

    for (const line of stdout.trim().split('\n')) {
      const pid = parseInt(line.split(/\s+/)[0], 10);
      if (!pid || isNaN(pid)) continue;
      if (excludePid && pid === excludePid) continue;

      const cmdlineStr = await procCmdline(pid);
      if (!cmdlineStr.includes(safeName) || !cmdlineStr.includes(channelId)) {
        continue;
      }

      try {
        await execAsync(`kill -9 ${pid} 2>/dev/null`);
        killed++;
        await cleanupTempFiles(pid);
      } catch { /* already dead */ }
    }
  } catch { /* pgrep not found or other error */ }
  return killed;
}

/**
 * Kill any orphaned collab-grok.py processes for an agent by name and channel.
 */
export async function killOrphanedGrokProcesses(agentName: string, channelId: string, excludePid?: number): Promise<number> {
  let killed = 0;
  try {
    const safeName = agentName.replace(/['"]/g, '');
    const { stdout } = await execAsync(
      `pgrep -f "collab-grok.*--name \\"${safeName}\\".*--channel.*${channelId}" 2>/dev/null || true`
    );
    if (!stdout.trim()) return 0;

    for (const line of stdout.trim().split('\n')) {
      const pid = parseInt(line.split(/\s+/)[0], 10);
      if (!pid || isNaN(pid)) continue;
      if (excludePid && pid === excludePid) continue;

      // Validate: read the process command line and confirm it contains BOTH the agent name AND channelId
      const cmdlineStr = await procCmdline(pid);
      if (!cmdlineStr.includes(safeName) || !cmdlineStr.includes(channelId)) {
        continue;
      }

      try {
        await execAsync(`kill -9 ${pid} 2>/dev/null`);
        killed++;
        await cleanupTempFiles(pid);
      } catch { /* already dead */ }
    }
  } catch { /* pgrep not found or other error */ }
  return killed;
}

/**
 * Kill any orphaned collab-antigravity.py processes for an agent by name and channel.
 * Mirrors the codx/grok orphan-kill pattern.
 */
export async function killOrphanedAntigravityProcesses(agentName: string, channelId: string, excludePid?: number): Promise<number> {
  let killed = 0;
  try {
    const safeName = agentName.replace(/['"]/g, '');
    const { stdout } = await execAsync(
      `pgrep -f "collab-antigravity.*--name \\"${safeName}\\".*--channel.*${channelId}" 2>/dev/null || true`
    );
    if (!stdout.trim()) return 0;

    for (const line of stdout.trim().split('\n')) {
      const pid = parseInt(line.split(/\s+/)[0], 10);
      if (!pid || isNaN(pid)) continue;
      if (excludePid && pid === excludePid) continue;

      const cmdlineStr = await procCmdline(pid);
      if (!cmdlineStr.includes(safeName) || !cmdlineStr.includes(channelId)) {
        continue;
      }

      try {
        await execAsync(`kill -9 ${pid} 2>/dev/null`);
        killed++;
        await cleanupTempFiles(pid);
      } catch { /* already dead */ }
    }
  } catch { /* pgrep not found or other error */ }
  return killed;
}

/**
 * Get the project directory path where Claude stores session files.
 * Claude hashes the working directory: ~/Foo -> ~/.claude/projects/-home-<user>-Foo/
 */
function getProjectSessionDir(workingDirectory: string): string {
  const homeDir = getHomeDir();
  const projectDirName = workingDirectory.replace(/\//g, '-');
  return `${homeDir}/.claude/projects/${projectDirName}`;
}

/**
 * Get the Gemini session directory for a working directory.
 * Gemini CLI hashes the working directory with sha256:
 * ~/Foo -> ~/.gemini/tmp/<sha256>/chats/
 */
function getGeminiSessionDir(workingDirectory: string): string {
  const homeDir = getHomeDir();
  const hash = createHash('sha256').update(workingDirectory).digest('hex');
  return `${homeDir}/.gemini/tmp/${hash}/chats`;
}

/**
 * Get the Codex session directory for today (date-based: ~/.codex/sessions/YYYY/MM/DD/).
 */
function getCodexSessionDir(): string {
  const homeDir = getHomeDir();
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${homeDir}/.codex/sessions/${y}/${m}/${d}`;
}

/**
 * Get the Antigravity session directory (flat: ~/.gemini/antigravity-cli/conversations/).
 */
function getAntigravitySessionDir(): string {
  const homeDir = getHomeDir();
  return `${homeDir}/.gemini/antigravity-cli/conversations`;
}

/**
 * Get the appropriate session directory based on agent model/type.
 */
function getSessionDir(workingDirectory: string, agentModel?: string, agentType?: string): string {
  if (agentType === 'codex') {
    return getCodexSessionDir();
  }
  if (agentType === 'antigravity') {
    return getAntigravitySessionDir();
  }
  if (agentModel?.toLowerCase().startsWith('gemini')) {
    return getGeminiSessionDir(workingDirectory);
  }
  return getProjectSessionDir(workingDirectory);
}

/**
 * Get the session file extension for the agent model/type.
 */
function getSessionFileExt(agentModel?: string, agentType?: string): string {
  // Codex uses .jsonl; Antigravity uses .json; Gemini uses .json; Claude uses .jsonl
  if (agentType === 'codex') return '.jsonl';
  if (agentType === 'antigravity') return '.json';
  return agentModel?.toLowerCase().startsWith('gemini') ? '.json' : '.jsonl';
}

/**
 * Snapshot existing session files in the project directory.
 * Call BEFORE spawning an agent, then pass to captureClaudeSessionId
 * to reliably detect the new session file via diff.
 */
export async function snapshotSessionFiles(workingDirectory: string, agentModel?: string, agentType?: string): Promise<Set<string>> {
  const sessionDir = getSessionDir(workingDirectory, agentModel, agentType);
  const ext = getSessionFileExt(agentModel, agentType);
  const files = new Set<string>();
  try {
    const { stdout } = await execAsync(
      `ls -1 "${sessionDir}"/*${ext} 2>/dev/null || true`
    );
    for (const f of stdout.trim().split('\n').filter(Boolean)) {
      const name = f.split('/').pop()?.replace(ext, '');
      if (name) files.add(name);
    }
  } catch { /* directory may not exist yet */ }
  return files;
}

/**
 * Capture the session ID for a given working directory.
 * Supports both Claude (.jsonl in ~/.claude/projects/) and Gemini (.json in ~/.gemini/tmp/<hash>/chats/).
 *
 * Uses three strategies in priority order:
 * 1. Pre-spawn snapshot diff (most reliable) — compare files before/after spawn
 * 2. Recursive process tree lsof (3 levels deep) — find open session files
 * 3. Newest file fallback — find the most recently modified session file
 */
export async function captureClaudeSessionId(
  workingDirectory: string,
  pid?: number,
  preSpawnFiles?: Set<string>,
  excludeIds?: Set<string>,
  agentModel?: string,
  agentType?: string,
): Promise<string | null> {
  try {
    const sessionDir = getSessionDir(workingDirectory, agentModel, agentType);
    const ext = getSessionFileExt(agentModel, agentType);
    const isGemini = agentModel?.toLowerCase().startsWith('gemini');
    // Gemini session names are ~35 chars (session-2026-02-16T15-23-67a70562), Claude UUIDs are 36
    const minNameLength = isGemini ? 20 : 30;

    // Strategy 1: Diff against pre-spawn snapshot (most reliable)
    // Find session files that appeared AFTER the spawn
    if (preSpawnFiles) {
      try {
        const { stdout } = await execAsync(
          `ls -1 "${sessionDir}"/*${ext} 2>/dev/null || true`
        );
        const currentFiles = stdout.trim().split('\n').filter(Boolean);
        const newFiles: string[] = [];
        for (const f of currentFiles) {
          const name = f.split('/').pop()?.replace(ext, '');
          if (name && name.length > minNameLength && !preSpawnFiles.has(name) && !excludeIds?.has(name)) {
            newFiles.push(name);
          }
        }
        if (newFiles.length === 1) {
          return newFiles[0];
        }
        if (newFiles.length > 1) {
          // Multiple new files — pick the most recently modified one
          let newest: string | null = null;
          let newestMtime = 0;
          for (const name of newFiles) {
            try {
              const stat = await fs.stat(`${sessionDir}/${name}${ext}`);
              if (stat.mtimeMs > newestMtime) {
                newestMtime = stat.mtimeMs;
                newest = name;
              }
            } catch { /* skip */ }
          }
          if (newest) {
            return newest;
          }
        }
      } catch { /* fall through */ }
    }

    // Strategy 2: Recursive process tree traversal (3 levels deep)
    // Process tree: tmux pane (bash) → python3 wrapper → agent → subprocesses
    if (pid) {
      const sessionId = await findSessionFileInProcessTree(pid, sessionDir, 3, ext);
      if (sessionId && !excludeIds?.has(sessionId)) {
        return sessionId;
      }
    }

    // Strategy 3: Find the most recently modified session file (excluding already-claimed IDs)
    // Less reliable with multiple agents in the same directory, but works as fallback
    if (workingDirectory) {
      try {
        // Get multiple candidates so we can skip excluded ones
        const { stdout } = await execAsync(
          `ls -1t "${sessionDir}"/*${ext} 2>/dev/null | head -5`
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const name = line.split('/').pop()?.replace(ext, '');
          if (name && name.length > minNameLength && !excludeIds?.has(name)) {
            const stat = await fs.stat(`${sessionDir}/${name}${ext}`);
            if (Date.now() - stat.mtimeMs < 30_000) {
              return name;
            }
          }
        }
      } catch { /* ignore */ }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Recursively search a process tree for open session files.
 * Traverses up to `maxDepth` levels of child processes.
 * Supports both Claude (.jsonl) and Gemini (.json) session files.
 */
async function findSessionFileInProcessTree(
  pid: number,
  sessionDir: string,
  maxDepth: number,
  ext: string = '.jsonl',
): Promise<string | null> {
  if (maxDepth <= 0) return null;

  // Check this PID's open files
  try {
    const { stdout: lsofOut } = await execAsync(
      `lsof -p ${pid} 2>/dev/null | grep '${sessionDir}' | grep '${ext}' | awk '{print $NF}' | head -1`
    );
    if (lsofOut.trim()) {
      const sessionId = lsofOut.trim().split('/').pop()?.replace(ext, '');
      if (sessionId && sessionId.length > 20) {
        return sessionId;
      }
    }
  } catch { /* lsof may fail */ }

  // Recurse into child processes
  try {
    const { stdout: childPids } = await execAsync(
      `pgrep -P ${pid} 2>/dev/null || true`
    );
    for (const childPid of childPids.trim().split('\n').filter(Boolean)) {
      const result = await findSessionFileInProcessTree(
        parseInt(childPid, 10),
        sessionDir,
        maxDepth - 1,
        ext,
      );
      if (result) return result;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Get tmux session name for a PTY session
 */
export function getTmuxSessionName(sessionId: string): string | null {
  const data = activeSessions.get(sessionId);
  return data?.tmuxSessionName || null;
}

/**
 * Get the roster agent ID linked to a PTY session
 */
export function getRosterAgentIdForSession(sessionId: string): string | undefined {
  return activeSessions.get(sessionId)?.rosterAgentId;
}

// ============================================
// Background Session Pruning (Fix 2)
// ============================================

/**
 * Remove sessions whose PIDs are no longer alive.
 * Runs every 60 seconds to keep collab-pty-sessions.json lean.
 */
async function pruneDeadSessions(): Promise<void> {
  const data = await readSessionsData();
  const before = data.sessions.length;

  const alive: CollabPtySession[] = [];
  for (const session of data.sessions) {
    if (session.status === 'closed') continue; // Skip — closed entries shouldn't exist long
    const pidAlive = session.pid ? await isPidAlive(session.pid) : false;
    // Sessions on another machine carry no local pid; the host's own session list decides their fate.
    if (pidAlive || (!session.pid && defaultHost())) {
      alive.push(session);
    }
  }

  if (alive.length < before) {
    data.sessions = alive;
    await writeSessionsData(data);
  }
}

/**
 * Start the 60-second background session prune loop.
 */
function startSessionPruning(): void {
  if (sessionPruneInterval) return;
  sessionPruneInterval = setInterval(async () => {
    try {
      await pruneDeadSessions();
      await sweepStaleCollabFiles();
    } catch (err) {
      console.error('[PTY] Session prune error:', err);
    }
  }, 60_000);
}

// ============================================
// Crash Detection
// ============================================

/**
 * Start the crash detection polling loop.
 * Checks every 30s if tmux sessions for roster agents are still alive.
 */
export function startCrashDetection(): void {
  if (crashMonitor.interval) return; // Already running (in any bundled copy)

  crashMonitor.interval = setInterval(async () => {
    try {
      await detectCrashedAgents();
      await detectOrphanedAgents();
      await reconcileStoppedAgents();
    } catch (err) {
      console.error('[PTY] Crash detection error:', err);
    }
  }, CRASH_DETECT_INTERVAL_MS);
}

/**
 * Stop crash detection polling
 */
export function stopCrashDetection(): void {
  if (crashMonitor.interval) {
    clearInterval(crashMonitor.interval);
    crashMonitor.interval = null;
  }
}

/**
 * Check all roster agents for crashes.
 * If a tmux session is dead, updates roster status to 'crashed'
 * and writes a diagnostic crash report from pipe-pane logs.
 */
async function detectCrashedAgents(): Promise<void> {
  const DEFAULT_CHANNELS_DATA: CollabChannelsData = { channels: [], lastUpdated: new Date().toISOString() };
  // Work on private copies: the pass awaits tmux checks and crash reports for
  // seconds, so it must not write this snapshot back over what other handlers
  // saved meanwhile (see commitPassChanges).
  const channelsData = structuredClone(await readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA));
  const baseline = structuredClone(channelsData);

  let modified = false;

  for (const channel of channelsData.channels) {
    if (!channel.roster?.agents?.length) continue;

    for (const agent of channel.roster.agents) {
      // Windows per-message sessions: check if they're still tracked in activeSessions
      if (agent.status === 'running' && isWindowsPerMessageAgent(agent) && agent.ptySessionId) {
        const sessionData = activeSessions.get(agent.ptySessionId);
        if (!sessionData) {
          // Session lost (e.g., server restart) — mark as stopped so user can respawn
          agent.status = 'stopped';
          agent.lastStoppedAt = new Date().toISOString();
          modified = true;
        }
        continue;
      }

      // A graceful shutdown/restart whose final stop never ran (dashboard page
      // closed mid-countdown) leaves a live agent 'shutting-down'/'restarting'
      // indefinitely; Codex delivery then refuses it every message. Past the
      // grace window, a still-alive agent is simply running again.
      if ((agent.status === 'shutting-down' || agent.status === 'restarting') && agent.tmuxSessionName) {
        const since = agent.statusChangedAt ? Date.parse(agent.statusChangedAt) : 0;
        if (Date.now() - since > STALE_TRANSITION_MS && await tmuxSessionExists(agent.tmuxSessionName)) {
          logEvent('agent', 'medium', `${agent.name} was left '${agent.status}' but is still running; restored to running`, {
            event: 'stale-transition-restored', agentName: agent.name, channelId: channel.id, previousStatus: agent.status,
          }).catch(() => {});
          agent.status = 'running';
          agent.statusChangedAt = undefined;
          modified = true;
        }
        continue;
      }

      // Check running AND away agents — away agents may crash while serving another channel.
      // Respawn target is always the home channel (channel.id) regardless of where they crashed.
      if ((agent.status === 'running' || agent.status === 'away') && agent.tmuxSessionName) {
        const wasAway = agent.status === 'away';
        // Check if tmux session is still alive
        const alive = await tmuxSessionExists(agent.tmuxSessionName);
        if (!alive) {
          logEvent('agent', 'high', `[PTY] Agent crash detected: ${agent.name}`, {
            agentName: agent.name,
            tmuxSession: agent.tmuxSessionName,
            wasAway,
            awayChannel: wasAway ? (agent.awayInChannelName || agent.awayInChannelId) : undefined,
            channelId: channel.id,
          }).catch(() => {});

          // Sub-agent reaper: kill orphaned child processes before clearing PID
          const agentHost = hostFor(agent);
          if (agent.pid && agent.pid > 1 && !agentHost) {
            try {
              const { stdout: children } = await execAsync(
                `ps --ppid ${agent.pid} -o pid= 2>/dev/null || true`
              );
              const childPids = children.trim().split('\n')
                .map(p => parseInt(p.trim(), 10))
                .filter(p => !isNaN(p) && p > 1);
              for (const childPid of childPids) {
                try { process.kill(childPid, 'SIGTERM'); } catch { /* already dead */ }
              }
            } catch {
              // Process tree lookup failed — non-fatal
            }
          }

          agent.status = 'stopped';
          agent.crashCount = (agent.crashCount || 0) + 1;
          agent.lastStoppedAt = new Date().toISOString();
          agent.pid = undefined;
          // Clear away tracking if the agent crashed while visiting another channel
          if (wasAway) {
            agent.awayInChannelId = undefined;
            agent.awayInChannelName = undefined;
          }

          // Fix 4: Remove the corresponding PTY session entry from file
          if (agent.ptySessionId) {
            removeSessionFromFile(agent.ptySessionId).catch(err => {
              console.error(`[PTY] Failed to remove PTY session ${agent.ptySessionId} for crashed agent "${agent.name}":`, err);
            });
          }

          // Emit lifecycle log entry for crash
          logEvent('agent', 'critical', `${agent.name} crashed (exit #${agent.crashCount})`, {
            event: 'crash',
            agentName: agent.name,
            channelId: channel.id,
            channelName: channel.name,
            tmuxSession: agent.tmuxSessionName,
            crashCount: agent.crashCount,
            systemMemAvailMB: (agentHost ? hostMemFreeMB(agentHost) : null) ?? Math.round(os.freemem() / 1024 / 1024),
          }).catch(() => {});

          // Crash correlation: check for mass-crash incident
          recordCrashForCorrelation(agent.name, channel.id);

          // Write crash report with pipe-pane log output
          let reportPath = '';
          let lastLines = '';
          try {
            reportPath = await writeCrashReport(agent, channel.id, channel.name);
            // Read back the last few lines for the channel message
            const report = JSON.parse(await fs.readFile(reportPath, 'utf-8'));
            const outputLines = (report.lastOutput || '').split('\n');
            lastLines = outputLines.slice(-10).join('\n').trim();
          } catch (reportErr) {
            console.error(`[PTY] Failed to write crash report for ${agent.name}:`, reportErr);
          }

          // Auto-respawn for transient crashes (compaction, OOM, tmux issues).
          // crashCount resets on successful start, so this is "consecutive crashes
          // without a successful boot" — 5 rapid-fire crashes = something is truly broken.
          // During low memory, skip auto-respawn entirely to prevent death spiral.
          const MAX_AUTO_RESPAWN = 5;
          const memAvailMB = (agentHost ? hostMemFreeMB(agentHost) : null) ?? Math.round(os.freemem() / 1024 / 1024);
          const memoryOk = memAvailMB >= RESPAWN_MIN_MEMORY_MB;
          const willAutoRespawn = memoryOk && (agent.crashCount || 0) <= MAX_AUTO_RESPAWN;

          // Post system message in channel with diagnostic excerpt
          const excerptBlock = lastLines
            ? `\n\nLast output:\n\`\`\`\n${lastLines}\n\`\`\``
            : '\n\n(No output captured — pipe-pane log missing)';
          const crashMessage = {
            id: randomUUID(),
            channelId: channel.id,
            from: {
              id: 'system',
              type: 'user' as const,
              name: 'System',
              source: 'DevFlow',
              joinedAt: new Date().toISOString(),
              lastSeen: new Date().toISOString(),
            },
            content: `Agent "${agent.name}" exited (exit #${agent.crashCount}, detected at ${new Date().toLocaleTimeString()}).${reportPath ? ` Full report: ${reportPath}` : ''}${excerptBlock}\n\n${willAutoRespawn ? 'Auto-respawning...' : 'Right-click to respawn.'}`,
            timestamp: new Date().toISOString(),
          };
          channel.messages.push(crashMessage);
          channel.roster.lastUpdated = new Date().toISOString();
          modified = true;

          // Trigger auto-respawn via a staggered queue (prevents thundering herd).
          // When tmux crashes, all agents die simultaneously. Without stagger,
          // N parallel respawns saturate CPU/IO and cause cascading failures.
          if (willAutoRespawn) {
            const agentId = agent.id;
            const channelId = channel.id;
            logEvent('agent', 'info', `${agent.name} respawning (auto, exit #${agent.crashCount})`, {
              event: 'respawn',
              agentName: agent.name,
              channelId: channel.id,
              channelName: channel.name,
              crashCount: agent.crashCount,
              trigger: 'auto-respawn',
            }).catch(() => {});
            // Last heartbeat before the exit is the best shutdown time; the
            // detector may only notice much later (e.g. after a DevFlow restart).
            const lastSeen = channel.participants?.find(p => p.id === agent.participantId)?.lastSeen;
            const shutdownAt = lastSeen && !Number.isNaN(Date.parse(lastSeen)) ? lastSeen : new Date().toISOString();
            enqueueRespawn({ channelId, agentId, agentName: agent.name, shutdownAt, crashedSession: agent.tmuxSessionName });
            // Kick off the drain loop (no-op if already running)
            drainRespawnQueue().catch(err => {
              console.error(`[PTY] Respawn queue drain error:`, err);
            });
          }
        }
      }

      // Timeout agents stuck in "starting" status
      if (agent.status === 'starting' && agent.lastStartedAt) {
        const startedAge = Date.now() - new Date(agent.lastStartedAt).getTime();
        if (startedAge > STARTING_TIMEOUT_MS) {
          agent.status = 'stopped';
          agent.crashCount = (agent.crashCount || 0) + 1;
          agent.lastStoppedAt = new Date().toISOString();

          // Chrome agents: skip the crash report (the spawn catch block already
          // handles channel messaging via the chrome circuit-breaker logic).
          // Writing a crash report here would just add noise with no output to show.
          const isChrome = (agent.claudeFlags || []).includes('--chrome');
          if (!isChrome) {
            logEvent('agent', 'critical', `${agent.name} stuck in starting state (timeout)`, {
              event: 'crash',
              agentName: agent.name,
              channelId: channel.id,
              channelName: channel.name,
              crashCount: agent.crashCount,
              error: 'Starting state timeout',
            }).catch(() => {});
            try {
              await writeCrashReport(agent, channel.id, channel.name);
            } catch {}
          }

          channel.roster.lastUpdated = new Date().toISOString();
          modified = true;
        }
      }
    }
  }

  if (modified) {
    await commitPassChanges('Crash detection', baseline, channelsData);
  }
}

/**
 * Persist a monitor pass's roster changes onto the current channel file instead
 * of writing back the snapshot it read, which reverted whatever other handlers
 * saved while the pass awaited tmux checks and crash reports. An agent whose
 * fields changed meanwhile is left for the next pass.
 */
async function commitPassChanges(
  pass: string,
  baseline: CollabChannelsData,
  changed: CollabChannelsData,
): Promise<void> {
  const report = await commitMonitorChanges(`pty-${pass.toLowerCase().replace(/\s+/g, '-')}`, baseline, changed);
  if (report.skipped.length > 0) {
    console.warn(
      `[PTY] ${pass}: ${report.skipped.length} roster update(s) changed concurrently and were left for the next pass: ` +
      report.skipped.map(item => `${item.agentId.slice(0, 8)} (${item.fields.join(', ')})`).join('; '),
    );
  }
}

// ============================================
// Orphan Detection
// ============================================

/**
 * Scan all channels for the same agent appearing as 'running' in multiple channels
 * simultaneously. This catches the PID-reuse bug and stuck roster entries.
 * - Dead tmux sessions are marked stopped (no respawn — crash detector handles those).
 * - If 2+ sessions are alive, keep the newest (by lastStartedAt) and kill the rest.
 */
async function detectOrphanedAgents(): Promise<void> {
  const DEFAULT_CHANNELS_DATA: CollabChannelsData = { channels: [], lastUpdated: new Date().toISOString() };
  const channelsData = structuredClone(await readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA));
  const baseline = structuredClone(channelsData);

  type Entry = { channelId: string; channelName: string; agent: AgentRosterEntry };
  const byName = new Map<string, Entry[]>();

  for (const channel of channelsData.channels) {
    if (!channel.roster?.agents?.length) continue;
    for (const agent of channel.roster.agents) {
      // Only WSL tmux agents — powershell agents are tracked separately
      if (agent.status === 'running' && agent.tmuxSessionName && !isWindowsPerMessageAgent(agent)) {
        // Key by name + workingDirectory to distinguish same-named agents across different teams/projects
        // "Jack" in SG-1 (~/SG-1) and "Jack" in AcmeMedia (~/AM) are separate agents
        const key = `${agent.name}::${agent.workingDirectory || ''}`;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key)!.push({ channelId: channel.id, channelName: channel.name, agent });
      }
    }
  }

  let modified = false;

  for (const [agentKey, entries] of byName) {
    if (entries.length <= 1) continue; // Single entry — no orphan possible
    const agentName = entries[0].agent.name;

    // Check all tmux sessions in parallel
    const checked = await Promise.all(
      entries.map(async e => ({ e, alive: await tmuxSessionExists(e.agent.tmuxSessionName!) }))
    );

    // Dead sessions are orphans — mark stopped (crash detector may have missed these)
    for (const { e, alive } of checked) {
      if (!alive) {
        e.agent.status = 'stopped';
        e.agent.lastStoppedAt = new Date().toISOString();
        modified = true;
      }
    }

    // If 2+ sessions are still alive, keep the newest; kill older orphans
    const stillAlive = checked.filter(c => c.alive);
    if (stillAlive.length > 1) {
      stillAlive.sort((a, b) =>
        new Date(b.e.agent.lastStartedAt || '1970').getTime() -
        new Date(a.e.agent.lastStartedAt || '1970').getTime()
      );
      const [, ...orphans] = stillAlive;
      for (const { e } of orphans) {
        try {
          await tmuxRun(['kill-session', '-t', validateTmuxName(e.agent.tmuxSessionName!)]);
        } catch { /* already dead */ }
        e.agent.status = 'stopped';
        e.agent.lastStoppedAt = new Date().toISOString();
        modified = true;
      }
    }
  }

  if (modified) {
    await commitPassChanges('Orphan detection', baseline, channelsData);
  }
}

// ============================================
// Existing API (unchanged signatures)
// ============================================

/**
 * Get all active PTY sessions for a channel
 */
export function getChannelPtySessions(channelId: string): CollabPtySession[] {
  const sessions: CollabPtySession[] = [];
  for (const [, data] of activeSessions) {
    if (data.session.channelId === channelId) {
      sessions.push(data.session);
    }
  }
  return sessions;
}

/**
 * Get a specific PTY session
 */
export function getPtySession(sessionId: string): CollabPtySession | undefined {
  return activeSessions.get(sessionId)?.session;
}

/**
 * Check if a PTY session is active
 */
export function isPtySessionActive(sessionId: string): boolean {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) return false;

  // Windows per-message agents have no tmux session — session liveness is tracked by activeSessions only
  if (sessionData.backend === 'windows-pm') return true;

  // Also verify tmux session still exists (sync check is acceptable here — called from non-critical path)
  try {
    const { execFileSync } = require('child_process');
    execFileSync('tmux', ['has-session', '-t', validateTmuxName(sessionData.tmuxSessionName)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all active PTY sessions
 */
export function getAllActivePtySessions(): CollabPtySession[] {
  const sessions: CollabPtySession[] = [];
  for (const [, data] of activeSessions) {
    sessions.push(data.session);
  }
  return sessions;
}

/**
 * Clean up stale sessions (called on server startup)
 * Also resets all roster agents to 'stopped' since tmux sessions don't survive WSL restart
 */
export async function cleanupStaleSessions(): Promise<void> {
  const data = await readSessionsData();

  // Kill any orphaned tmux sessions from previous runs
  try {
    const { stdout } = await execAsync(`tmux list-sessions -F "#{session_name}" 2>/dev/null`);
    const tmuxSessions = stdout.trim().split('\n').filter(s => s.startsWith(TMUX_SESSION_PREFIX));

    for (const tmuxSession of tmuxSessions) {
      // Check if the session has live processes before killing it.
      // This prevents DevFlow restart from mass-killing healthy agent sessions.
      try {
        const { stdout: paneOutput } = await execAsync(
          `tmux list-panes -t ${tmuxSession} -F '#{pane_pid}' 2>/dev/null`
        );
        const panePids = paneOutput.trim().split('\n').filter(Boolean);
        let hasLiveProcess = false;
        for (const panePid of panePids) {
          if (await procIsPidAlive(panePid.trim())) {
            hasLiveProcess = true;
            break;
          }
        }
        if (hasLiveProcess) {
          continue;
        }
      } catch (error) {
        logEvent('agent', 'low', '[PTY] Failed to check pane PIDs during orphan cleanup', { tmuxSession, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
        emitAgentError(error, 'collab-pty/cleanupOrphanSessions', { severity: 'low', context: { tmuxSession } });
      }
      await execAsync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`).catch(() => {});
    }
  } catch {
    // No tmux sessions running
  }

  // Fix 1 + 3: Remove all closed sessions and sessions with dead PIDs immediately.
  // Do NOT just mark closed — call removeSessionFromFile for each dead session.
  // This prevents zombie accumulation across restarts.
  const deadIds: string[] = [];
  for (const session of data.sessions) {
    if (session.status === 'closed') {
      // Already closed — remove it (Fix 1: don't keep closed sessions in file)
      deadIds.push(session.id);
      continue;
    }
    // Check if the associated PID is still alive (Fix 3: prune dead PIDs on startup)
    const pidAlive = session.pid ? await isPidAlive(session.pid) : false;
    if (!pidAlive && !(!session.pid && defaultHost())) {
      deadIds.push(session.id);
    }
  }

  if (deadIds.length > 0) {
    data.sessions = data.sessions.filter(s => !deadIds.includes(s.id));
  }

  await writeSessionsData(data);

  // Reset all roster agents to 'stopped'
  await mutateChannels('pty-startup:reset-roster-after-restart', async channelsData => {
    let modified = false;

    for (const channel of channelsData.channels) {
      if (channel.roster?.agents?.length) {
        for (const agent of channel.roster.agents) {
          // Agents on another machine keep running through a DevFlow restart; crash detection checks them against that machine's own session list.
          if (hostFor(agent)) continue;
          if (agent.status === 'running' || agent.status === 'starting' || agent.status === 'restarting' || agent.status === 'shutting-down') {
            agent.status = 'stopped';
            agent.pid = undefined;
            agent.tmuxSessionName = undefined;
            agent.ptySessionId = undefined;
            modified = true;
          }
        }
        if (modified) {
          channel.roster.lastUpdated = new Date().toISOString();
        }
      }
    }

    if (modified) {
      await saveChannels(channelsData);
      logEvent('agent', 'info', '[PTY] Reset roster agents to stopped after server restart').catch(() => {});
    }
  });

  // Sweep all stale collab files (session, ready, invite) from /tmp/
  await sweepStaleCollabFiles();

  // Start crash detection and background session pruning
  startCrashDetection();
  startSessionPruning();
}

export interface DetachResult {
  success: boolean;
  contextFile?: string;
  command?: string;
  error?: string;
}

/**
 * Detach a PTY session for continuation in a real terminal
 * Returns the tmux attach command
 */
export async function detachPtySession(
  sessionId: string,
  channelMessages: Array<{ from: { name: string }; content: string; timestamp: string }>
): Promise<DetachResult> {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) {
    return { success: false, error: 'PTY session not found' };
  }

  const { tmuxSessionName } = sessionData;

  // Verify session still exists
  const exists = await tmuxSessionExists(tmuxSessionName);
  if (!exists) {
    return { success: false, error: 'tmux session no longer exists' };
  }

  // Stop polling but keep tmux session alive
  if (sessionData.pollInterval) {
    clearInterval(sessionData.pollInterval);
  }

  // Remove from active sessions (but don't kill tmux)
  activeSessions.delete(sessionId);

  const attachCommand = `tmux attach -t ${tmuxSessionName}`;

  return {
    success: true,
    command: attachCommand,
  };
}

/**
 * Startup recovery: reset agents stuck in 'starting' status with no live tmux session.
 * Called once during server startup to fix agents whose second-phase withFileLock
 * (status → running) never completed (e.g. crash, deadlock, or PM2 restart).
 */
export async function recoverStartingAgents(): Promise<{ reset: number }> {
  let resetCount = 0;
  try {
    await mutateChannels('pty-startup:recover-starting-agents', async data => {
      const now = new Date().toISOString();

      for (const channel of data.channels) {
        if (!channel.roster) continue;
        for (const agent of channel.roster.agents) {
          if (agent.status !== 'starting') continue;
          const alive = agent.tmuxSessionName ? await tmuxSessionExists(agent.tmuxSessionName) : false;
          if (!alive) {
            agent.status = 'stopped';
            agent.pid = undefined;
            agent.tmuxSessionName = undefined;
            agent.ptySessionId = undefined;
            channel.roster.lastUpdated = now;
            resetCount++;
          }
        }
      }

      if (resetCount > 0) {
        await saveChannels(data);
      }
    });
  } catch {
    // best-effort — don't block startup
  }
  return { reset: resetCount };
}
