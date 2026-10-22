import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks (must precede route import) ───────────────────────────────────────

vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn().mockImplementation((_: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null), // always allow
}));

vi.mock('@/lib/log-emitter', () => ({
  emitApiEvent: vi.fn(),
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: vi.fn().mockImplementation((_: string, handler: unknown) => handler),
  withTiming: vi.fn().mockImplementation((_: string, handler: unknown) => handler),
}));

import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { GET, POST } from '@/app/api/collab/tasks/route';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const CHANNEL_A = 'ch-aaaa-1111';
const CHANNEL_B = 'ch-bbbb-2222';
const ALICE = 'p-alice-0001';
const BOB   = 'p-bob-0002';

const baseChannelsData = {
  channels: [
    {
      id: CHANNEL_A,
      name: 'Alpha Channel',
      participants: [
        { id: ALICE, name: 'Alice', type: 'user',  status: 'online' },
        { id: BOB,   name: 'Bob',   type: 'agent', status: 'online' },
      ],
    },
  ],
  lastUpdated: '2026-01-01T00:00:00.000Z',
};

function makeTasksData(overrides: object[] = []) {
  return {
    tasks: [
      {
        id: 'task-a1',
        channelId: CHANNEL_A,
        title: 'Todo task',
        status: 'todo',
        priority: 'normal',
        sortOrder: 1,
        createdBy: ALICE,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'task-a2',
        channelId: CHANNEL_A,
        title: 'In-progress task',
        status: 'in_progress',
        priority: 'high',
        sortOrder: 2,
        assigneeId: ALICE,
        createdBy: ALICE,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'task-b1',
        channelId: CHANNEL_B,          // belongs to a different channel
        title: 'Channel B task',
        status: 'todo',
        priority: 'normal',
        sortOrder: 1,
        createdBy: BOB,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      ...overrides,
    ],
    sprints: [],
    phases: [],
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
}

// Helper to make NextRequest for GET
function makeGetRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/collab/tasks');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

// Helper to make NextRequest for POST
function makePostRequest(body: object): NextRequest {
  return new NextRequest('http://localhost:3000/api/collab/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(readJsonFile).mockImplementation(async (filePath: unknown) => {
    if (String(filePath).includes('collab-channels')) return structuredClone(baseChannelsData);
    return makeTasksData();
  });
  vi.mocked(writeJsonFile).mockResolvedValue(undefined);
});

// ─── GET: validation ─────────────────────────────────────────────────────────

describe('GET /api/collab/tasks — validation', () => {
  it('returns 400 when channelId is missing', async () => {
    const res = await GET(makeGetRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/channelId/i);
  });
});

// ─── GET: filtering ───────────────────────────────────────────────────────────

describe('GET /api/collab/tasks — filtering', () => {
  it('returns only tasks belonging to the requested channel', async () => {
    const res = await GET(makeGetRequest({ channelId: CHANNEL_A }));
    expect(res.status).toBe(200);
    const { tasks } = await res.json();
    expect(tasks.every((t: { channelId: string }) => t.channelId === CHANNEL_A)).toBe(true);
    expect(tasks.length).toBe(2);
  });

  it('cross-channel isolation — channel B tasks are not returned for channel A', async () => {
    const res = await GET(makeGetRequest({ channelId: CHANNEL_A }));
    const { tasks } = await res.json();
    expect(tasks.find((t: { id: string }) => t.id === 'task-b1')).toBeUndefined();
  });

  it('filters by status=todo', async () => {
    const res = await GET(makeGetRequest({ channelId: CHANNEL_A, status: 'todo' }));
    const { tasks } = await res.json();
    expect(tasks.every((t: { status: string }) => t.status === 'todo')).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('filters by status=in_progress', async () => {
    const res = await GET(makeGetRequest({ channelId: CHANNEL_A, status: 'in_progress' }));
    const { tasks } = await res.json();
    expect(tasks.every((t: { status: string }) => t.status === 'in_progress')).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('filters by assigneeId', async () => {
    const res = await GET(makeGetRequest({ channelId: CHANNEL_A, assigneeId: ALICE }));
    const { tasks } = await res.json();
    expect(tasks.every((t: { assigneeId: string }) => t.assigneeId === ALICE)).toBe(true);
  });

  it('includeHierarchy returns sprints and phases', async () => {
    const res = await GET(makeGetRequest({ channelId: CHANNEL_A, includeHierarchy: 'true' }));
    const body = await res.json();
    expect(body).toHaveProperty('sprints');
    expect(body).toHaveProperty('phases');
  });
});

// ─── POST: missing required fields ────────────────────────────────────────────

describe('POST /api/collab/tasks — validation', () => {
  it('returns 400 when channelId is missing', async () => {
    const res = await POST(makePostRequest({ action: 'create', participantId: ALICE, title: 'T' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/channelId/i);
  });

  it('returns 400 when participantId is missing', async () => {
    const res = await POST(makePostRequest({ action: 'create', channelId: CHANNEL_A, title: 'T' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/participantId/i);
  });

  it('returns 400 when participant is not in channel', async () => {
    const res = await POST(makePostRequest({
      action: 'create',
      channelId: CHANNEL_A,
      participantId: 'p-unknown-9999',
      title: 'T',
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for create when title is missing', async () => {
    const res = await POST(makePostRequest({
      action: 'create',
      channelId: CHANNEL_A,
      participantId: ALICE,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title/i);
  });

  it('returns 400 for unknown action', async () => {
    const res = await POST(makePostRequest({
      action: 'fly-to-moon',
      channelId: CHANNEL_A,
      participantId: ALICE,
    }));
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

// ─── POST: create ─────────────────────────────────────────────────────────────

describe('POST /api/collab/tasks — create', () => {
  it('creates a task and returns it in the response', async () => {
    const res = await POST(makePostRequest({
      action: 'create',
      channelId: CHANNEL_A,
      participantId: ALICE,
      title: 'New Task',
      description: 'Do something',
      priority: 'high',
    }));
    expect(res.status).toBe(200);
    const { success, task } = await res.json();
    expect(success).toBe(true);
    expect(task.title).toBe('New Task');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('high');
    expect(task.createdBy).toBe(ALICE);
    expect(task.channelId).toBe(CHANNEL_A);
    expect(task.id).toBeTruthy();
  });

  it('defaults priority to normal when not specified', async () => {
    const res = await POST(makePostRequest({
      action: 'create',
      channelId: CHANNEL_A,
      participantId: ALICE,
      title: 'Minimal',
    }));
    const { task } = await res.json();
    expect(task.priority).toBe('normal');
  });

  it('persists the task by calling writeJsonFile', async () => {
    await POST(makePostRequest({
      action: 'create',
      channelId: CHANNEL_A,
      participantId: ALICE,
      title: 'Persisted',
    }));
    expect(vi.mocked(writeJsonFile)).toHaveBeenCalled();
  });
});

// ─── POST: claim ──────────────────────────────────────────────────────────────

describe('POST /api/collab/tasks — claim', () => {
  it('claims a todo task: sets status in_progress and assigneeId', async () => {
    const res = await POST(makePostRequest({
      action: 'claim',
      channelId: CHANNEL_A,
      participantId: BOB,
      taskId: 'task-a1',
    }));
    expect(res.status).toBe(200);
    const { success, task } = await res.json();
    expect(success).toBe(true);
    expect(task.status).toBe('in_progress');
    expect(task.assigneeId).toBe(BOB);
  });

  it('returns 409 when task is already assigned to a different participant', async () => {
    // task-a2 is already assigned to ALICE
    const res = await POST(makePostRequest({
      action: 'claim',
      channelId: CHANNEL_A,
      participantId: BOB,
      taskId: 'task-a2',
    }));
    expect(res.status).toBe(409);
  });

  it('returns 404 when taskId does not exist in the channel', async () => {
    const res = await POST(makePostRequest({
      action: 'claim',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: 'task-b1', // belongs to CHANNEL_B, not CHANNEL_A
    }));
    expect(res.status).toBe(404);
  });
});

// ─── POST: complete ───────────────────────────────────────────────────────────

describe('POST /api/collab/tasks — complete', () => {
  it('marks a task as done and sets completedAt', async () => {
    const res = await POST(makePostRequest({
      action: 'complete',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: 'task-a2',
    }));
    expect(res.status).toBe(200);
    const { success, task } = await res.json();
    expect(success).toBe(true);
    expect(task.status).toBe('done');
    expect(task.completedAt).toBeTruthy();
  });

  it('returns 404 for a task in a different channel', async () => {
    const res = await POST(makePostRequest({
      action: 'complete',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: 'task-b1', // belongs to CHANNEL_B
    }));
    expect(res.status).toBe(404);
  });
});

// ─── POST: unclaim ────────────────────────────────────────────────────────────

describe('POST /api/collab/tasks — unclaim', () => {
  it('unassigns the task and returns it to todo', async () => {
    const res = await POST(makePostRequest({
      action: 'unclaim',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: 'task-a2', // Alice is assignee
    }));
    expect(res.status).toBe(200);
    const { success, task } = await res.json();
    expect(success).toBe(true);
    expect(task.status).toBe('todo');
    expect(task.assigneeId).toBeUndefined();
  });

  it('returns 403 when unclaiming another participant\'s task', async () => {
    // task-a2 is assigned to ALICE, BOB tries to unclaim
    // BOB is not the assignee and not the creator
    vi.mocked(readJsonFile).mockImplementation(async (filePath: unknown) => {
      if (String(filePath).includes('collab-channels')) return structuredClone(baseChannelsData);
      return makeTasksData([{
        id: 'task-a3',
        channelId: CHANNEL_A,
        title: 'Bob cannot unclaim',
        status: 'in_progress',
        priority: 'normal',
        sortOrder: 3,
        assigneeId: ALICE,
        createdBy: ALICE, // Alice created it, Alice is assignee, Bob has no rights
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]);
    });
    const res = await POST(makePostRequest({
      action: 'unclaim',
      channelId: CHANNEL_A,
      participantId: BOB,
      taskId: 'task-a3',
    }));
    expect(res.status).toBe(403);
  });
});

// ─── POST: delete ─────────────────────────────────────────────────────────────

describe('POST /api/collab/tasks — delete', () => {
  it('deletes a task when the requester is the creator', async () => {
    const res = await POST(makePostRequest({
      action: 'delete',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: 'task-a1', // Alice is creator
    }));
    expect(res.status).toBe(200);
    const { success } = await res.json();
    expect(success).toBe(true);
  });

  it('returns 403 when a non-creator tries to delete', async () => {
    const res = await POST(makePostRequest({
      action: 'delete',
      channelId: CHANNEL_A,
      participantId: BOB,
      taskId: 'task-a1', // Alice is creator, not Bob
    }));
    expect(res.status).toBe(403);
  });

  it('returns 404 when task is in a different channel', async () => {
    const res = await POST(makePostRequest({
      action: 'delete',
      channelId: CHANNEL_A,
      participantId: BOB,
      taskId: 'task-b1', // belongs to CHANNEL_B
    }));
    expect(res.status).toBe(404);
  });
});

// ─── POST: cross-channel access guard ────────────────────────────────────────

describe('POST /api/collab/tasks — cross-channel isolation', () => {
  it('update cannot modify a task from a different channel', async () => {
    const res = await POST(makePostRequest({
      action: 'update',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: 'task-b1', // belongs to CHANNEL_B
      title: 'Hijacked',
    }));
    expect(res.status).toBe(404);
  });
});

// ─── POST: stale-ID defensive hints ──────────────────────────────────────────

describe('POST /api/collab/tasks — stale-ID defensive hints', () => {
  const STALE_TASK_ID = 'task-dead-0000';
  const STALE_SPRINT_ID = 'sprint-dead-0000';

  it('claim with a non-existent taskId returns 404 with a fetch-current-state hint', async () => {
    const res = await POST(makePostRequest({
      action: 'claim',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: STALE_TASK_ID,
    }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/completed or removed/i);
    expect(body.error).toContain('/api/collab/tasks');
    expect(body.error).toContain(CHANNEL_A);
  });

  it('complete with a non-existent taskId returns 404 with a fetch-current-state hint', async () => {
    const res = await POST(makePostRequest({
      action: 'complete',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: STALE_TASK_ID,
    }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/completed or removed/i);
    expect(body.error).toContain('/api/collab/tasks');
  });

  it('update with a non-existent taskId returns 404 with a fetch-current-state hint', async () => {
    const res = await POST(makePostRequest({
      action: 'update',
      channelId: CHANNEL_A,
      participantId: ALICE,
      taskId: STALE_TASK_ID,
      title: 'Too late',
    }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/completed or removed/i);
  });

  it('update-sprint with a non-existent sprintId returns 404 with a fetch-current-state hint', async () => {
    const res = await POST(makePostRequest({
      action: 'update-sprint',
      channelId: CHANNEL_A,
      participantId: ALICE,
      sprintId: STALE_SPRINT_ID,
      updates: { name: 'Ghost Sprint' },
    }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/completed or removed/i);
    expect(body.error).toContain('/api/collab/tasks');
  });
});
