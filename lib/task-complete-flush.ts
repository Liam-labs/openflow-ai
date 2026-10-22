/**
 * Sprint 38 T4.6 — server-side /flush-journal trigger for tasks.complete.
 *
 * Claude Code does not fire any native "task completed" hook; we need
 * a server-side replacement that guarantees the claiming agent's
 * scratch journal lands in logs/today.md shortly after the board is
 * updated. This module resolves a participantId to a running agent in
 * the channel's roster and sends `/flush-journal` over tmux-send.
 *
 * Sprint 38 post-release fix (2026-05-27): added idle guard. The
 * original no-guard design assumed Claude Code's command dispatcher
 * queues /flush-journal behind the current turn — true for Claude but
 * not for Antigravity/Codex/Grok wrappers where tmux send-keys injects
 * directly into stdin mid-generation. The guard uses the same
 * isAgentIdleForCompact check as the sprint-complete sweep, sharing
 * the idle threshold. A task-completing agent that is still mid-turn
 * will be skipped; the 25-turn scratch-flush-counter hook provides
 * the safety net.
 *
 * Unlike the T4.3 sprint-complete sweep this runs against a SINGLE
 * agent and does not stagger. It is fire-and-forget from the caller.
 */

import type { AgentRosterEntry } from '@/lib/types';
import type { AgentBusyCheckResult } from '@/lib/agent-session-state';

export interface TaskCompleteFlushOpts {
  /**
   * Dispatch `/flush-journal Enter` to a tmux session. In production
   * this is `tmux send-keys -t <target> <text> Enter` via execFile.
   */
  sendKeys: (target: string, text: string) => Promise<void>;
  /**
   * Busy-agent guard. Same shape as auto-compact orchestrator.
   * Called once before firing. When the agent is mid-turn the flush
   * is skipped; the 25-turn counter hook provides the safety net.
   */
  isIdle: (agentDir: string) => Promise<AgentBusyCheckResult>;
  /**
   * Optional structured logger. Falls back to no-op when omitted.
   */
  logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface TaskCompleteFlushResult {
  fired: boolean;
  reason?: string;
  tmuxSessionName?: string;
  agentName?: string;
  agentId?: string;
}

function pickAgentDir(agent: AgentRosterEntry): string {
  return agent.effectiveWorkingDirectory && agent.effectiveWorkingDirectory.length > 0
    ? agent.effectiveWorkingDirectory
    : agent.workingDirectory;
}

/**
 * Resolve a participant id to a roster agent and fire `/flush-journal`
 * against their tmux session. Returns a structured result describing
 * whether the flush fired and why it was skipped when it wasn't.
 *
 * The function never throws on agent lookup or send failure — every
 * failure is captured in the returned result so the caller can emit
 * an observability event without an extra try/catch.
 */
export async function flushJournalForTaskCompleter(
  participantId: string,
  roster: AgentRosterEntry[],
  opts: TaskCompleteFlushOpts,
): Promise<TaskCompleteFlushResult> {
  const log = opts.logger ?? (() => {});

  const agent = roster.find((r) => r.participantId === participantId);
  if (!agent) {
    const result: TaskCompleteFlushResult = {
      fired: false,
      reason: 'agent not found in roster',
    };
    log('task-complete-flush: agent not found', { participantId });
    return result;
  }

  if (agent.status !== 'running') {
    const result: TaskCompleteFlushResult = {
      fired: false,
      reason: `status=${agent.status}`,
      agentName: agent.name,
      agentId: agent.id,
    };
    log('task-complete-flush: skipped non-running', {
      name: agent.name,
      status: agent.status,
    });
    return result;
  }

  if (!agent.tmuxSessionName || agent.tmuxSessionName.length === 0) {
    const result: TaskCompleteFlushResult = {
      fired: false,
      reason: 'no tmux session name',
      agentName: agent.name,
      agentId: agent.id,
    };
    log('task-complete-flush: skipped missing tmux', { name: agent.name });
    return result;
  }

  const agentDir = pickAgentDir(agent);

  // Guard: skip if the agent is mid-turn. The 25-turn counter hook
  // provides the safety net for agents that never reach idle.
  let guard: AgentBusyCheckResult;
  try {
    guard = await opts.isIdle(agentDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: TaskCompleteFlushResult = {
      fired: false,
      reason: `idle guard threw: ${msg}`,
      agentName: agent.name,
      agentId: agent.id,
    };
    log('task-complete-flush: guard error', { name: agent.name, error: msg });
    return result;
  }

  if (!guard.idle) {
    const result: TaskCompleteFlushResult = {
      fired: false,
      reason: guard.reason ?? 'busy',
      agentName: agent.name,
      agentId: agent.id,
    };
    log('task-complete-flush: skipped busy', {
      name: agent.name,
      idleSeconds: guard.idleSeconds,
      reason: guard.reason,
    });
    return result;
  }

  try {
    await opts.sendKeys(agent.tmuxSessionName, '/flush-journal');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: TaskCompleteFlushResult = {
      fired: false,
      reason: `send failed: ${msg}`,
      agentName: agent.name,
      agentId: agent.id,
      tmuxSessionName: agent.tmuxSessionName,
    };
    log('task-complete-flush: send error', { name: agent.name, error: msg });
    return result;
  }

  const result: TaskCompleteFlushResult = {
    fired: true,
    agentName: agent.name,
    agentId: agent.id,
    tmuxSessionName: agent.tmuxSessionName,
  };
  log('task-complete-flush: fired', {
    name: agent.name,
    tmuxSessionName: agent.tmuxSessionName,
  });
  return result;
}
