import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRosterEntry } from '@/lib/types';
import {
  flushJournalForTaskCompleter,
  type TaskCompleteFlushOpts,
} from '@/lib/task-complete-flush';

/**
 * Sprint 38 T4.6 — tasks.complete server-side /flush-journal trigger.
 *
 * Looks up the claiming participant in the channel's roster and, if
 * they resolve to a running agent with a tmux session, fires
 * `/flush-journal` over tmux-send. This is the server-side replacement
 * for the non-existent TaskCompleted native Claude Code hook — every
 * task completion guarantees the agent's scratch journal lands in
 * logs/today.md shortly after the board is updated.
 *
 * Unlike the T4.3 sprint-complete sweep, this does NOT use the
 * busy-agent guard: when tasks.complete fires, the claiming agent is
 * almost certainly mid-turn (processing the tasks.complete tool
 * result), so the JSONL activity check would always say busy. That's
 * exactly the moment we WANT to flush — Claude Code's command
 * dispatcher queues `/flush-journal` behind the current turn and
 * fires it once the turn settles.
 */

function makeAgent(overrides: Partial<AgentRosterEntry>): AgentRosterEntry {
  const base: AgentRosterEntry = {
    id: 'id-' + (overrides.name ?? 'Agent'),
    name: 'Agent',
    workingDirectory: '/home/user/SG-1/Team/Agent',
    channelId: 'ch-1',
    participantId: 'pid-' + (overrides.name ?? 'Agent'),
    color: '#000',
    status: 'running',
    tmuxSessionName: 'sess-' + (overrides.name ?? 'Agent'),
    autoResume: true,
    useCollabWrapper: true,
    dangerouslySkipPermissions: false,
    createdAt: '2026-04-10T00:00:00.000Z',
    crashCount: 0,
  };
  return { ...base, ...overrides };
}

interface Fixture {
  opts: TaskCompleteFlushOpts;
  sendCalls: Array<{ target: string; text: string }>;
  sendShouldFail: boolean;
}

function mkFixture(): Fixture {
  const sendCalls: Array<{ target: string; text: string }> = [];
  let failRef = { value: false };
  const opts: TaskCompleteFlushOpts = {
    isIdle: async () => ({ idle: true, idleSeconds: 60 }),
    sendKeys: async (target, text) => {
      sendCalls.push({ target, text });
      if (failRef.value) throw new Error('tmux send failed');
    },
  };
  return {
    opts,
    sendCalls,
    get sendShouldFail() {
      return failRef.value;
    },
    set sendShouldFail(v: boolean) {
      failRef.value = v;
    },
  } as Fixture;
}

describe('flushJournalForTaskCompleter', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = mkFixture();
  });

  it('fires /flush-journal against the matching agents tmux session', async () => {
    const roster = [
      makeAgent({
        name: 'Completer',
        participantId: 'pid-Completer',
        tmuxSessionName: 'tmux-completer',
      }),
      makeAgent({
        name: 'Other',
        participantId: 'pid-Other',
        tmuxSessionName: 'tmux-other',
      }),
    ];

    const res = await flushJournalForTaskCompleter('pid-Completer', roster, fx.opts);

    expect(res.fired).toBe(true);
    expect(res.tmuxSessionName).toBe('tmux-completer');
    expect(res.agentName).toBe('Completer');
    expect(fx.sendCalls).toEqual([
      { target: 'tmux-completer', text: '/flush-journal' },
    ]);
  });

  it('returns skipped with reason when participantId does not match any agent', async () => {
    const roster = [makeAgent({ name: 'A', participantId: 'pid-A' })];

    const res = await flushJournalForTaskCompleter('pid-unknown', roster, fx.opts);

    expect(res.fired).toBe(false);
    expect(res.reason).toContain('not found');
    expect(fx.sendCalls).toHaveLength(0);
  });

  it('returns skipped when the matched agent is not running', async () => {
    const roster = [
      makeAgent({
        name: 'Stopped',
        participantId: 'pid-Stopped',
        status: 'stopped',
      }),
    ];

    const res = await flushJournalForTaskCompleter('pid-Stopped', roster, fx.opts);

    expect(res.fired).toBe(false);
    expect(res.reason).toContain('status=stopped');
    expect(fx.sendCalls).toHaveLength(0);
  });

  it('returns skipped when the matched agent has no tmux session name', async () => {
    const roster = [
      makeAgent({
        name: 'NoTmux',
        participantId: 'pid-NoTmux',
        tmuxSessionName: undefined,
      }),
    ];

    const res = await flushJournalForTaskCompleter('pid-NoTmux', roster, fx.opts);

    expect(res.fired).toBe(false);
    expect(res.reason).toContain('tmux');
    expect(fx.sendCalls).toHaveLength(0);
  });

  it('returns fired=false with reason when sendKeys throws', async () => {
    const roster = [
      makeAgent({
        name: 'Boom',
        participantId: 'pid-Boom',
        tmuxSessionName: 'tmux-boom',
      }),
    ];
    fx.sendShouldFail = true;

    const res = await flushJournalForTaskCompleter('pid-Boom', roster, fx.opts);

    expect(res.fired).toBe(false);
    expect(res.reason).toContain('send');
    expect(fx.sendCalls).toHaveLength(1);
  });

  it('empty roster → skipped, no send', async () => {
    const res = await flushJournalForTaskCompleter('pid-anything', [], fx.opts);
    expect(res.fired).toBe(false);
    expect(res.reason).toContain('not found');
    expect(fx.sendCalls).toHaveLength(0);
  });

  it('matches by participantId, not by name or id', async () => {
    const roster = [
      makeAgent({
        name: 'Duplicate',
        id: 'agent-id-A',
        participantId: 'pid-correct',
        tmuxSessionName: 't-correct',
      }),
      makeAgent({
        name: 'Duplicate',
        id: 'agent-id-B',
        participantId: 'pid-wrong',
        tmuxSessionName: 't-wrong',
      }),
    ];

    const res = await flushJournalForTaskCompleter('pid-correct', roster, fx.opts);
    expect(res.fired).toBe(true);
    expect(fx.sendCalls[0].target).toBe('t-correct');
  });
});
