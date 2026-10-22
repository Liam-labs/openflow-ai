/**
 * Phase Management Actions
 *
 * Actions for managing phases in collaboration channels.
 */

import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { emitApiEvent } from '@/lib/log-emitter';
import type {
  AgentApiRequest,
  AgentAuthContext,
  CollabPhase,
  CollabTasksData,
  CollabTask,
} from '@/lib/types';

const TASKS_PATH = DataPaths.collabTasks;

const DEFAULT_TASKS_DATA: CollabTasksData = {
  tasks: [],
  sprints: [],
  phases: [],
  lastUpdated: new Date().toISOString(),
};

async function loadTasksData(): Promise<CollabTasksData> {
  const data = await readJsonFile<CollabTasksData>(TASKS_PATH, DEFAULT_TASKS_DATA);
  if (!data.sprints) data.sprints = [];
  if (!data.phases) data.phases = [];
  return data;
}

async function saveTasksData(data: CollabTasksData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(TASKS_PATH, data);
}

/**
 * Calculate phase progress
 */
function calculatePhaseProgress(
  phase: CollabPhase,
  tasks: CollabTask[]
): {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  percentComplete: number;
} {
  const phaseTasks = tasks.filter(t => t.phaseId === phase.id);

  const completed = phaseTasks.filter(t => t.status === 'done').length;
  const inProgress = phaseTasks.filter(t => t.status === 'in_progress').length;
  const todo = phaseTasks.filter(t => t.status === 'todo').length;
  const total = phaseTasks.length;

  return {
    totalTasks: total,
    completedTasks: completed,
    inProgressTasks: inProgress,
    todoTasks: todo,
    percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

/**
 * phases.list - List phases in a channel or sprint
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ phases: CollabPhase[]; count: number }> {
  const channelId = body.channelId;
  const sprintId = body.sprintId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  const data = await loadTasksData();
  let phases = (data.phases || []).filter(p => p.channelId === channelId);

  if (sprintId && typeof sprintId === 'string') {
    phases = phases.filter(p => p.sprintId === sprintId);
  }

  // Sort by sortOrder
  phases.sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    phases,
    count: phases.length,
  };
}

/**
 * phases.create - Create a new phase
 */
export async function create(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ phase: CollabPhase }> {
  const channelId = body.channelId;
  const participantId = body.participantId;
  const sprintId = body.sprintId;
  const name = body.name;
  const description = body.description;
  const color = body.color;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }
  if (!sprintId || typeof sprintId !== 'string') {
    throw new Error('sprintId is required');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('name is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const now = new Date().toISOString();

    // Verify sprint exists
    const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);
    if (!sprint) {
      throw new Error(`Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);
    }

    // Sprint 58 T2 — idempotent on (sprintId, name).
    // Prevents the Sprint 50 scenario: phases.create fired 3× in 23s during
    // sprint-setup, stacking duplicate "Phase 1/2/3/4" rows on the same
    // sprintId. Retry-loops and re-runs of sprint-plan scripts also benefit.
    const existing = (data.phases || []).find(
      p =>
        p.sprintId === sprintId &&
        p.channelId === channelId &&
        p.name === name
    );
    if (existing) {
      emitApiEvent({
        action: 'phases.create',
        status: 200,
        durationMs: 0,
        requestId: _auth.requestId,
        severity: 'info',
        channelId: channelId as string,
        summary: `Phase already exists (idempotent): ${name}`,
      });
      return { phase: existing };
    }

    // Get max sortOrder for this sprint
    const sprintPhases = (data.phases || []).filter(p => p.sprintId === sprintId);
    const maxSortOrder = sprintPhases.length > 0
      ? Math.max(...sprintPhases.map(p => p.sortOrder))
      : -1;

    const newPhase: CollabPhase = {
      id: crypto.randomUUID(),
      sprintId,
      channelId,
      name,
      description: typeof description === 'string' ? description : undefined,
      color: typeof color === 'string' ? color : undefined,
      createdBy: participantId,
      createdAt: now,
      updatedAt: now,
      sortOrder: maxSortOrder + 1,
    };

    if (!data.phases) data.phases = [];
    data.phases.push(newPhase);
    await saveTasksData(data);

    emitApiEvent({
      action: 'phases.create',
      status: 200,
      durationMs: 0,
      requestId: _auth.requestId,
      severity: 'info',
      channelId: channelId as string,
      summary: `Phase created: ${name}`,
    });

    return { phase: newPhase };
  });
}

/**
 * phases.update - Update a phase
 */
export async function update(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ phase: CollabPhase }> {
  const channelId = body.channelId;
  const phaseId = body.phaseId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!phaseId || typeof phaseId !== 'string') {
    throw new Error('phaseId is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const phase = (data.phases || []).find(p => p.id === phaseId && p.channelId === channelId);

    if (!phase) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    // Update fields if provided
    if (body.name !== undefined && typeof body.name === 'string') {
      phase.name = body.name;
    }
    if (body.description !== undefined) {
      phase.description = typeof body.description === 'string' ? body.description : undefined;
    }
    if (body.color !== undefined) {
      phase.color = typeof body.color === 'string' ? body.color : undefined;
    }
    if (body.sprintId !== undefined && typeof body.sprintId === 'string') {
      // Verify new sprint exists
      const sprint = (data.sprints || []).find(s => s.id === body.sprintId && s.channelId === channelId);
      if (!sprint) {
        throw new Error(`Sprint not found: ${body.sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);
      }
      phase.sprintId = body.sprintId;
    }

    phase.updatedAt = new Date().toISOString();

    // Real board progress clears any active snooze on the parent sprint
    if (phase.sprintId) {
      const sprint = (data.sprints || []).find(s => s.id === phase.sprintId && s.channelId === channelId);
      if (sprint) {
        sprint.reminderSnoozeUntil = undefined;
        sprint.reminderSnoozeReason = undefined;
      }
    }

    await saveTasksData(data);

    return { phase };
  });
}

/**
 * phases.progress - Get phase progress
 */
export async function progress(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<ReturnType<typeof calculatePhaseProgress> & { phase: CollabPhase }> {
  const channelId = body.channelId;
  const phaseId = body.phaseId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!phaseId || typeof phaseId !== 'string') {
    throw new Error('phaseId is required');
  }

  const data = await loadTasksData();
  const phase = (data.phases || []).find(p => p.id === phaseId && p.channelId === channelId);

  if (!phase) {
    throw new Error(`Phase not found: ${phaseId}`);
  }

  const progressData = calculatePhaseProgress(phase, data.tasks);

  return {
    phase,
    ...progressData,
  };
}

/**
 * phases.delete - Delete a phase
 */
export async function remove(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deleted: boolean; phaseId: string }> {
  const channelId = body.channelId;
  const phaseId = body.phaseId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!phaseId || typeof phaseId !== 'string') {
    throw new Error('phaseId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const phaseIndex = (data.phases || []).findIndex(p => p.id === phaseId && p.channelId === channelId);

    if (phaseIndex === -1) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    // Remove phase
    data.phases!.splice(phaseIndex, 1);

    // Orphan all tasks belonging to this phase (set phaseId to undefined)
    data.tasks
      .filter(t => t.phaseId === phaseId)
      .forEach(t => {
        t.phaseId = undefined;
      });

    await saveTasksData(data);

    return { deleted: true, phaseId };
  });
}

/**
 * phases.reorder - Reorder a phase within or between sprints
 */
export async function reorder(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ phase: CollabPhase }> {
  const channelId = body.channelId;
  const phaseId = body.phaseId;
  const newSortOrder = body.newSortOrder;
  const targetSprintId = body.targetSprintId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!phaseId || typeof phaseId !== 'string') {
    throw new Error('phaseId is required');
  }
  if (typeof newSortOrder !== 'number') {
    throw new Error('newSortOrder is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const phase = (data.phases || []).find(p => p.id === phaseId && p.channelId === channelId);

    if (!phase) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const oldSprintId = phase.sprintId;
    const newSprintId = targetSprintId && typeof targetSprintId === 'string' ? targetSprintId : oldSprintId;

    // If moving to different sprint, verify it exists
    if (newSprintId !== oldSprintId) {
      const sprint = (data.sprints || []).find(s => s.id === newSprintId && s.channelId === channelId);
      if (!sprint) {
        throw new Error(`Sprint not found: ${newSprintId}`);
      }
      phase.sprintId = newSprintId;
    }

    // Update sort order
    phase.sortOrder = newSortOrder;
    phase.updatedAt = new Date().toISOString();

    // Reorder other phases in target sprint
    const targetPhases = (data.phases || [])
      .filter(p => p.sprintId === newSprintId && p.id !== phaseId)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    targetPhases.forEach((p, index) => {
      if (index >= newSortOrder) {
        p.sortOrder = index + 1;
      } else {
        p.sortOrder = index;
      }
    });

    await saveTasksData(data);

    return { phase };
  });
}
