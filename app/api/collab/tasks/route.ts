import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireAuthOrLocal } from '@/lib/api-auth';
import type {
  CollabTask,
  CollabTaskStatus,
  CollabTasksData,
  CollabTasksResponse,
  CollabTaskActionRequest,
  CollabTaskActionResponse,
  CollabChannelsData,
} from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { emitApiEvent } from '@/lib/log-emitter';
import { eventBus } from '@/lib/event-bus';
import { tracked, withTiming } from '@/lib/api-tracking';
import { tmuxSendKeys } from '@/lib/tmux-send';
import { flushJournalForTaskCompleter } from '@/lib/task-complete-flush';
import { isAgentIdleForCompact } from '@/lib/agent-session-state';
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

const TASKS_PATH = DataPaths.collabTasks;
const CHANNELS_PATH = DataPaths.collabChannels;

const DEFAULT_TASKS_DATA: CollabTasksData = {
  tasks: [],
  sprints: [],
  phases: [],
  lastUpdated: new Date().toISOString(),
};

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

async function readTasksData(): Promise<CollabTasksData> {
  return readJsonFile<CollabTasksData>(TASKS_PATH, DEFAULT_TASKS_DATA);
}

async function writeTasksData(data: CollabTasksData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(TASKS_PATH, data);
}

const VALID_TASK_STATUSES: readonly CollabTaskStatus[] = ['todo', 'in_progress', 'done'] as const;

/** Returns a validation error message when status is not a recognised value, else null. */
function validateTaskStatus(status: unknown): string | null {
  if (typeof status !== 'string' || !VALID_TASK_STATUSES.includes(status as CollabTaskStatus)) {
    const suggestion = status === 'completed' ? " Did you mean 'done'?" : '';
    return `Invalid task status ${JSON.stringify(status)}. Valid: todo | in_progress | done.${suggestion}`;
  }
  return null;
}

/** Returns an integrity error message when sprintId is set but unknown in this channel, else null. */
function validateSprintRef(
  data: CollabTasksData,
  channelId: string,
  sprintId: string | undefined | null
): string | null {
  if (!sprintId) return null;
  const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);
  if (!sprint) {
    return `sprintId references unknown sprint in this channel: ${sprintId}. ` +
      `List current sprints via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true.`;
  }
  return null;
}

/** Returns an integrity error message when phaseId is unknown or belongs to a different sprint, else null. */
function validatePhaseRef(
  data: CollabTasksData,
  channelId: string,
  phaseId: string | undefined | null,
  sprintId: string | undefined | null
): string | null {
  if (!phaseId) return null;
  const phase = (data.phases || []).find(p => p.id === phaseId && p.channelId === channelId);
  if (!phase) {
    return `phaseId references unknown phase in this channel: ${phaseId}. ` +
      `List current phases via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true.`;
  }
  if (sprintId && phase.sprintId && phase.sprintId !== sprintId) {
    return `phaseId ${phaseId} belongs to sprint ${phase.sprintId}, not ${sprintId}. ` +
      `Pass the matching sprintId or pick a phase from the correct sprint.`;
  }
  return null;
}

/**
 * Sprint 38 T4.6 — server-side /flush-journal trigger for tasks.complete.
 *
 * Fire-and-forget wrapper around `flushJournalForTaskCompleter`. Looks
 * the claiming participant up in the channel roster and sends
 * `/flush-journal` over tmux-send to their session. Never throws:
 * every failure is captured and emitted via `emitApiEvent` at medium
 * severity for observability. The API response returns immediately.
 */
async function triggerTaskCompletionFlush(
  channelId: string,
  participantId: string,
  taskTitle: string,
  requestId: string,
): Promise<void> {
  try {
    const channelsData = await readJsonFile<CollabChannelsData>(
      CHANNELS_PATH,
      DEFAULT_CHANNELS_DATA,
    );
    const channel = (channelsData.channels || []).find((c) => c.id === channelId);
    const roster = channel?.roster?.agents ?? [];
    const res = await flushJournalForTaskCompleter(participantId, roster, {
      sendKeys: tmuxSendKeys,
      isIdle: (dir) => isAgentIdleForCompact(dir),
    });

    if (res.fired) {
      emitApiEvent({
        action: 'tasks.complete.flushjournal',
        status: 200,
        durationMs: 0,
        requestId,
        severity: 'info',
        channelId,
        actor: participantId,
        summary: `flush-journal fired for ${res.agentName} (${res.tmuxSessionName}) after task: ${taskTitle}`,
      });
    } else {
      // Skips are expected + normal (non-running agent, no tmux, etc).
      // Log at 'low' severity so they don't clutter the monitor.
      emitApiEvent({
        action: 'tasks.complete.flushjournal',
        status: 200,
        durationMs: 0,
        requestId,
        severity: 'low',
        channelId,
        actor: participantId,
        summary: `flush-journal skipped: ${res.reason ?? 'unknown'}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitApiEvent({
      action: 'tasks.complete.flushjournal',
      status: 500,
      durationMs: 0,
      requestId,
      severity: 'medium',
      channelId,
      actor: participantId,
      summary: `flush-journal trigger threw: ${msg}`,
    });
  }
}

/**
 * After a task is marked done, check if all tasks in its sprint are done.
 * If so, auto-complete the sprint. Call this AFTER writeTasksData.
 */
function autoCompleteSprint(data: CollabTasksData, sprintId: string | undefined): void {
  if (!sprintId) return;
  const sprint = (data.sprints || []).find(s => s.id === sprintId);
  if (!sprint || sprint.status === 'completed' || sprint.status === 'cancelled') return;

  const sprintTasks = data.tasks.filter(t => t.sprintId === sprintId);
  if (sprintTasks.length === 0) return;

  const allDone = sprintTasks.every(t => t.status === 'done');
  if (allDone) {
    sprint.status = 'completed';
    sprint.updatedAt = new Date().toISOString();
  }
}

// Update participant activity status (locked write to channels file)
async function updateActivityStatus(
  channelId: string,
  participantId: string,
  activityStatus: 'idle' | 'typing' | 'working'
): Promise<void> {
  try {
    await mutateChannels('tasks-api:activity-status', async channelsData => {
      const channel = channelsData.channels.find(c => c.id === channelId);

      if (channel) {
        const participant = channel.participants.find(p => p.id === participantId);
        if (participant) {
          participant.activityStatus = activityStatus;
          participant.activityUpdatedAt = new Date().toISOString();
          participant.lastSeen = new Date().toISOString();
          await saveChannels(channelsData);
        }
      }
    });
  } catch (err) {
    console.error('[Tasks] Failed to update activity status:', err);
  }
}

// Verify channel and participant exist (read-only, no lock needed)
async function verifyChannelAndParticipant(
  channelId: string,
  participantId: string
): Promise<{ valid: boolean; error?: string; participantName?: string }> {
  try {
    const channelsData = await readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);
    const channel = channelsData.channels.find(c => c.id === channelId);

    if (!channel) {
      return { valid: false, error: 'Channel not found' };
    }

    const participant = channel.participants.find(p => p.id === participantId);
    if (!participant) {
      return { valid: false, error: 'Participant not found in channel' };
    }

    return { valid: true, participantName: participant.name };
  } catch {
    return { valid: false, error: 'Could not verify channel/participant' };
  }
}

/**
 * GET /api/collab/tasks
 * Query params:
 * - channelId: Filter by channel (required)
 * - status: Filter by status (optional)
 * - assigneeId: Filter by assignee (optional)
 * - includeHierarchy: Include sprints and phases (optional)
 */
export const GET = withTiming('/api/collab/tasks', tracked('/api/collab/tasks', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = request.nextUrl;
    const channelId = searchParams.get('channelId');
    const status = searchParams.get('status');
    const assigneeId = searchParams.get('assigneeId');
    const includeHierarchy = searchParams.get('includeHierarchy') === 'true';

    if (!channelId) {
      return NextResponse.json<CollabTasksResponse>({
        tasks: [],
        timestamp: new Date().toISOString(),
        error: 'channelId is required',
      }, { status: 400 });
    }

    const data = await readTasksData();

    // Filter tasks
    let tasks = data.tasks.filter(t => t.channelId === channelId);

    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }

    if (assigneeId) {
      tasks = tasks.filter(t => t.assigneeId === assigneeId);
    }

    // Sort by sortOrder (ascending), fallback to priority then creation date
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    tasks.sort((a, b) => {
      // Primary: sortOrder (lower = higher priority)
      const sortOrderA = a.sortOrder ?? 999999;
      const sortOrderB = b.sortOrder ?? 999999;
      if (sortOrderA !== sortOrderB) return sortOrderA - sortOrderB;
      // Secondary: priority
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      // Tertiary: creation date (newest first)
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Include hierarchy data if requested
    if (includeHierarchy) {
      const sprints = (data.sprints || []).filter(s => s.channelId === channelId);
      const phases = (data.phases || []).filter(p => p.channelId === channelId);

      return NextResponse.json({
        tasks,
        sprints,
        phases,
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json<CollabTasksResponse>({
      tasks,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in GET /api/collab/tasks:', error);
    return NextResponse.json<CollabTasksResponse>({
      tasks: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}));

/**
 * POST /api/collab/tasks
 * Actions: create, update, claim, unclaim, complete, delete
 */
export const POST = withTiming('/api/collab/tasks', tracked('/api/collab/tasks', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'write');
    if (authDenied) return authDenied;

    const body: CollabTaskActionRequest = await request.json();
    const now = new Date().toISOString();

    // Validate required fields
    if (!body.channelId) {
      return NextResponse.json<CollabTaskActionResponse>({
        success: false,
        error: 'channelId is required',
      }, { status: 400 });
    }

    if (!body.participantId) {
      return NextResponse.json<CollabTaskActionResponse>({
        success: false,
        error: 'participantId is required',
      }, { status: 400 });
    }

    // Verify participant exists in channel
    const verification = await verifyChannelAndParticipant(body.channelId, body.participantId);
    if (!verification.valid) {
      return NextResponse.json<CollabTaskActionResponse>({
        success: false,
        error: verification.error,
      }, { status: 400 });
    }

    // All task mutations go through a file lock
    return await withFileLock(TASKS_PATH, async () => {
    const data = await readTasksData();

    switch (body.action) {
      case 'create': {
        if (!body.title) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'title is required',
          }, { status: 400 });
        }

        const sprintRefErr = validateSprintRef(data, body.channelId, body.sprintId);
        if (sprintRefErr) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: sprintRefErr,
          }, { status: 400 });
        }
        const phaseRefErr = validatePhaseRef(data, body.channelId, body.phaseId, body.sprintId);
        if (phaseRefErr) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: phaseRefErr,
          }, { status: 400 });
        }

        // Calculate sortOrder: find max in same channel/status, add 1
        const sameStatusTasks = data.tasks.filter(
          t => t.channelId === body.channelId && t.status === 'todo'
        );
        const maxSortOrder = sameStatusTasks.reduce(
          (max, t) => Math.max(max, t.sortOrder ?? 0), 0
        );

        const newTask: CollabTask = {
          id: randomUUID(),
          channelId: body.channelId,
          title: body.title,
          description: body.description,
          status: 'todo',
          priority: body.priority || 'normal',
          sortOrder: maxSortOrder + 1,
          createdBy: body.participantId,
          createdAt: now,
          updatedAt: now,
          tags: body.tags,
          sprintId: body.sprintId,
          phaseId: body.phaseId,
        };

        data.tasks.push(newTask);
        await writeTasksData(data);

        eventBus.emitEvent('collab:task', {
          action: 'create',
          task: newTask,
          channelId: body.channelId,
        });

        emitApiEvent({
          action: 'tasks.create',
          status: 200,
          durationMs: 0,
          requestId: randomUUID(),
          severity: 'info',
          actor: body.participantId,
          channelId: body.channelId,
          summary: `Task created: ${newTask.title}`,
        });

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          taskId: newTask.id,
          task: newTask,
        });
      }

      case 'update': {
        if (!body.taskId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'taskId is required',
          }, { status: 400 });
        }

        const taskIndex = data.tasks.findIndex(t => t.id === body.taskId && t.channelId === body.channelId);
        if (taskIndex === -1) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Task not found: ${body.taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}`,
          }, { status: 404 });
        }

        const task = data.tasks[taskIndex];

        // Status validation: reject any value outside {todo, in_progress, done}
        // with a 400 + suggestion. Historical silent-drop caused progress-bar
        // drift when callers wrote 'completed' assuming success.
        if (body.status !== undefined) {
          const statusErr = validateTaskStatus(body.status);
          if (statusErr) {
            return NextResponse.json<CollabTaskActionResponse>({
              success: false,
              error: statusErr,
            }, { status: 400 });
          }
        }

        // Sprint/phase reference integrity (validate the post-update pair
        // so a phaseId change that no longer fits the sprint is caught up front).
        if (body.sprintId !== undefined || body.phaseId !== undefined) {
          const nextSprintId = body.sprintId !== undefined ? body.sprintId : task.sprintId;
          const nextPhaseId = body.phaseId !== undefined ? body.phaseId : task.phaseId;
          const sprintRefErr = validateSprintRef(data, body.channelId, nextSprintId);
          if (sprintRefErr) {
            return NextResponse.json<CollabTaskActionResponse>({
              success: false,
              error: sprintRefErr,
            }, { status: 400 });
          }
          const phaseRefErr = validatePhaseRef(data, body.channelId, nextPhaseId, nextSprintId);
          if (phaseRefErr) {
            return NextResponse.json<CollabTaskActionResponse>({
              success: false,
              error: phaseRefErr,
            }, { status: 400 });
          }
        }

        // Update allowed fields
        if (body.title !== undefined) task.title = body.title;
        if (body.description !== undefined) task.description = body.description;
        if (body.priority !== undefined) task.priority = body.priority;
        if (body.status !== undefined) {
          task.status = body.status;
          if (body.status === 'done' && !task.completedAt) {
            task.completedAt = now;
          }
        }
        if (body.sprintId !== undefined) task.sprintId = body.sprintId;
        if (body.phaseId !== undefined) task.phaseId = body.phaseId;
        if (body.tags !== undefined) task.tags = body.tags;
        if (body.notes !== undefined) task.notes = body.notes;
        if (body.resolution !== undefined) task.resolution = body.resolution;
        // Assignee can be changed via update (admin reassignment).
        // Empty string or null clears the assignee (equivalent to unclaim).
        if (body.assigneeId !== undefined) {
          if (body.assigneeId) {
            task.assigneeId = body.assigneeId;
            task.assignedAt = now;
          } else {
            task.assigneeId = undefined;
            task.assignedAt = undefined;
          }
        }
        task.updatedAt = nextTaskRevision(task.updatedAt);

        if (task.status === 'done') autoCompleteSprint(data, task.sprintId);
        await writeTasksData(data);

        eventBus.emitEvent('collab:task', {
          action: 'update',
          task,
          channelId: body.channelId,
        });

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          taskId: task.id,
          task,
        });
      }

      case 'claim': {
        if (!body.taskId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'taskId is required',
          }, { status: 400 });
        }

        const taskIndex = data.tasks.findIndex(t => t.id === body.taskId && t.channelId === body.channelId);
        if (taskIndex === -1) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Task not found: ${body.taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}`,
          }, { status: 404 });
        }

        const task = data.tasks[taskIndex];

        if (task.assigneeId && task.assigneeId !== body.participantId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'Task is already assigned to another participant',
          }, { status: 409 });
        }

        task.assigneeId = body.participantId;
        task.assignedAt = now;
        task.status = 'in_progress';
        task.updatedAt = nextTaskRevision(task.updatedAt);

        await writeTasksData(data);

        // Update activity status to 'working'
        await updateActivityStatus(body.channelId, body.participantId, 'working');

        eventBus.emitEvent('collab:task', {
          action: 'claim',
          task,
          channelId: body.channelId,
        });

        emitApiEvent({
          action: 'tasks.claim',
          status: 200,
          durationMs: 0,
          requestId: randomUUID(),
          severity: 'info',
          actor: body.participantId,
          channelId: body.channelId,
          summary: `Task claimed: ${task.title} by ${verification.participantName}`,
        });

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          taskId: task.id,
          task,
        });
      }

      case 'unclaim': {
        if (!body.taskId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'taskId is required',
          }, { status: 400 });
        }

        const taskIndex = data.tasks.findIndex(t => t.id === body.taskId && t.channelId === body.channelId);
        if (taskIndex === -1) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Task not found: ${body.taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}`,
          }, { status: 404 });
        }

        const task = data.tasks[taskIndex];

        // Only the assignee or creator can unclaim
        if (task.assigneeId !== body.participantId && task.createdBy !== body.participantId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'Only the assignee or task creator can unclaim',
          }, { status: 403 });
        }

        // Update activity status to 'idle' before clearing assignee
        await updateActivityStatus(body.channelId, task.assigneeId!, 'idle');

        task.assigneeId = undefined;
        task.assignedAt = undefined;
        task.status = 'todo';
        task.updatedAt = nextTaskRevision(task.updatedAt);

        await writeTasksData(data);

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          taskId: task.id,
          task,
        });
      }

      case 'complete': {
        if (!body.taskId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'taskId is required',
          }, { status: 400 });
        }

        // Guards and the retry receipt are decided here, inside the task-store lock, before any
        // write or effect. Conflict and replay return without touching state (lib/task-completion.ts).
        const parsed = parseCompletionRequest(body as unknown as Record<string, unknown>);
        if (!parsed.ok) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            code: INVALID_COMPLETION_REQUEST,
            error: parsed.error,
          }, { status: 400 });
        }
        const outcome = applyTaskCompletion(data, parsed.request);
        if (outcome.kind === 'not_found') {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Task not found: ${body.taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}`,
          }, { status: 404 });
        }
        if (outcome.kind === 'conflict') {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            code: TASK_COMPLETION_CONFLICT,
            error: conflictMessage(outcome.conflicts),
            taskId: body.taskId,
            conflicts: outcome.conflicts,
            current: outcome.current,
          }, { status: 409 });
        }
        if (outcome.kind === 'key_conflict') {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            code: IDEMPOTENCY_KEY_REUSED,
            error: KEY_REUSED_MESSAGE,
            taskId: body.taskId,
          }, { status: 409 });
        }
        if (outcome.kind === 'replay') {
          const r = outcome.receipt;
          return NextResponse.json<CollabTaskActionResponse>({
            success: true,
            taskId: r.taskId,
            task: r.task,
            replayed: true,
            receipt: { idempotencyKey: r.idempotencyKey, recordedAt: r.recordedAt, participantId: r.participantId },
            liveTask: outcome.liveTask,
            liveStateChanged: outcome.liveStateChanged,
          });
        }

        const task = outcome.task;
        autoCompleteSprint(data, task.sprintId);
        await writeTasksData(data);

        // Update activity status to 'idle' (task completed)
        await updateActivityStatus(body.channelId, body.participantId, 'idle');

        eventBus.emitEvent('collab:task', {
          action: 'complete',
          task,
          channelId: body.channelId,
        });

        const taskCompleteRequestId = randomUUID();

        emitApiEvent({
          action: 'tasks.complete',
          status: 200,
          durationMs: 0,
          requestId: taskCompleteRequestId,
          severity: 'info',
          actor: body.participantId,
          channelId: body.channelId,
          summary: `Task completed: ${task.title} by ${verification.participantName}`,
        });

        // Sprint 38 T4.6 — fire `/flush-journal` to the claiming agent's
        // tmux session. Server-side replacement for the non-existent
        // TaskCompleted native Claude Code hook. Fire-and-forget: the
        // API response returns immediately; the flush runs in the
        // background, queued behind the agent's current turn.
        void triggerTaskCompletionFlush(
          body.channelId,
          body.participantId,
          task.title,
          taskCompleteRequestId,
        );

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          taskId: task.id,
          task,
          ...(outcome.receipt ? {
            replayed: false,
            receipt: { idempotencyKey: outcome.receipt.idempotencyKey, recordedAt: outcome.receipt.recordedAt, participantId: outcome.receipt.participantId },
          } : {}),
        });
      }

      case 'delete': {
        if (!body.taskId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'taskId is required',
          }, { status: 400 });
        }

        const taskIndex = data.tasks.findIndex(t => t.id === body.taskId && t.channelId === body.channelId);
        if (taskIndex === -1) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Task not found: ${body.taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}`,
          }, { status: 404 });
        }

        const task = data.tasks[taskIndex];

        // Allow delete from: task creator, current assignee, or channel owner.
        // The original creator-only rule blocked the channel owner (the owner) from
        // tidying up tasks created by agents in his channels — that was the
        // 'click delete, nothing happens' bug reported 2026-04-28.
        const channelsData = await readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);
        const channel = channelsData.channels.find(c => c.id === body.channelId);
        const isCreator = task.createdBy === body.participantId;
        const isAssignee = !!task.assigneeId && task.assigneeId === body.participantId;
        const isOwner = !!channel && channel.ownerId === body.participantId;
        if (!isCreator && !isAssignee && !isOwner) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'Only the task creator, assignee, or channel owner can delete',
          }, { status: 403 });
        }

        data.tasks.splice(taskIndex, 1);
        await writeTasksData(data);

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          taskId: body.taskId,
        });
      }

      case 'reorder': {
        if (!body.taskId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'taskId is required',
          }, { status: 400 });
        }

        if (body.sortOrder === undefined) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'sortOrder is required',
          }, { status: 400 });
        }

        const taskIndex = data.tasks.findIndex(t => t.id === body.taskId && t.channelId === body.channelId);
        if (taskIndex === -1) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Task not found: ${body.taskId}. Task may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}`,
          }, { status: 404 });
        }

        const task = data.tasks[taskIndex];
        const oldStatus = task.status;
        if (body.targetStatus !== undefined) {
          const statusErr = validateTaskStatus(body.targetStatus);
          if (statusErr) {
            return NextResponse.json<CollabTaskActionResponse>({
              success: false,
              error: statusErr,
            }, { status: 400 });
          }
        }
        const newStatus = body.targetStatus || task.status;
        const newSortOrder = body.sortOrder;

        // Get tasks in target column
        const columnTasks = data.tasks.filter(
          t => t.channelId === body.channelId && t.status === newStatus && t.id !== task.id
        );

        // Shift sortOrder for tasks at or after the new position
        columnTasks.forEach(t => {
          if ((t.sortOrder ?? 0) >= newSortOrder) {
            t.sortOrder = (t.sortOrder ?? 0) + 1;
          }
        });

        // Update the task
        task.sortOrder = newSortOrder;
        task.status = newStatus;
        task.updatedAt = nextTaskRevision(task.updatedAt);

        // If moving to in_progress, assign to the mover
        if (newStatus === 'in_progress' && oldStatus !== 'in_progress') {
          task.assigneeId = body.participantId;
          task.assignedAt = now;
          await updateActivityStatus(body.channelId, body.participantId, 'working');
        }

        // If moving from in_progress to done
        if (newStatus === 'done' && oldStatus !== 'done') {
          task.completedAt = now;
          await updateActivityStatus(body.channelId, body.participantId, 'idle');
        }

        // Auto-complete sprint if all tasks are now done
        if (newStatus === 'done') {
          autoCompleteSprint(data, task.sprintId);
        }

        await writeTasksData(data);


        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          taskId: task.id,
          task,
        });
      }

      case 'create-sprint': {
        const { name, description, startDate, endDate } = body;
        if (!name) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'Sprint name is required',
          }, { status: 400 });
        }

        const sprint = {
          id: randomUUID(),
          channelId: body.channelId,
          name,
          description: description || undefined,
          status: 'planned' as const,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          createdBy: body.participantId,
          createdAt: now,
          updatedAt: now,
          sortOrder: data.sprints?.length || 0,
        };

        if (!data.sprints) data.sprints = [];
        data.sprints.push(sprint);
        await writeTasksData(data);

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          sprint,
        });
      }

      case 'create-phase': {
        const { sprintId, name, description, color } = body;
        if (!sprintId || !name) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'Sprint ID and phase name are required',
          }, { status: 400 });
        }

        const phase = {
          id: randomUUID(),
          sprintId,
          channelId: body.channelId,
          name,
          description: description || undefined,
          color: color || '#3B82F6',
          sortOrder: data.phases?.filter(p => p.sprintId === sprintId).length || 0,
          createdBy: body.participantId,
          createdAt: now,
          updatedAt: now,
        };

        if (!data.phases) data.phases = [];
        data.phases.push(phase);
        await writeTasksData(data);

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          phase,
        });
      }

      case 'update-sprint': {
        const { sprintId, updates } = body;
        if (!sprintId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'Sprint ID is required',
          }, { status: 400 });
        }

        const sprint = data.sprints?.find(s => s.id === sprintId && s.channelId === body.channelId);
        if (!sprint) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}&includeHierarchy=true`,
          }, { status: 404 });
        }

        Object.assign(sprint, updates, { updatedAt: now });
        await writeTasksData(data);

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          sprint,
        });
      }

      case 'delete-sprint': {
        const { sprintId } = body;
        if (!sprintId) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: 'Sprint ID is required',
          }, { status: 400 });
        }

        const sprintIndex = (data.sprints || []).findIndex(s => s.id === sprintId && s.channelId === body.channelId);
        if (sprintIndex === -1) {
          return NextResponse.json<CollabTaskActionResponse>({
            success: false,
            error: `Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${body.channelId}&includeHierarchy=true`,
          }, { status: 404 });
        }

        // Remove sprint
        data.sprints!.splice(sprintIndex, 1);

        // Remove phases belonging to this sprint
        const phaseIds = (data.phases || []).filter(p => p.sprintId === sprintId).map(p => p.id);
        data.phases = (data.phases || []).filter(p => p.sprintId !== sprintId);

        // Remove tasks belonging to this sprint or its phases
        data.tasks = data.tasks.filter(t => t.sprintId !== sprintId && !phaseIds.includes(t.phaseId || ''));

        await writeTasksData(data);

        return NextResponse.json<CollabTaskActionResponse>({
          success: true,
          deleted: true,
          sprint: undefined,
        });
      }

      default:
        return NextResponse.json<CollabTaskActionResponse>({
          success: false,
          error: `Unknown action: ${body.action}`,
        }, { status: 400 });
    }
    }); // End withFileLock
  } catch (error) {
    console.error('Error in POST /api/collab/tasks:', error);
    return NextResponse.json<CollabTaskActionResponse>({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}));
