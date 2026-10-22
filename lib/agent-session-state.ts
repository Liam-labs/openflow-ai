/**
 * Agent session-state inspection helpers.
 *
 * Sprint 38 T4.4 — busy-agent guard for the auto-compact flow.
 *
 * Derives an agent's project-key directory from its workingDirectory (same
 * convention as flush.sh: `/` → `-`), finds the most recently modified
 * `.jsonl` session log in `$HOME/.claude/projects/<key>/`, reads the last
 * parseable entry's timestamp, and computes how many seconds have passed.
 *
 * Consumers:
 *   - T4.3 (Daniel) `sprints.complete` auto-compact hook: call
 *     `isAgentIdleForCompact` before sending `/flush-journal` + `/compact`
 *     via tmux-send. Skip agents whose last JSONL activity is <30s old
 *     (mid-tool-use / actively generating).
 *
 * Design:
 *   - Pure functions. All I/O lives behind an injectable `opts` parameter
 *     so tests can point at a sandbox HOME and a fixed `now` clock.
 *   - Conservative on every error path: missing dir, missing jsonl, empty
 *     file, corrupt last line, clock skew — all return `idle=false` so the
 *     caller skips the compact. Compacting the wrong agent is worse than
 *     skipping it.
 *   - Walks backwards past corrupt / timestamp-less entries, up to 50 lines
 *     back, before giving up.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getHomeDir } from '@/lib/home-dir';
const DEFAULT_IDLE_THRESHOLD_SECONDS = 120;
const MAX_BACKWARD_LINES = 50;

export interface AgentStateOptions {
  /**
   * Override `$HOME` for test sandboxing. Defaults to `process.env.HOME`.
   */
  home?: string;
  /**
   * Override the current time for deterministic testing. Defaults to
   * `new Date()`.
   */
  now?: Date;
}

export interface AgentLastActivity {
  timestamp: string;
  path: string;
}

export interface AgentIdleSeconds {
  idleSeconds: number;
  path: string;
}

export interface AgentBusyCheckResult {
  idle: boolean;
  idleSeconds: number | null;
  reason?: string;
  jsonlPath?: string;
}

/**
 * Convert an absolute agent working directory into the Claude Code project
 * key used under `$HOME/.claude/projects/<key>/`. Matches flush.sh's
 * convention exactly: every `/` becomes `-`.
 *
 * Example: `~/SG-1/Team/an agent` → `-home-<user>-SG-1-Team-an agent`.
 */
export function deriveAgentProjectKey(agentDir: string): string {
  // Claude Code replaces both '/' and ' ' with '-' when creating project dirs.
  return agentDir.replace(/[\/ ]/g, '-');
}

function resolveHome(opts?: AgentStateOptions): string {
  return opts?.home ?? getHomeDir();
}

function resolveNow(opts?: AgentStateOptions): Date {
  return opts?.now ?? new Date();
}

/**
 * Parse a single JSONL line and return its `timestamp` field, or null if
 * the line is corrupt, missing, or has no timestamp.
 */
function extractTimestamp(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { timestamp?: unknown };
    if (typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0) {
      return parsed.timestamp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Return the most recently modified `.jsonl` file in a project-key session
 * directory, or null if none exist.
 */
async function findMostRecentJsonl(sessionDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir);
  } catch {
    return null;
  }

  const jsonlNames = entries.filter((name) => name.endsWith('.jsonl'));
  if (jsonlNames.length === 0) return null;

  let latestPath: string | null = null;
  let latestMtime = -Infinity;
  for (const name of jsonlNames) {
    const p = join(sessionDir, name);
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latestPath = p;
      }
    } catch {
      // Skip unreadable file
    }
  }
  return latestPath;
}

/**
 * Walk the lines of a JSONL file backwards from the end, returning the first
 * timestamp found. Skips corrupt / timestamp-less lines up to
 * MAX_BACKWARD_LINES back.
 */
async function lastTimestampInJsonl(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch {
    return null;
  }
  if (!raw) return null;

  // Split, drop trailing empty lines.
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) return null;

  const start = Math.max(0, lines.length - MAX_BACKWARD_LINES);
  for (let i = lines.length - 1; i >= start; i--) {
    const ts = extractTimestamp(lines[i]);
    if (ts) return ts;
  }
  return null;
}

/**
 * Look up the most recent activity timestamp for an agent based on its
 * working directory. Returns null if the session dir, jsonl, or parseable
 * entry cannot be found.
 */
export async function getAgentLastActivity(
  agentDir: string,
  opts?: AgentStateOptions,
): Promise<AgentLastActivity | null> {
  const home = resolveHome(opts);
  const projectKey = deriveAgentProjectKey(agentDir);
  const sessionDir = join(home, '.claude', 'projects', projectKey);

  if (!existsSync(sessionDir)) return null;

  const jsonlPath = await findMostRecentJsonl(sessionDir);
  if (!jsonlPath) return null;

  const timestamp = await lastTimestampInJsonl(jsonlPath);
  if (!timestamp) return null;

  return { timestamp, path: jsonlPath };
}

/**
 * Compute seconds since the agent's last JSONL entry. Returns null if no
 * activity is found. Clamped to 0 if the last entry is in the future
 * (clock skew).
 */
export async function getAgentIdleSeconds(
  agentDir: string,
  opts?: AgentStateOptions,
): Promise<AgentIdleSeconds | null> {
  const activity = await getAgentLastActivity(agentDir, opts);
  if (!activity) return null;

  const parsed = Date.parse(activity.timestamp);
  if (Number.isNaN(parsed)) return null;

  const now = resolveNow(opts).getTime();
  const diffMs = now - parsed;
  const idleSeconds = Math.max(0, Math.floor(diffMs / 1000));
  return { idleSeconds, path: activity.path };
}

/**
 * Guard for the auto-compact flow. Returns `idle: true` only when the
 * agent's last JSONL activity is at least `thresholdSeconds` old AND the
 * timestamp is not in the future (clock skew → conservative skip).
 *
 * Every other case (no session dir, no jsonl, empty file, corrupt last
 * line, future timestamp) returns `idle: false` with a `reason` string,
 * so the caller can log why the compact was skipped.
 */
export async function isAgentIdleForCompact(
  agentDir: string,
  thresholdSeconds: number | undefined = DEFAULT_IDLE_THRESHOLD_SECONDS,
  opts?: AgentStateOptions,
): Promise<AgentBusyCheckResult> {
  const effectiveThreshold =
    thresholdSeconds === undefined ? DEFAULT_IDLE_THRESHOLD_SECONDS : thresholdSeconds;

  const activity = await getAgentLastActivity(agentDir, opts);
  if (!activity) {
    return {
      idle: false,
      idleSeconds: null,
      reason: 'no activity: no JSONL found for agent session dir',
    };
  }

  const parsed = Date.parse(activity.timestamp);
  if (Number.isNaN(parsed)) {
    return {
      idle: false,
      idleSeconds: null,
      reason: `unparseable timestamp: ${activity.timestamp}`,
      jsonlPath: activity.path,
    };
  }

  const now = resolveNow(opts).getTime();
  const diffMs = now - parsed;

  if (diffMs < 0) {
    // Last entry in the future — clock skew, don't trust it.
    return {
      idle: false,
      idleSeconds: 0,
      reason: `last entry timestamp is in the future (clock skew or negative delta)`,
      jsonlPath: activity.path,
    };
  }

  const idleSeconds = Math.floor(diffMs / 1000);

  if (idleSeconds < effectiveThreshold) {
    return {
      idle: false,
      idleSeconds,
      reason: `busy: last entry ${idleSeconds}s old, below ${effectiveThreshold}s threshold`,
      jsonlPath: activity.path,
    };
  }

  return {
    idle: true,
    idleSeconds,
    jsonlPath: activity.path,
  };
}
