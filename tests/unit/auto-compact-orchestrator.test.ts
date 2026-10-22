import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRosterEntry } from '@/lib/types';
import type { AgentBusyCheckResult } from '@/lib/agent-session-state';
import {
  runAutoCompactSweep,
  type AutoCompactOpts,
} from '@/lib/auto-compact-orchestrator';

/**
 * Sprint 38 T4.3 — sprints.complete auto-compact orchestrator.
 *
 * Tests cover the documented invariants Builder captured in T4.1/T4.2/T4.4:
 *   - Guard (isAgentIdleForCompact) is called exactly ONCE per running agent,
 *     before the flush-journal fire, never re-checked between flush and compact.
 *   - For each compacted agent: send /flush-journal, wait flushWaitMs, send /compact.
 *   - Stagger staggerMs only BETWEEN successful compacts (no trailing stagger).
 *   - status != 'running' → skipped with reason, guard never called.
 *   - Missing tmuxSessionName → skipped, guard never called.
 *   - Busy agent (guard.idle === false) → skipped, never sendKeys'd.
 *   - sendKeys failure on one agent does NOT abort the sweep; next agent still runs.
 *   - Guard failure on one agent does NOT abort the sweep.
 *   - Empty roster → no-op, returns zeroed counters.
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

interface Call {
  kind: 'isIdle' | 'send' | 'sleep';
  arg: string;
  ms?: number;
}

interface Fixture {
  calls: Call[];
  opts: AutoCompactOpts;
  guardResponses: Map<string, AgentBusyCheckResult>;
  sendFailures: Set<string>;
  guardThrows: Set<string>;
}

function idle(seconds = 120): AgentBusyCheckResult {
  return { idle: true, idleSeconds: seconds, jsonlPath: '/tmp/fake.jsonl' };
}

function busy(seconds = 5): AgentBusyCheckResult {
  return {
    idle: false,
    idleSeconds: seconds,
    reason: `busy: last entry ${seconds}s old, below 30s threshold`,
    jsonlPath: '/tmp/fake.jsonl',
  };
}

function mkFixture(): Fixture {
  const calls: Call[] = [];
  const guardResponses = new Map<string, AgentBusyCheckResult>();
  const sendFailures = new Set<string>();
  const guardThrows = new Set<string>();

  const opts: AutoCompactOpts = {
    isIdle: async (agentDir: string) => {
      calls.push({ kind: 'isIdle', arg: agentDir });
      if (guardThrows.has(agentDir)) {
        throw new Error(`boom for ${agentDir}`);
      }
      return guardResponses.get(agentDir) ?? idle();
    },
    sendKeys: async (target: string, text: string) => {
      calls.push({ kind: 'send', arg: `${target}:${text}` });
      if (sendFailures.has(`${target}:${text}`)) {
        throw new Error(`tmux send-keys failed for ${target}:${text}`);
      }
    },
    sleep: async (ms: number) => {
      calls.push({ kind: 'sleep', arg: String(ms), ms });
    },
    flushWaitMs: 2000,
    staggerMs: 10000,
    idleThresholdSeconds: 30,
  };

  return { calls, opts, guardResponses, sendFailures, guardThrows };
}

describe('runAutoCompactSweep', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = mkFixture();
  });

  it('returns zeroed counters on empty roster', async () => {
    const res = await runAutoCompactSweep([], fx.opts);
    expect(res.attempted).toBe(0);
    expect(res.compacted).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.errored).toBe(0);
    expect(res.perAgent).toHaveLength(0);
    expect(fx.calls).toHaveLength(0);
  });

  it('fires flush → wait → compact for a single idle running agent', async () => {
    const agents = [makeAgent({ name: 'Solo', workingDirectory: '/a/Solo', tmuxSessionName: 't-solo' })];
    fx.guardResponses.set('/a/Solo', idle(120));

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.attempted).toBe(1);
    expect(res.compacted).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.errored).toBe(0);
    expect(res.perAgent[0].action).toBe('compacted');
    expect(res.perAgent[0].idleSeconds).toBe(120);

    // Call sequence: isIdle, send flush, sleep 2000, send compact.
    // No stagger because it's the only agent.
    expect(fx.calls).toEqual([
      { kind: 'isIdle', arg: '/a/Solo' },
      { kind: 'send', arg: 't-solo:/flush-journal' },
      { kind: 'sleep', arg: '2000', ms: 2000 },
      { kind: 'send', arg: 't-solo:/compact' },
    ]);
  });

  it('calls the guard EXACTLY ONCE per running agent — never between flush and compact', async () => {
    const agents = [makeAgent({ name: 'X', workingDirectory: '/a/X', tmuxSessionName: 'tx' })];
    fx.guardResponses.set('/a/X', idle(60));

    await runAutoCompactSweep(agents, fx.opts);

    const guardCalls = fx.calls.filter((c) => c.kind === 'isIdle');
    expect(guardCalls).toHaveLength(1);
    expect(guardCalls[0].arg).toBe('/a/X');
  });

  it('staggers only BETWEEN successful compacts — no leading, no trailing', async () => {
    const agents = [
      makeAgent({ name: 'A', workingDirectory: '/a/A', tmuxSessionName: 'ta' }),
      makeAgent({ name: 'B', workingDirectory: '/a/B', tmuxSessionName: 'tb' }),
      makeAgent({ name: 'C', workingDirectory: '/a/C', tmuxSessionName: 'tc' }),
    ];
    fx.guardResponses.set('/a/A', idle());
    fx.guardResponses.set('/a/B', idle());
    fx.guardResponses.set('/a/C', idle());

    await runAutoCompactSweep(agents, fx.opts);

    const sleeps = fx.calls.filter((c) => c.kind === 'sleep').map((c) => c.ms);
    // 3 agents: 3x flush-wait (2000) + 2x stagger (10000). No leading stagger before A, no trailing stagger after C.
    expect(sleeps).toEqual([2000, 10000, 2000, 10000, 2000]);
  });

  it('busy agents are skipped without sending anything', async () => {
    const agents = [
      makeAgent({ name: 'Busy', workingDirectory: '/a/Busy', tmuxSessionName: 'tb' }),
    ];
    fx.guardResponses.set('/a/Busy', busy(5));

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.compacted).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.perAgent[0].action).toBe('skipped');
    expect(res.perAgent[0].reason).toContain('busy');

    // Guard was called, but no sendKeys / sleep followed
    const sends = fx.calls.filter((c) => c.kind === 'send');
    const sleeps = fx.calls.filter((c) => c.kind === 'sleep');
    expect(sends).toHaveLength(0);
    expect(sleeps).toHaveLength(0);
  });

  it('skips non-running agents without calling the guard', async () => {
    const agents = [
      makeAgent({ name: 'Stopped', status: 'stopped', workingDirectory: '/a/Stopped' }),
      makeAgent({ name: 'Crashed', status: 'crashed', workingDirectory: '/a/Crashed' }),
      makeAgent({ name: 'Starting', status: 'starting', workingDirectory: '/a/Starting' }),
    ];

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.attempted).toBe(0);
    expect(res.compacted).toBe(0);
    expect(res.skipped).toBe(3);
    expect(res.perAgent.map((p) => p.reason)).toEqual([
      'status=stopped',
      'status=crashed',
      'status=starting',
    ]);
    // Guard never called for non-running agents
    expect(fx.calls.filter((c) => c.kind === 'isIdle')).toHaveLength(0);
  });

  it('skips running agents without a tmux session name', async () => {
    const agents = [
      makeAgent({ name: 'NoTmux', workingDirectory: '/a/NoTmux', tmuxSessionName: undefined }),
    ];

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.attempted).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.perAgent[0].reason).toContain('tmux');
    expect(fx.calls.filter((c) => c.kind === 'isIdle')).toHaveLength(0);
  });

  it('a sendKeys failure on one agent does not abort the sweep — next agents still run', async () => {
    const agents = [
      makeAgent({ name: 'A', workingDirectory: '/a/A', tmuxSessionName: 'ta' }),
      makeAgent({ name: 'B', workingDirectory: '/a/B', tmuxSessionName: 'tb' }),
    ];
    fx.guardResponses.set('/a/A', idle());
    fx.guardResponses.set('/a/B', idle());
    fx.sendFailures.add('ta:/compact');

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.compacted).toBe(1);
    expect(res.errored).toBe(1);
    expect(res.perAgent[0].action).toBe('error');
    expect(res.perAgent[0].reason).toContain('send');
    expect(res.perAgent[1].action).toBe('compacted');
    expect(res.perAgent[1].name).toBe('B');
  });

  it('a guard throw on one agent does not abort the sweep', async () => {
    const agents = [
      makeAgent({ name: 'A', workingDirectory: '/a/A', tmuxSessionName: 'ta' }),
      makeAgent({ name: 'B', workingDirectory: '/a/B', tmuxSessionName: 'tb' }),
    ];
    fx.guardThrows.add('/a/A');
    fx.guardResponses.set('/a/B', idle());

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.errored).toBe(1);
    expect(res.compacted).toBe(1);
    expect(res.perAgent[0].action).toBe('error');
    expect(res.perAgent[0].reason).toContain('guard');
    expect(res.perAgent[1].action).toBe('compacted');
  });

  it('errored agents do not trigger a stagger for the following agent', async () => {
    const agents = [
      makeAgent({ name: 'A', workingDirectory: '/a/A', tmuxSessionName: 'ta' }),
      makeAgent({ name: 'B', workingDirectory: '/a/B', tmuxSessionName: 'tb' }),
    ];
    fx.guardResponses.set('/a/A', idle());
    fx.guardResponses.set('/a/B', idle());
    fx.sendFailures.add('ta:/flush-journal');

    await runAutoCompactSweep(agents, fx.opts);

    // B runs right after A errors — no stagger gap inherited from a failed A fire.
    const sleeps = fx.calls.filter((c) => c.kind === 'sleep').map((c) => c.ms);
    expect(sleeps).toEqual([2000]); // only B's flush wait
  });

  it('prefers effectiveWorkingDirectory over workingDirectory when present', async () => {
    const agents = [
      makeAgent({
        name: 'Eff',
        workingDirectory: '/a/canonical',
        effectiveWorkingDirectory: '/a/actual',
        tmuxSessionName: 'teff',
      }),
    ];
    fx.guardResponses.set('/a/actual', idle());

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.compacted).toBe(1);
    const guardCall = fx.calls.find((c) => c.kind === 'isIdle');
    expect(guardCall?.arg).toBe('/a/actual');
  });

  it('mixes running/idle/busy/stopped into a single pass with correct counts', async () => {
    const agents = [
      makeAgent({ name: 'IdleA', workingDirectory: '/x/IdleA', tmuxSessionName: 'ia' }),
      makeAgent({ name: 'Stopped', status: 'stopped', workingDirectory: '/x/Stopped' }),
      makeAgent({ name: 'BusyB', workingDirectory: '/x/BusyB', tmuxSessionName: 'bb' }),
      makeAgent({ name: 'IdleC', workingDirectory: '/x/IdleC', tmuxSessionName: 'ic' }),
    ];
    fx.guardResponses.set('/x/IdleA', idle());
    fx.guardResponses.set('/x/BusyB', busy());
    fx.guardResponses.set('/x/IdleC', idle());

    const res = await runAutoCompactSweep(agents, fx.opts);

    expect(res.attempted).toBe(3); // 3 were running+tmux (all except Stopped)
    expect(res.compacted).toBe(2);
    expect(res.skipped).toBe(2); // Stopped + BusyB
    expect(res.errored).toBe(0);

    // Stagger happens once (between IdleA and IdleC), not before IdleA, not after IdleC
    const sleeps = fx.calls.filter((c) => c.kind === 'sleep').map((c) => c.ms);
    expect(sleeps).toEqual([2000, 10000, 2000]);
  });
});
