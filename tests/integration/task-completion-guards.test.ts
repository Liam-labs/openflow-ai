import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Guarded + idempotent completion (docs/atomic-task-completion/Plan.md) against the real
// file store and lock in a disposable directory. Effects are spied so conflicts and replays
// can be shown to write nothing and fire nothing.

const dir = mkdtempSync(path.join(tmpdir(), 'task-completion-'));
const TASKS = path.join(dir, 'collab-tasks.json');
const CHANNELS = path.join(dir, 'collab-channels.json');

vi.mock('@/lib/data-paths', () => ({
  DataPaths: { collabTasks: TASKS, collabChannels: CHANNELS, sessions: path.join(dir, 'sessions.json') },
}));
vi.mock('@/lib/data-io', async (orig) => {
  const real = await orig<typeof import('@/lib/data-io')>();
  return { ...real, writeJsonFile: vi.fn(real.writeJsonFile) };
});
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/log-emitter', () => ({ emitApiEvent: vi.fn() }));
vi.mock('@/lib/api-tracking', () => ({
  tracked: (_: string, h: unknown) => h,
  withTiming: (_: string, h: unknown) => h,
}));
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('@/lib/task-complete-flush', () => ({ flushJournalForTaskCompleter: vi.fn().mockResolvedValue({ fired: false, reason: 'test' }) }));
vi.mock('@/lib/tmux-send', () => ({ tmuxSendKeys: vi.fn() }));
vi.mock('@/lib/agent-session-state', () => ({ isAgentIdleForCompact: vi.fn() }));

import { writeJsonFile } from '@/lib/data-io';
import { emitApiEvent } from '@/lib/log-emitter';
import { eventBus } from '@/lib/event-bus';
import { flushJournalForTaskCompleter } from '@/lib/task-complete-flush';
import { nextTaskRevision } from '@/lib/task-completion';

const CH = 'ch-guard';
const ALICE = 'p-alice';
const BOB = 'p-bob';
const T0 = '2026-10-05T10:00:00.000Z';

function seed(taskOverrides: Record<string, unknown> = {}) {
  writeFileSync(CHANNELS, JSON.stringify({
    channels: [{ id: CH, name: 'Guard', participants: [
      { id: ALICE, name: 'Alice', type: 'agent', status: 'online' },
      { id: BOB, name: 'Bob', type: 'agent', status: 'online' },
    ] }],
    lastUpdated: T0,
  }));
  writeFileSync(TASKS, JSON.stringify({
    tasks: [
      { id: 't1', channelId: CH, title: 'Card', status: 'in_progress', priority: 'normal', sortOrder: 1,
        createdBy: ALICE, createdAt: T0, updatedAt: T0, assigneeId: ALICE, assignedAt: T0, sprintId: 's1', ...taskOverrides },
      { id: 't2', channelId: CH, title: 'Other', status: 'todo', priority: 'normal', sortOrder: 2,
        createdBy: ALICE, createdAt: T0, updatedAt: T0, sprintId: 's1' },
      { id: 't3', channelId: CH, title: 'Unassigned', status: 'todo', priority: 'normal', sortOrder: 3,
        createdBy: ALICE, createdAt: T0, updatedAt: T0 },
    ],
    sprints: [{ id: 's1', channelId: CH, name: 'S', status: 'active', createdAt: T0, updatedAt: T0 }],
    phases: [],
    lastUpdated: T0,
  }));
}

const readStore = () => JSON.parse(readFileSync(TASKS, 'utf-8'));
const task = (id = 't1') => readStore().tasks.find((t: { id: string }) => t.id === id);

async function route() {
  return (await import('@/app/api/collab/tasks/route')).POST;
}
async function post(body: Record<string, unknown>) {
  const POST = await route();
  const res = await POST(new NextRequest('http://localhost/api/collab/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: CH, participantId: ALICE, ...body }),
  }));
  const out = { status: res.status, body: await res.json() };
  // A completion fires its journal flush in the background; let it land before anyone counts effects.
  await new Promise(r => setTimeout(r, 30));
  return out;
}
const complete = (extra: Record<string, unknown> = {}) => post({ action: 'complete', taskId: 't1', ...extra });

/** Snapshot of everything a completion could touch, to prove a call left no trace. */
function effects() {
  return {
    tasksBytes: readFileSync(TASKS, 'utf-8'),
    channelsBytes: readFileSync(CHANNELS, 'utf-8'),
    writes: vi.mocked(writeJsonFile).mock.calls.length,
    events: vi.mocked(eventBus.emitEvent).mock.calls.length,
    apiEvents: vi.mocked(emitApiEvent).mock.calls.length,
    flushes: vi.mocked(flushJournalForTaskCompleter).mock.calls.length,
  };
}

beforeEach(() => {
  seed();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('completion guards', () => {
  it('completes when both guards match, once, with the usual effects', async () => {
    const r = await complete({ expectedAssigneeId: ALICE, expectedUpdatedAt: T0 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, taskId: 't1', task: { status: 'done' } });
    expect(r.body.replayed).toBeUndefined();
    expect(task().status).toBe('done');
    expect(task().updatedAt > T0).toBe(true);
    expect(vi.mocked(eventBus.emitEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flushJournalForTaskCompleter)).toHaveBeenCalledTimes(1);
  });

  it('matches explicit null against an unassigned task, and conflicts it against an assigned one', async () => {
    const ok = await post({ action: 'complete', taskId: 't3', expectedAssigneeId: null });
    expect(ok.status).toBe(200);

    const before = effects();
    const stale = await complete({ expectedAssigneeId: null });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      success: false, code: 'TASK_COMPLETION_CONFLICT',
      conflicts: [{ field: 'assigneeId', expected: null, current: ALICE }],
      current: { status: 'in_progress', assigneeId: ALICE, updatedAt: T0 },
    });
    expect(effects()).toEqual(before);
  });

  it('rejects a stale owner and a stale revision with no state change or effects', async () => {
    for (const guard of [{ expectedAssigneeId: BOB }, { expectedUpdatedAt: '2026-10-05T09:59:59.999Z' }]) {
      const before = effects();
      const r = await complete(guard);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('TASK_COMPLETION_CONFLICT');
      expect(effects()).toEqual(before);
    }
    expect(task().status).toBe('in_progress');
    expect(readStore().sprints[0].status).toBe('active');
  });

  it('conflicts when the card was reassigned or reopened after the consumer read it', async () => {
    const read = task();
    await post({ action: 'update', taskId: 't1', assigneeId: BOB });
    const reassigned = await complete({ expectedAssigneeId: read.assigneeId, expectedUpdatedAt: read.updatedAt });
    expect(reassigned.status).toBe(409);
    expect(reassigned.body.conflicts.map((c: { field: string }) => c.field)).toEqual(['assigneeId', 'updatedAt']);

    // Complete, reopen, then a consumer that read the done-then-reopened card's earlier revision.
    const fresh = task();
    await complete({ expectedUpdatedAt: fresh.updatedAt });
    const doneRev = task().updatedAt;
    await post({ action: 'update', taskId: 't1', status: 'in_progress' });
    const reopened = await complete({ expectedUpdatedAt: doneRev });
    expect(reopened.status).toBe(409);
    expect(task().status).toBe('in_progress');
  });

  it('rejects malformed guards instead of ignoring them', async () => {
    const bad = [
      { expectedAssigneeId: 42 }, { expectedAssigneeId: '' }, { expectedAssigneeId: {} },
      { expectedUpdatedAt: null }, { expectedUpdatedAt: '' }, { expectedUpdatedAt: 1759658400000 },
      { idempotencyKey: '' }, { idempotencyKey: 7 }, { idempotencyKey: 'x'.repeat(201) },
    ];
    for (const guard of bad) {
      const before = effects();
      const r = await complete(guard);
      expect(r.status, JSON.stringify(guard)).toBe(400);
      expect(r.body.code).toBe('INVALID_COMPLETION_REQUEST');
      expect(effects()).toEqual(before);
    }
  });

  it('keeps legacy behaviour when no guard or key is sent', async () => {
    const r = await complete();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['success', 'task', 'taskId']);
    expect(task().status).toBe('done');
    expect(readStore().completionReceipts).toBeUndefined();
  });

  it('gives distinct revisions to changes inside the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0)); // clock equals the card's current revision
    const read = task();
    await post({ action: 'update', taskId: 't1', assigneeId: BOB });
    expect(task().updatedAt).not.toBe(read.updatedAt);
    const r = await complete({ expectedUpdatedAt: read.updatedAt });
    expect(r.status).toBe(409);

    // Back-to-back completions of the same card at one frozen instant still differ.
    const a = await complete({ expectedUpdatedAt: task().updatedAt });
    const b = await complete();
    expect(a.status).toBe(200);
    expect(b.body.task.updatedAt > a.body.task.updatedAt).toBe(true);
    expect(nextTaskRevision(T0, Date.parse(T0))).toBe('2026-10-05T10:00:00.001Z');
  });
});

describe('concurrency', () => {
  it('lets only one of many concurrent guarded completions through', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      complete({ expectedAssigneeId: ALICE, expectedUpdatedAt: T0, idempotencyKey: `k-${i}` })));
    const ok = results.filter(r => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter(r => r.status === 409 && r.body.code === 'TASK_COMPLETION_CONFLICT')).toHaveLength(11);
    expect(vi.mocked(eventBus.emitEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flushJournalForTaskCompleter)).toHaveBeenCalledTimes(1);
    expect(Object.keys(readStore().completionReceipts)).toHaveLength(1);
  });

  it('turns concurrent retries of one key into one completion plus replays', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      complete({ expectedUpdatedAt: T0, idempotencyKey: 'same' })));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(results.filter(r => r.body.replayed === false)).toHaveLength(1);
    expect(results.filter(r => r.body.replayed === true)).toHaveLength(7);
    expect(vi.mocked(eventBus.emitEvent)).toHaveBeenCalledTimes(1);
  });

  it('serialises the Agent API and the route against each other', async () => {
    const { complete: agentComplete } = await import('@/app/api/agent/actions/tasks');
    const guards = { channelId: CH, taskId: 't1', participantId: ALICE, expectedUpdatedAt: T0 };
    const settled = await Promise.allSettled([
      agentComplete({ action: 'tasks.complete', ...guards }, {} as never),
      complete({ expectedUpdatedAt: T0 }),
      agentComplete({ action: 'tasks.complete', ...guards }, {} as never),
      complete({ expectedUpdatedAt: T0 }),
    ]);
    const successes = settled.filter(s =>
      s.status === 'fulfilled' && ('status' in (s.value as object) ? (s.value as { status: number }).status === 200 : true));
    expect(successes).toHaveLength(1);
  });
});

describe('idempotent retries', () => {
  const keyed = { expectedAssigneeId: ALICE, expectedUpdatedAt: T0, idempotencyKey: 'retry-1' };

  it('replays the recorded result without new effects, and survives a restart', async () => {
    const first = await complete(keyed);
    expect(first.body).toMatchObject({ success: true, replayed: false, receipt: { idempotencyKey: 'retry-1' } });

    vi.resetModules(); // new process: route, caches and module state reloaded from disk
    vi.clearAllMocks();
    const before = effects();
    const again = await complete(keyed);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ success: true, replayed: true, liveStateChanged: false });
    expect(again.body.task).toEqual(first.body.task);
    expect(again.body.receipt.recordedAt).toBe(first.body.receipt.recordedAt);
    expect(effects()).toEqual(before);
  });

  it('never closes a card that was reopened after the recorded completion', async () => {
    const first = await complete(keyed);
    await post({ action: 'update', taskId: 't1', status: 'in_progress', assigneeId: BOB });
    const before = effects();

    const replay = await complete(keyed);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, liveStateChanged: true, task: { status: 'done' } });
    expect(replay.body.task.updatedAt).toBe(first.body.task.updatedAt);
    expect(replay.body.liveTask).toMatchObject({ status: 'in_progress', assigneeId: BOB });
    expect(task().status).toBe('in_progress');
    expect(effects()).toEqual(before);
  });

  it('rejects the same key with a different request', async () => {
    await complete(keyed);
    for (const changed of [
      { ...keyed, expectedAssigneeId: null },
      { ...keyed, expectedUpdatedAt: '2026-10-05T10:00:00.002Z' },
      { expectedAssigneeId: ALICE, idempotencyKey: 'retry-1' },
      { ...keyed, participantId: BOB },
    ]) {
      const before = effects();
      const r = await complete(changed);
      expect(r.status, JSON.stringify(changed)).toBe(409);
      expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(effects()).toEqual(before);
    }
  });

  it('scopes keys to the task, and does not store a receipt for a conflict', async () => {
    const conflicted = await complete({ ...keyed, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(conflicted.status).toBe(409);
    expect(readStore().completionReceipts).toBeUndefined();

    const a = await complete(keyed);
    const b = await post({ action: 'complete', taskId: 't2', idempotencyKey: 'retry-1' });
    expect(a.body.replayed).toBe(false);
    expect(b.body.replayed).toBe(false);
    expect(Object.keys(readStore().completionReceipts)).toHaveLength(2);
  });

  it('replays across surfaces: route receipt answered by the Agent API', async () => {
    const first = await complete(keyed);
    const { complete: agentComplete } = await import('@/app/api/agent/actions/tasks');
    const res = await agentComplete({ action: 'tasks.complete', channelId: CH, taskId: 't1', participantId: ALICE, ...keyed }, {} as never);
    expect(res).toMatchObject({ completed: true, replayed: true, liveStateChanged: false });
    expect(res.task).toEqual(first.body.task);
  });
});

describe('Agent API tasks.complete', () => {
  const call = async (extra: Record<string, unknown> = {}) => {
    const { complete: agentComplete } = await import('@/app/api/agent/actions/tasks');
    return agentComplete({ action: 'tasks.complete', channelId: CH, taskId: 't1', participantId: ALICE, ...extra }, {} as never);
  };

  it('keeps the legacy response shape without guards', async () => {
    const res = await call();
    expect(Object.keys(res).sort()).toEqual(['completed', 'task']);
    expect(res.completed).toBe(true);
  });

  it('raises a typed 409 with details on a stale guard and writes nothing', async () => {
    const before = effects();
    await expect(call({ expectedAssigneeId: BOB })).rejects.toMatchObject({
      statusCode: 409,
      code: 'TASK_COMPLETION_CONFLICT',
      details: { taskId: 't1', conflicts: [{ field: 'assigneeId', expected: BOB, current: ALICE }] },
    });
    expect(effects()).toEqual(before);
  });

  it('raises a typed 400 for malformed guards and 409 for key reuse', async () => {
    await expect(call({ expectedUpdatedAt: 5 })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_COMPLETION_REQUEST' });
    await call({ idempotencyKey: 'agent-1' });
    await expect(call({ idempotencyKey: 'agent-1', expectedAssigneeId: ALICE }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
