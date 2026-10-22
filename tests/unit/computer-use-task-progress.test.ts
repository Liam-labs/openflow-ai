/**
 * Unit tests for computeTaskProgress (audit task 04aa4c48).
 *
 * Acceptance from sprint board:
 *   - poller can render a progress bar (elapsedMs + actionsCount)
 *   - AI-loop callers can detect 'stuck' (no actions in last 60s — lastAction.timestamp)
 *   - terminal tasks return terminalState=true so callers stop polling
 */

import { describe, it, expect } from 'vitest';
import { computeTaskProgress } from '@/app/api/agent/actions/computer-use';
import type { ComputerUseAction, ComputerUseSession, ComputerUseTask } from '@/lib/types';

function makeTask(overrides: Partial<ComputerUseTask> = {}): ComputerUseTask {
  return {
    id: 'cu-task-test',
    status: 'running',
    prompt: 'p',
    tmuxSession: '',
    backend: 'max',
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    timeoutMs: 60_000,
    createdBy: 'tester',
    ...overrides,
  };
}

function makeAction(timestamp: string, type: ComputerUseAction['type'] = 'screenshot'): ComputerUseAction {
  return {
    id: `act-${timestamp}`,
    type,
    params: {},
    result: { success: true, durationMs: 50 },
    timestamp,
  };
}

function makeSession(actions: ComputerUseAction[]): ComputerUseSession {
  return {
    id: 'cu-test',
    status: 'active',
    bridgeUrl: '',
    bridgeReachable: false,
    target: 'desktop',
    actions,
    createdAt: new Date().toISOString(),
    createdBy: 'tester',
  };
}

describe('computeTaskProgress', () => {
  it('returns terminalState=false and computed elapsedMs for a running task with no session', () => {
    const start = Date.now() - 5_000;
    const task = makeTask({
      status: 'running',
      startedAt: new Date(start).toISOString(),
    });
    const progress = computeTaskProgress(task, null);
    expect(progress.terminalState).toBe(false);
    expect(progress.actionsCount).toBe(0);
    expect(progress.lastAction).toBeNull();
    // elapsedMs should be roughly 5000ms — accept ±2s slack for test latency
    expect(progress.elapsedMs).toBeGreaterThanOrEqual(4500);
    expect(progress.elapsedMs).toBeLessThan(20_000);
  });

  it('returns terminalState=true for completed tasks and uses durationMs for elapsedMs', () => {
    const task = makeTask({
      status: 'completed',
      durationMs: 12_345,
      completedAt: new Date().toISOString(),
    });
    const progress = computeTaskProgress(task, null);
    expect(progress.terminalState).toBe(true);
    expect(progress.elapsedMs).toBe(12_345);
  });

  it('marks failed/timeout/killed as terminalState', () => {
    for (const s of ['completed', 'failed', 'timeout', 'killed'] as const) {
      const t = makeTask({ status: s, durationMs: 1000 });
      expect(computeTaskProgress(t, null).terminalState).toBe(true);
    }
  });

  it('uses task.actionsCount when no session is provided', () => {
    const task = makeTask({ actionsCount: 7 });
    const progress = computeTaskProgress(task, null);
    expect(progress.actionsCount).toBe(7);
    expect(progress.lastAction).toBeNull();
  });

  it('counts only session actions whose timestamp is >= task.startedAt', () => {
    const startedAt = new Date('2026-04-27T20:00:00Z').toISOString();
    const task = makeTask({ startedAt });
    const session = makeSession([
      makeAction('2026-04-27T19:59:00Z'), // before task — excluded
      makeAction('2026-04-27T20:00:00Z'), // exactly at start — included
      makeAction('2026-04-27T20:00:30Z', 'click'),
      makeAction('2026-04-27T20:01:00Z', 'type'),
    ]);
    const progress = computeTaskProgress(task, session);
    expect(progress.actionsCount).toBe(3);
    expect(progress.lastAction).toEqual({
      type: 'type',
      timestamp: '2026-04-27T20:01:00Z',
    });
  });

  it('returns lastAction=null when session has no actions in task time range', () => {
    const startedAt = new Date('2026-04-27T20:00:00Z').toISOString();
    const task = makeTask({ startedAt });
    const session = makeSession([makeAction('2026-04-27T19:00:00Z')]);
    const progress = computeTaskProgress(task, session);
    expect(progress.actionsCount).toBe(0);
    expect(progress.lastAction).toBeNull();
  });

  it('prefers session-derived count when greater than task.actionsCount', () => {
    // Useful when output-file sync is stale but session has fresher data.
    const startedAt = new Date('2026-04-27T20:00:00Z').toISOString();
    const task = makeTask({ startedAt, actionsCount: 1 });
    const session = makeSession([
      makeAction('2026-04-27T20:00:30Z'),
      makeAction('2026-04-27T20:00:31Z'),
      makeAction('2026-04-27T20:00:32Z'),
    ]);
    expect(computeTaskProgress(task, session).actionsCount).toBe(3);
  });

  it('falls back to task.actionsCount when session count is lower', () => {
    // Output file may have completed before session was attached.
    const startedAt = new Date('2026-04-27T20:00:00Z').toISOString();
    const task = makeTask({ startedAt, actionsCount: 10 });
    const session = makeSession([makeAction('2026-04-27T20:00:30Z')]);
    expect(computeTaskProgress(task, session).actionsCount).toBe(10);
  });

  it('lastAction comes from the temporally-last filtered action, not array order', () => {
    // If actions were appended out of order (race), last by timestamp wins.
    const startedAt = new Date('2026-04-27T20:00:00Z').toISOString();
    const task = makeTask({ startedAt });
    const session = makeSession([
      makeAction('2026-04-27T20:01:00Z', 'click'),
      makeAction('2026-04-27T20:00:30Z', 'screenshot'),
      makeAction('2026-04-27T20:02:00Z', 'type'),
    ]);
    const progress = computeTaskProgress(task, session);
    expect(progress.lastAction).toEqual({
      type: 'type',
      timestamp: '2026-04-27T20:02:00Z',
    });
  });

  it('handles task with sessionId but session lookup returning null', () => {
    const task = makeTask({ sessionId: 'cu-missing', actionsCount: 4 });
    const progress = computeTaskProgress(task, null);
    expect(progress.actionsCount).toBe(4);
    expect(progress.lastAction).toBeNull();
  });

  it('elapsedMs falls back to wall-clock when terminal but durationMs is missing', () => {
    const start = Date.now() - 3_000;
    const task = makeTask({
      status: 'completed',
      startedAt: new Date(start).toISOString(),
      durationMs: undefined,
    });
    const progress = computeTaskProgress(task, null);
    expect(progress.terminalState).toBe(true);
    expect(progress.elapsedMs).toBeGreaterThanOrEqual(2500);
    expect(progress.elapsedMs).toBeLessThan(20_000);
  });

  it('stuck-detection: lastAction.timestamp lets callers compute idle duration', () => {
    // 90s ago: task started, 70s ago: last action, now: stuck
    const now = Date.now();
    const startedAt = new Date(now - 90_000).toISOString();
    const lastTs = new Date(now - 70_000).toISOString();
    const task = makeTask({ startedAt });
    const session = makeSession([
      makeAction(new Date(now - 80_000).toISOString(), 'screenshot'),
      makeAction(lastTs, 'click'),
    ]);
    const progress = computeTaskProgress(task, session);
    expect(progress.lastAction).not.toBeNull();
    const idleMs = now - new Date(progress.lastAction!.timestamp).getTime();
    expect(idleMs).toBeGreaterThanOrEqual(60_000); // 'stuck' threshold
  });
});
