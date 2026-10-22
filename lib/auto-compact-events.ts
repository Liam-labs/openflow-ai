/**
 * Sprint 38 T4.5 — auto-compact sweep event logger.
 *
 * Appends one JSONL entry per attempted compact (including skips and
 * errors) to `logs/auto-compact-events.jsonl`. Consumers are sprint
 * post-mortems, T4.7 E2E verification, and the T6.2 measurement pass.
 *
 * Atomicity: a single event line is well under 4 KiB, so `fs.appendFile`
 * (O_APPEND under the hood) guarantees per-write atomicity on Linux per
 * `man 2 write`. Concurrent sweeps from different processes will
 * interleave whole lines, never bytes within a line.
 *
 * The module is pure I/O — the orchestrator stays agnostic of this
 * sink. The logger is wired in at the `sprints.complete` / `tasks.complete`
 * call sites where the sweep metadata (channelId, sprintId) is known.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { DataPaths } from '@/lib/data-paths';
import type {
  AutoCompactAgentResult,
  AutoCompactSweepResult,
} from '@/lib/auto-compact-orchestrator';

export interface AutoCompactEvent {
  /** ISO-8601 timestamp when the sweep ran. */
  timestamp: string;
  /** Channel the sweep ran against. */
  channelId: string;
  /** Sprint that triggered the sweep (omitted for tasks.complete flushes). */
  sprintId?: string;
  /** Roster entry id — stable across sessions. */
  agentId: string;
  /** Display name for humans. */
  agentName: string;
  /** Agent working directory (useful for debugging stale settings). */
  workingDirectory?: string;
  /** tmux target that received the send-keys, if any. */
  tmuxSessionName?: string;
  /** Resolution: compact fired, agent was skipped, or sweep errored for this agent. */
  status: 'compacted' | 'skipped' | 'error';
  /** Skip or error explanation. Omitted for status=compacted. */
  reason?: string;
  /** Seconds since agent's last JSONL write, from isAgentIdleForCompact. */
  idleSeconds?: number | null;
  /** Per-agent wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface BuildEventsMetadata {
  channelId: string;
  sprintId?: string;
  /**
   * Timestamp to stamp on every event. Defaults to `new Date().toISOString()`
   * at call time. Pass an explicit value in tests or to pin every event
   * from one sweep to the same moment.
   */
  timestamp?: string;
}

/**
 * Transform a sweep result + metadata into the AutoCompactEvent[] shape
 * suitable for `appendAutoCompactEvents`. Pure function — no I/O.
 */
export function buildEventsFromSweep(
  sweep: AutoCompactSweepResult,
  metadata: BuildEventsMetadata,
): AutoCompactEvent[] {
  const timestamp = metadata.timestamp ?? new Date().toISOString();
  return sweep.perAgent.map((r: AutoCompactAgentResult) => {
    const base: AutoCompactEvent = {
      timestamp,
      channelId: metadata.channelId,
      agentId: r.agentId,
      agentName: r.name,
      workingDirectory: r.workingDirectory,
      tmuxSessionName: r.tmuxSessionName,
      status: r.action,
      durationMs: r.durationMs,
    };
    if (metadata.sprintId) base.sprintId = metadata.sprintId;
    if (r.reason) base.reason = r.reason;
    if (r.idleSeconds !== undefined) base.idleSeconds = r.idleSeconds;
    return base;
  });
}

/**
 * Append a batch of events to the JSONL log. Creates the parent
 * directory and file if missing. No-op on empty input.
 */
export async function appendAutoCompactEvents(
  events: AutoCompactEvent[],
  path: string = DataPaths.autoCompactEvents,
): Promise<void> {
  if (events.length === 0) return;
  await fs.mkdir(dirname(path), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(path, lines, 'utf-8');
}

/**
 * Read every event from the log. Returns `[]` if the file does not
 * exist. Silently skips corrupt / unparseable lines so a single bad
 * write cannot poison the reader.
 */
export async function readAutoCompactEvents(
  path: string = DataPaths.autoCompactEvents,
): Promise<AutoCompactEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const events: AutoCompactEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as AutoCompactEvent);
    } catch {
      // skip corrupt line
    }
  }
  return events;
}
