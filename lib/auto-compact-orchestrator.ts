/**
 * Sprint 38 T4.3 — auto-compact orchestrator for sprints.complete.
 *
 * Fires a `/flush-journal` → wait → `/compact` sequence against every
 * eligible running agent in a roster, after a sprint has been marked
 * complete. The mechanism is tmux `send-keys`, empirically proven in
 * T4.2 to be indistinguishable from a human-typed slash command.
 *
 * Key invariants captured from an agent's T4.1/T4.2/T4.4 handoff:
 *
 *   - The busy-agent guard is called EXACTLY ONCE per running agent —
 *     immediately before the flush-journal fire — and is NOT re-checked
 *     between flush and compact. The ~3-second delay from guard to
 *     compact is short enough that a busy agent has effectively zero
 *     chance of slipping through. Monotonic delay works in our favour.
 *
 *   - Stagger (default 10s) separates successful compact fires only.
 *     No leading stagger before the first compact, no trailing stagger
 *     after the last. Skipped or errored agents do not trigger a stagger.
 *
 *   - Errors on any single agent do not abort the sweep; the orchestrator
 *     records the error and continues with the next agent.
 *
 *   - Non-running status or missing tmuxSessionName → skipped with a
 *     reason, guard is not called for these.
 *
 * The module is designed to be fully testable without real tmux /
 * filesystem access: all I/O is behind the `AutoCompactOpts` interface.
 * The caller wires real implementations (agent-session-state.ts,
 * child_process.exec, setTimeout) in production.
 */

import type { AgentRosterEntry } from '@/lib/types';
import type { AgentBusyCheckResult } from '@/lib/agent-session-state';

export interface AutoCompactAgentResult {
  name: string;
  workingDirectory: string;
  tmuxSessionName?: string;
  action: 'compacted' | 'skipped' | 'error';
  reason?: string;
  idleSeconds?: number | null;
  /**
   * Wall-clock milliseconds this agent spent inside the sweep loop.
   * Covers everything from the guard call through the final sendKeys
   * (or the skip decision). Never includes the inter-agent stagger.
   */
  durationMs: number;
  /**
   * Stable roster entry id (`AgentRosterEntry.id`). Used by T4.5 to
   * correlate events in `auto-compact-events.jsonl`.
   */
  agentId: string;
}

export interface AutoCompactSweepResult {
  attempted: number; // agents we called the guard on
  compacted: number;
  skipped: number;
  errored: number;
  perAgent: AutoCompactAgentResult[];
  totalDurationMs: number;
}

export interface AutoCompactOpts {
  /**
   * Busy-agent guard. Called once per eligible running agent with the
   * agent's (effective) working directory. Should return
   * `{ idle: true }` when the agent is safe to compact.
   */
  isIdle: (agentDir: string) => Promise<AgentBusyCheckResult>;

  /**
   * Dispatch a single-line command to a tmux session. In production
   * this wraps `tmux send-keys -t <target> <text> Enter`. The
   * orchestrator passes plain `/flush-journal` or `/compact` strings.
   */
  sendKeys: (target: string, text: string) => Promise<void>;

  /**
   * Delay helper. In production this is a `setTimeout` promise wrapper.
   * Tests can inject a synchronous counter that records calls.
   */
  sleep: (ms: number) => Promise<void>;

  /**
   * Optional structured logger. Called with a short message + context
   * object at each milestone (skip, fire, error). Falls back to a no-op
   * when omitted.
   */
  logger?: (msg: string, ctx?: Record<string, unknown>) => void;

  /**
   * Delay between sending `/flush-journal` and sending `/compact` for a
   * single agent. Must be long enough for the journal write to complete
   * before the compact truncates the conversation. Default 2000ms.
   */
  flushWaitMs?: number;

  /**
   * Delay between successive compact fires across different agents.
   * Prevents a burst of simultaneous compacts. Default 10000ms.
   */
  staggerMs?: number;

  /**
   * Idle threshold in seconds passed to the guard. The guard uses its
   * own default when omitted; this field is here for future tuning.
   */
  idleThresholdSeconds?: number;
}

const DEFAULT_FLUSH_WAIT_MS = 2000;
const DEFAULT_STAGGER_MS = 10000;

function pickAgentDir(agent: AgentRosterEntry): string {
  return agent.effectiveWorkingDirectory && agent.effectiveWorkingDirectory.length > 0
    ? agent.effectiveWorkingDirectory
    : agent.workingDirectory;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Run the auto-compact sweep across the roster. Every entry in the
 * returned `perAgent` array matches one entry in the input `roster`,
 * in order.
 *
 * The orchestrator never throws on per-agent failures — those are
 * captured as `action: 'error'` results. It only throws if the opts
 * object is missing required fields, which is a programming error.
 */
export async function runAutoCompactSweep(
  roster: AgentRosterEntry[],
  opts: AutoCompactOpts,
): Promise<AutoCompactSweepResult> {
  const start = Date.now();
  const flushWaitMs = opts.flushWaitMs ?? DEFAULT_FLUSH_WAIT_MS;
  const staggerMs = opts.staggerMs ?? DEFAULT_STAGGER_MS;
  const log = opts.logger ?? (() => {});

  const perAgent: AutoCompactAgentResult[] = [];
  let attempted = 0;
  let compacted = 0;
  let skipped = 0;
  let errored = 0;
  let firedOnce = false;

  for (const agent of roster) {
    const agentStart = Date.now();

    if (agent.status !== 'running') {
      const entry: AutoCompactAgentResult = {
        name: agent.name,
        agentId: agent.id,
        workingDirectory: agent.workingDirectory,
        tmuxSessionName: agent.tmuxSessionName,
        action: 'skipped',
        reason: `status=${agent.status}`,
        durationMs: Date.now() - agentStart,
      };
      perAgent.push(entry);
      skipped++;
      log('auto-compact: skipped non-running', { name: agent.name, status: agent.status });
      continue;
    }

    if (!agent.tmuxSessionName || agent.tmuxSessionName.length === 0) {
      const entry: AutoCompactAgentResult = {
        name: agent.name,
        agentId: agent.id,
        workingDirectory: agent.workingDirectory,
        action: 'skipped',
        reason: 'no tmux session name',
        durationMs: Date.now() - agentStart,
      };
      perAgent.push(entry);
      skipped++;
      log('auto-compact: skipped missing tmux', { name: agent.name });
      continue;
    }

    const tmuxTarget = agent.tmuxSessionName;
    const agentDir = pickAgentDir(agent);
    attempted++;

    // Guard: call once, never re-check between flush and compact.
    let guard: AgentBusyCheckResult;
    try {
      guard = await opts.isIdle(agentDir);
    } catch (err) {
      const msg = errorMessage(err);
      const entry: AutoCompactAgentResult = {
        name: agent.name,
        agentId: agent.id,
        workingDirectory: agent.workingDirectory,
        tmuxSessionName: tmuxTarget,
        action: 'error',
        reason: `guard threw: ${msg}`,
        durationMs: Date.now() - agentStart,
      };
      perAgent.push(entry);
      errored++;
      log('auto-compact: guard error', { name: agent.name, error: msg });
      continue;
    }

    if (!guard.idle) {
      const entry: AutoCompactAgentResult = {
        name: agent.name,
        agentId: agent.id,
        workingDirectory: agent.workingDirectory,
        tmuxSessionName: tmuxTarget,
        action: 'skipped',
        reason: guard.reason ?? 'busy',
        idleSeconds: guard.idleSeconds,
        durationMs: Date.now() - agentStart,
      };
      perAgent.push(entry);
      skipped++;
      log('auto-compact: skipped busy', {
        name: agent.name,
        idleSeconds: guard.idleSeconds,
        reason: guard.reason,
      });
      continue;
    }

    // Stagger BEFORE this compact, but only if a previous compact already fired.
    // This produces the "between but never trailing, never leading" pattern.
    // Stagger time is NOT counted in the per-agent duration — it belongs to
    // the sweep as a whole, not to any single agent's processing window.
    if (firedOnce) {
      await opts.sleep(staggerMs);
    }

    // Restart the agent-duration clock AFTER the stagger so per-agent time
    // only covers the actual work (guard + sends + flush-wait).
    const workStart = Date.now();

    // Fire flush → wait → compact. A failure at any step marks the agent
    // errored and proceeds to the next one without a stagger.
    try {
      await opts.sendKeys(tmuxTarget, '/flush-journal');
      await opts.sleep(flushWaitMs);
      await opts.sendKeys(tmuxTarget, '/compact');
    } catch (err) {
      const msg = errorMessage(err);
      const entry: AutoCompactAgentResult = {
        name: agent.name,
        agentId: agent.id,
        workingDirectory: agent.workingDirectory,
        tmuxSessionName: tmuxTarget,
        action: 'error',
        reason: `send failed: ${msg}`,
        idleSeconds: guard.idleSeconds,
        durationMs: Date.now() - workStart,
      };
      perAgent.push(entry);
      errored++;
      log('auto-compact: send error', { name: agent.name, error: msg });
      continue;
    }

    const entry: AutoCompactAgentResult = {
      name: agent.name,
      agentId: agent.id,
      workingDirectory: agent.workingDirectory,
      tmuxSessionName: tmuxTarget,
      action: 'compacted',
      idleSeconds: guard.idleSeconds,
      durationMs: Date.now() - workStart,
    };
    perAgent.push(entry);
    compacted++;
    firedOnce = true;
    log('auto-compact: fired', {
      name: agent.name,
      idleSeconds: guard.idleSeconds,
      tmuxTarget,
    });
  }

  return {
    attempted,
    compacted,
    skipped,
    errored,
    perAgent,
    totalDurationMs: Date.now() - start,
  };
}
