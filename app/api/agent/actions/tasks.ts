/**
 * Task Board Actions
 *
 * Actions for managing tasks in collaboration channels.
 */

import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import {
  applyTaskCompletion,
  conflictMessage,
  IDEMPOTENCY_KEY_REUSED,
  INVALID_COMPLETION_REQUEST,
  KEY_REUSED_MESSAGE,
  nextTaskRevision,
  parseCompletionRequest,
  TASK_COMPLETION_CONFLICT,
} from '@/lib/task-completion';
import type {
  AgentApiRequest,
  AgentAuthContext,
  CollabTask,
  CollabTasksData,
  CollabTaskStatus,
  CollabTaskPriority,
  CollabChannelsData,
  SessionsData,
} from '@/lib/types';

const TASKS_PATH = DataPaths.collabTasks;
const SESSIONS_PATH = DataPaths.sessions;
const CHANNELS_PATH = DataPaths.collabChannels;

const DEFAULT_SESSIONS_DATA: SessionsData = {
  sessions: [],
  config: { pollInterval: 5000, staleThreshold: 30, autoDiscovery: true },
  lastUpdated: new Date().toISOString(),
};

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

/** Verify the caller participant is a member of the target channel. */
async function verifyChannelMembership(channelId: string, participantId: string): Promise<void> {
  const channelsData = await readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);
  const channel = channelsData.channels.find(c => c.id === channelId);
  if (!channel) {
    throw new Error('Channel not found');
  }
  const participant = channel.participants.find(p => p.id === participantId);
  if (!participant) {
    throw new Error('Participant is not a member of this channel');
  }
}

/** Update session sprint tracking fields if a sessionId is provided. Fire-and-forget, non-blocking. */
async function updateSessionTaskLink(
  sessionId: string | undefined,
  taskTitle: string | undefined,
  taskId: string | undefined
): Promise<void> {
  if (!sessionId) return;
  try {
    await withFileLock(SESSIONS_PATH, async () => {
      const data = await readJsonFile<SessionsData>(SESSIONS_PATH, DEFAULT_SESSIONS_DATA);
      const session = data.sessions.find(s => s.sessionId === sessionId);
      if (!session) return;
      session.currentTask = taskTitle;
      session.currentTaskId = taskId;
      session.lastHeartbeat = new Date().toISOString();
      data.lastUpdated = new Date().toISOString();
      await writeJsonFile(SESSIONS_PATH, data);
    });
  } catch {
    // Non-fatal: session tracking failure should not block task operations
  }
}

const DEFAULT_TASKS_DATA: CollabTasksData = {
  tasks: [],
  lastUpdated: new Date().toISOString(),
};

async function loadTasksData(): Promise<CollabTasksData> {
  return readJsonFile<CollabTasksData>(TASKS_PATH, DEFAULT_TASKS_DATA);
}

async function saveTasksData(data: CollabTasksData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(TASKS_PATH, data);
}

const VALID_TASK_STATUSES: readonly CollabTaskStatus[] = ['todo', 'in_progress', 'done'] as const;

/**
 * Throws a clear 400-style error if status is set to anything other than
 * 'todo' | 'in_progress' | 'done'. The historical silent-drop behaviour
 * caused progress-bar drift when callers wrote `'completed'` and assumed
 * the task was done; sprint progress is derived from `status === 'done'`,
 * so any drift here corrupts every progress view downstream.
 */
function assertValidStatus(status: unknown): asserts status is CollabTaskStatus {
  if (typeof status !== 'string' || !VALID_TASK_STATUSES.includes(status as CollabTaskStatus)) {
    const suggestion = status === 'completed' ? " Did you mean 'done'?" : '';
    throw new Error(
      `Invalid task status ${JSON.stringify(status)}. Valid: todo | in_progress | done.${suggestion}`
    );
  }
}

/**
 * Throws if sprintId is provided but the sprint does not exist in this channel.
 * Prevents tasks from being created/updated with stale sprint references that
 * would never appear on any progress bar (orphans).
 */
function assertSprintRefValid(
  data: CollabTasksData,
  channelId: string,
  sprintId: string | undefined | null
): void {
  if (!sprintId) return;
  const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);
  if (!sprint) {
    throw new Error(
      `sprintId references unknown sprint in this channel: ${sprintId}. ` +
      `List current sprints via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true.`
    );
  }
}

/**
 * Throws if phaseId is provided but either does not exist or does not belong
 * to the task's sprint (catches mis-wiring where the agent picked a phaseId
 * from the wrong sprint).
 */
function assertPhaseRefValid(
  data: CollabTasksData,
  channelId: string,
  phaseId: string | undefined | null,
  sprintId: string | undefined | null
): void {
  if (!phaseId) return;
  const phase = (data.phases || []).find(p => p.id === phaseId && p.channelId === channelId);
  if (!phase) {
    throw new Error(
      `phaseId references unknown phase in this channel: ${phaseId}. ` +
      `List current phases via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true.`
    );
  }
  if (sprintId && phase.sprintId && phase.sprintId !== sprintId) {
    throw new Error(
      `phaseId ${phaseId} belongs to sprint ${phase.sprintId}, not ${sprintId}. ` +
      `Pass the matching sprintId or pick a phase from the correct sprint.`
    );
  }
}

/**
 * tasks.list - List tasks in a channel
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ tasks: CollabTask[]; count: number }> {
  const channelId = body.channelId;
  const status = body.status as CollabTaskStatus | undefined;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  const data = await loadTasksData();

  let tasks = data.tasks.filter(t => t.channelId === channelId);

  if (status && ['todo', 'in_progress', 'done'].includes(status)) {
    tasks = tasks.filter(t => t.status === status);
  }

  // Sort by sortOrder
  tasks.sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    tasks,
    count: tasks.length,
  };
}

/**
 * tasks.create - Create a new task
 */
export async function create(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ task: CollabTask }> {
  const channelId = body.channelId;
  const participantId = body.participantId;
  const title = body.title;
  const description = body.description;
  const priority = body.priority as CollabTaskPriority | undefined;
  const tags = body.tags;
  const sprintId = body.sprintId;
  const phaseId = body.phaseId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }
  if (!title || typeof title !== 'string') {
    throw new Error('title is required');
  }

  await verifyChannelMembership(channelId, participantId);

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const now = new Date().toISOString();

    const resolvedSprintId = typeof sprintId === 'string' ? sprintId : undefined;
    const resolvedPhaseId = typeof phaseId === 'string' ? phaseId : undefined;
    assertSprintRefValid(data, channelId, resolvedSprintId);
    assertPhaseRefValid(data, channelId, resolvedPhaseId, resolvedSprintId);

    // Get max sortOrder for this channel's todo column
    const channelTasks = data.tasks.filter(t => t.channelId === channelId && t.status === 'todo');
    const maxSortOrder = channelTasks.length > 0
      ? Math.max(...channelTasks.map(t => t.sortOrder))
      : -1;

    const newTask: CollabTask = {
      id: crypto.randomUUID(),
      channelId,
      title,
      description: typeof description === 'string' ? description : undefined,
      status: 'todo',
      priority: priority && ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
      sortOrder: maxSortOrder + 1,
      createdBy: participantId,
      createdAt: now,
      updatedAt: now,
      tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string') : undefined,
      sprintId: resolvedSprintId,
      phaseId: resolvedPhaseId,
    };

    data.tasks.push(newTask);
    await saveTasksData(data);

    return { task: newTask };
  });
}

/**
 * tasks.update - Update a task
 */
export async function update(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ task: CollabTask }> {
  const channelId = body.channelId;
  const taskId = body.taskId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  await verifyChannelMembership(channelId, participantId);

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const task = data.tasks.find(t => t.id === taskId && t.channelId === channelId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}`);
    }

    // Update fields if provided
    if (body.title !== undefined && typeof body.title === 'string') {
      task.title = body.title;
    }
    if (body.description !== undefined) {
      task.description = typeof body.description === 'string' ? body.description : undefined;
    }
    if (body.priority !== undefined && ['low', 'normal', 'high'].includes(body.priority as string)) {
      task.priority = body.priority as CollabTaskPriority;
    }
    if (body.status !== undefined) {
      assertValidStatus(body.status);
      task.status = body.status;
      if (body.status === 'done' && !task.completedAt) {
        task.completedAt = new Date().toISOString();
      }
    }
    if (body.tags !== undefined) {
      task.tags = Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string') : undefined;
    }
    // Resolve final sprint/phase IDs (post-update) and validate as a pair so a
    // phaseId change that no longer matches the (possibly also updated) sprintId
    // is rejected up front instead of silently producing an orphan.
    const nextSprintId = body.sprintId !== undefined
      ? (typeof body.sprintId === 'string' ? body.sprintId : undefined)
      : task.sprintId;
    const nextPhaseId = body.phaseId !== undefined
      ? (typeof body.phaseId === 'string' ? body.phaseId : undefined)
      : task.phaseId;
    if (body.sprintId !== undefined || body.phaseId !== undefined) {
      assertSprintRefValid(data, channelId, nextSprintId);
      assertPhaseRefValid(data, channelId, nextPhaseId, nextSprintId);
    }
    if (body.sprintId !== undefined) task.sprintId = nextSprintId;
    if (body.phaseId !== undefined) task.phaseId = nextPhaseId;

    task.updatedAt = nextTaskRevision(task.updatedAt);

    // Real board progress clears any active snooze on the parent sprint
    if (task.sprintId) {
      const sprint = (data.sprints || []).find(s => s.id === task.sprintId && s.channelId === channelId);
      if (sprint) {
        sprint.reminderSnoozeUntil = undefined;
        sprint.reminderSnoozeReason = undefined;
      }
    }

    await saveTasksData(data);

    return { task };
  });
}

/**
 * tasks.claim - Claim a task
 */
export async function claim(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ task: CollabTask; claimed: boolean }> {
  const channelId = body.channelId;
  const taskId = body.taskId;
  const participantId = body.participantId;
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  await verifyChannelMembership(channelId, participantId);

  const result = await withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const task = data.tasks.find(t => t.id === taskId && t.channelId === channelId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}`);
    }

    const now = new Date().toISOString();
    task.assigneeId = participantId;
    task.assignedAt = now;
    task.status = 'in_progress';
    task.updatedAt = nextTaskRevision(task.updatedAt);

    // Real board progress clears any active snooze on the parent sprint
    if (task.sprintId) {
      const sprint = (data.sprints || []).find(s => s.id === task.sprintId && s.channelId === channelId);
      if (sprint) {
        sprint.reminderSnoozeUntil = undefined;
        sprint.reminderSnoozeReason = undefined;
      }
    }

    await saveTasksData(data);

    return { task, claimed: true };
  });

  // Cross-link: update session sprint tracking (fire-and-forget)
  void updateSessionTaskLink(sessionId, result.task.title, result.task.id);

  return result;
}

/**
 * tasks.unclaim - Release a claimed task
 */
export async function unclaim(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ task: CollabTask; unclaimed: boolean }> {
  const channelId = body.channelId;
  const taskId = body.taskId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  await verifyChannelMembership(channelId, participantId);

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const task = data.tasks.find(t => t.id === taskId && t.channelId === channelId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}`);
    }

    // Only allow unclaim if the participant is the assignee
    if (task.assigneeId !== participantId) {
      throw new Error('Only the assigned participant can unclaim this task');
    }

    const now = new Date().toISOString();
    task.assigneeId = undefined;
    task.assignedAt = undefined;
    task.status = 'todo';
    task.updatedAt = nextTaskRevision(task.updatedAt);

    await saveTasksData(data);

    return { task, unclaimed: true };
  });
}

/** tasks.complete result. Optional fields appear only when an idempotencyKey was supplied. */
interface CompleteResult {
  task: CollabTask;
  completed: boolean;
  replayed?: boolean;
  receipt?: { idempotencyKey: string; recordedAt: string; participantId: string };
  liveTask?: CollabTask | null;
  liveStateChanged?: boolean;
}

/**
 * tasks.complete - Mark a task as complete.
 * Optional expectedAssigneeId / expectedUpdatedAt guards and idempotencyKey: see lib/task-completion.ts.
 */
export async function complete(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<CompleteResult> {
  const channelId = body.channelId;
  const taskId = body.taskId;
  const participantId = body.participantId;
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  await verifyChannelMembership(channelId, participantId);

  // Same guard/receipt contract as POST /api/collab/tasks `complete` (lib/task-completion.ts).
  const parsed = parseCompletionRequest(body);
  if (!parsed.ok) {
    throw Object.assign(new Error(parsed.error), { statusCode: 400, code: INVALID_COMPLETION_REQUEST });
  }

  const result = await withFileLock(TASKS_PATH, async (): Promise<CompleteResult> => {
    const data = await loadTasksData();
    const outcome = applyTaskCompletion(data, parsed.request);

    switch (outcome.kind) {
      case 'not_found':
        throw new Error(`Task not found: ${taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}`);
      case 'conflict':
        throw Object.assign(new Error(conflictMessage(outcome.conflicts)), {
          statusCode: 409,
          code: TASK_COMPLETION_CONFLICT,
          details: { taskId, conflicts: outcome.conflicts, current: outcome.current },
        });
      case 'key_conflict':
        throw Object.assign(new Error(KEY_REUSED_MESSAGE), {
          statusCode: 409,
          code: IDEMPOTENCY_KEY_REUSED,
          details: { taskId },
        });
      case 'replay': {
        const r = outcome.receipt;
        return {
          task: r.task,
          completed: true,
          replayed: true,
          receipt: { idempotencyKey: r.idempotencyKey, recordedAt: r.recordedAt, participantId: r.participantId },
          liveTask: outcome.liveTask,
          liveStateChanged: outcome.liveStateChanged,
        };
      }
      case 'completed': {
        await saveTasksData(data);
        const r = outcome.receipt;
        return r
          ? { task: outcome.task, completed: true, replayed: false, receipt: { idempotencyKey: r.idempotencyKey, recordedAt: r.recordedAt, participantId: r.participantId } }
          : { task: outcome.task, completed: true };
      }
    }
  });

  // A replay changes nothing, so it leaves the session link alone too.
  if (result.replayed) return result;

  // Cross-link: clear session sprint tracking (fire-and-forget)
  void updateSessionTaskLink(sessionId, undefined, undefined);

  return result;
}

/**
 * tasks.assigned - Get tasks assigned to a specific participant in a channel
 */
export async function assigned(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ tasks: CollabTask[]; count: number }> {
  const channelId = body.channelId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  const data = await loadTasksData();

  const tasks = data.tasks
    .filter(t => t.channelId === channelId && t.assigneeId === participantId && t.status === 'in_progress')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return { tasks, count: tasks.length };
}

/**
 * tasks.delete - Delete a task
 */
export async function remove(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deleted: boolean; taskId: string }> {
  const channelId = body.channelId;
  const taskId = body.taskId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  await verifyChannelMembership(channelId, participantId);

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const taskIndex = data.tasks.findIndex(t => t.id === taskId && t.channelId === channelId);

    if (taskIndex === -1) {
      throw new Error(`Task not found: ${taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}`);
    }

    data.tasks.splice(taskIndex, 1);
    await saveTasksData(data);

    return { deleted: true, taskId };
  });
}

/**
 * tasks.current - Get the single in-progress task claimed by a participant
 *
 * Returns the participant's currently active sprint task (or null if none).
 * Intended for agents to query their own active task at session start.
 */
export async function current(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ task: CollabTask | null; found: boolean }> {
  const channelId = body.channelId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  const data = await loadTasksData();

  const task = data.tasks
    .filter(t => t.channelId === channelId && t.assigneeId === participantId && t.status === 'in_progress')
    .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;

  return { task, found: task !== null };
}

/**
 * tasks.next - Get the next unclaimed task in a channel
 *
 * Returns the lowest-sortOrder todo task not yet assigned to anyone.
 * Optionally filter by phaseId or tags. Intended for workflow automation.
 */
export async function next(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ task: CollabTask | null; found: boolean }> {
  const channelId = body.channelId;
  const phaseId = typeof body.phaseId === 'string' ? body.phaseId : undefined;
  const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  const data = await loadTasksData();

  let candidates = data.tasks.filter(
    t => t.channelId === channelId && t.status === 'todo' && !t.assigneeId
  );

  if (phaseId) {
    candidates = candidates.filter(t => t.phaseId === phaseId);
  }

  if (tags && tags.length > 0) {
    candidates = candidates.filter(t => tags.some(tag => t.tags?.includes(tag)));
  }

  candidates.sort((a, b) => a.sortOrder - b.sortOrder);
  const task = candidates[0] ?? null;

  return { task, found: task !== null };
}

/**
 * tasks.workflow - Sprint workflow entry point for agents
 *
 * Returns the participant's current in_progress task if they have one.
 * If not, returns the next available unclaimed todo task.
 * Agents should call this at session start to know where to pick up.
 */
export async function workflow(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  currentTask: CollabTask | null;
  nextTask: CollabTask | null;
  status: 'working' | 'idle' | 'no_tasks';
  message: string;
}> {
  const channelId = body.channelId;
  const participantId = body.participantId;
  const phaseId = typeof body.phaseId === 'string' ? body.phaseId : undefined;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  const data = await loadTasksData();

  // Find current task for this participant
  const currentTask = data.tasks
    .filter(t => t.channelId === channelId && t.assigneeId === participantId && t.status === 'in_progress')
    .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;

  if (currentTask) {
    return {
      currentTask,
      nextTask: null,
      status: 'working',
      message: `You have an active task: "${currentTask.title}"`,
    };
  }

  // Find next unclaimed task
  let candidates = data.tasks.filter(
    t => t.channelId === channelId && t.status === 'todo' && !t.assigneeId
  );

  if (phaseId) {
    candidates = candidates.filter(t => t.phaseId === phaseId);
  }

  candidates.sort((a, b) => a.sortOrder - b.sortOrder);
  const nextTask = candidates[0] ?? null;

  if (nextTask) {
    return {
      currentTask: null,
      nextTask,
      status: 'idle',
      message: `No active task. Next available: "${nextTask.title}" (${nextTask.id.slice(0, 8)}) — claim it with tasks.claim`,
    };
  }

  return {
    currentTask: null,
    nextTask: null,
    status: 'no_tasks',
    message: 'No active task and no unclaimed tasks in this channel.',
  };
}
