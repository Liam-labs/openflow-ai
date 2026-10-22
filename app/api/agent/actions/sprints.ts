/**
 * Sprint Management Actions
 *
 * Actions for managing sprints in collaboration channels.
 */

import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { appendSilentMessage } from '@/lib/collab-message-io';
import { emitApiEvent } from '@/lib/log-emitter';
import { isAgentIdleForCompact } from '@/lib/agent-session-state';
import { tmuxSendKeys } from '@/lib/tmux-send';
import {
  runAutoCompactSweep,
  type AutoCompactOpts,
} from '@/lib/auto-compact-orchestrator';
import {
  appendAutoCompactEvents,
  buildEventsFromSweep,
} from '@/lib/auto-compact-events';
import type {
  AgentApiRequest,
  AgentAuthContext,
  CollabSprint,
  CollabTasksData,
  CollabSprintStatus,
  CollabChannelsData,
  CollabPhase,
  CollabTask,
  CollabMessage,
  CollabParticipant,
} from '@/lib/types';
import { PRODUCT_NAME } from '@/lib/brand';
import { selfOrigin } from '@/lib/self-origin';

const TASKS_PATH = DataPaths.collabTasks;

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

/**
 * Sprint 38 T4.3 — sprints.complete auto-compact hook.
 *
 * When a sprint is marked complete, fire `/flush-journal` → wait 2s →
 * `/compact` against every eligible running agent in the channel's
 * roster, staggered 10s apart. Each agent is guarded via
 * `isAgentIdleForCompact` (T4.4) to avoid clobbering a busy session.
 *
 * This runs FIRE-AND-FORGET: the API response returns immediately and
 * the sweep continues in the background. A full sweep for a 5-agent
 * roster takes ~3 minutes wall-clock; blocking the API for that is not
 * acceptable. Any failure is emitted via `emitApiEvent` at error
 * severity for observability.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerAutoCompactForChannel(
  channelId: string,
  sprintId: string | undefined,
  requestId: string | undefined,
): Promise<void> {
  const rid = requestId ?? '';
  try {
    const channelsData = await readJsonFile<CollabChannelsData>(
      DataPaths.collabChannels,
      DEFAULT_CHANNELS_DATA,
    );
    const channel = (channelsData.channels || []).find((c) => c.id === channelId);
    const roster = channel?.roster?.agents ?? [];
    if (roster.length === 0) {
      return;
    }
    const opts: AutoCompactOpts = {
      isIdle: (dir) => isAgentIdleForCompact(dir),
      sendKeys: tmuxSendKeys,
      sleep: sleepMs,
    };
    const result = await runAutoCompactSweep(roster, opts);

    // Sprint 38 T4.5 — append one JSONL entry per attempted compact.
    // Errors in the logger must not mask sweep failures for callers,
    // so wrap the log append in its own try/catch.
    try {
      const events = buildEventsFromSweep(result, { channelId, sprintId });
      await appendAutoCompactEvents(events);
    } catch (logErr) {
      const logMsg = logErr instanceof Error ? logErr.message : String(logErr);
      emitApiEvent({
        action: 'sprints.complete.autocompact',
        status: 500,
        durationMs: 0,
        requestId: rid,
        severity: 'medium',
        channelId,
        summary: `auto-compact event log append failed: ${logMsg}`,
      });
    }

    emitApiEvent({
      action: 'sprints.complete.autocompact',
      status: 200,
      durationMs: result.totalDurationMs,
      requestId: rid,
      severity: 'info',
      channelId,
      summary: `auto-compact sweep: ${result.compacted} compacted, ${result.skipped} skipped, ${result.errored} errored (${result.attempted} attempted)`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitApiEvent({
      action: 'sprints.complete.autocompact',
      status: 500,
      durationMs: 0,
      requestId: rid,
      severity: 'high',
      channelId,
      summary: `auto-compact sweep threw: ${msg}`,
    });
  }
}

const DEFAULT_TASKS_DATA: CollabTasksData = {
  tasks: [],
  sprints: [],
  phases: [],
  lastUpdated: new Date().toISOString(),
};

async function loadTasksData(): Promise<CollabTasksData> {
  const data = await readJsonFile<CollabTasksData>(TASKS_PATH, DEFAULT_TASKS_DATA);
  // Ensure sprints and phases arrays exist for backward compatibility
  if (!data.sprints) data.sprints = [];
  if (!data.phases) data.phases = [];
  return data;
}

async function saveTasksData(data: CollabTasksData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(TASKS_PATH, data);
}

/**
 * Calculate sprint progress including phase breakdown
 */
function calculateSprintProgress(
  sprint: CollabSprint,
  phases: CollabPhase[],
  tasks: CollabTask[]
): {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  percentComplete: number;
  phaseProgress: Array<{
    phaseId: string;
    phaseName: string;
    completed: number;
    total: number;
    percent: number;
  }>;
} {
  const sprintPhases = phases.filter(p => p.sprintId === sprint.id);
  const sprintTasks = tasks.filter(t => t.sprintId === sprint.id);

  const completed = sprintTasks.filter(t => t.status === 'done').length;
  const inProgress = sprintTasks.filter(t => t.status === 'in_progress').length;
  const todo = sprintTasks.filter(t => t.status === 'todo').length;
  const total = sprintTasks.length;

  const phaseProgress = sprintPhases.map(phase => {
    const phaseTasks = tasks.filter(t => t.phaseId === phase.id);
    const phaseCompleted = phaseTasks.filter(t => t.status === 'done').length;
    return {
      phaseId: phase.id,
      phaseName: phase.name,
      completed: phaseCompleted,
      total: phaseTasks.length,
      percent: phaseTasks.length > 0 ? Math.round((phaseCompleted / phaseTasks.length) * 100) : 0,
    };
  });

  return {
    totalTasks: total,
    completedTasks: completed,
    inProgressTasks: inProgress,
    todoTasks: todo,
    percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
    phaseProgress,
  };
}

/**
 * sprints.list - List sprints in a channel
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sprints: CollabSprint[]; count: number }> {
  const channelId = body.channelId;
  const status = body.status as CollabSprintStatus | undefined;

  if (!channelId || typeof channelId !== 'string') {
    throw Object.assign(new Error('channelId is required'), { statusCode: 400 });
  }

  const data = await loadTasksData();
  let sprints = (data.sprints || []).filter(s => s.channelId === channelId);

  if (status && ['planned', 'active', 'completed', 'cancelled'].includes(status)) {
    sprints = sprints.filter(s => s.status === status);
  }

  // Sort by sortOrder
  sprints.sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    sprints,
    count: sprints.length,
  };
}

/**
 * sprints.create - Create a new sprint
 */
export async function create(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sprint: CollabSprint }> {
  const channelId = body.channelId;
  const participantId = body.participantId;
  const name = body.name;
  const description = body.description;
  const startDate = body.startDate;
  const endDate = body.endDate;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('name is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const now = new Date().toISOString();

    // Get max sortOrder for this channel
    const channelSprints = (data.sprints || []).filter(s => s.channelId === channelId);
    const maxSortOrder = channelSprints.length > 0
      ? Math.max(...channelSprints.map(s => s.sortOrder))
      : -1;

    const newSprint: CollabSprint = {
      id: crypto.randomUUID(),
      channelId,
      name,
      description: typeof description === 'string' ? description : undefined,
      status: 'planned',
      startDate: typeof startDate === 'string' ? startDate : undefined,
      endDate: typeof endDate === 'string' ? endDate : undefined,
      createdBy: participantId,
      createdAt: now,
      updatedAt: now,
      sortOrder: maxSortOrder + 1,
    };

    if (!data.sprints) data.sprints = [];
    data.sprints.push(newSprint);
    await saveTasksData(data);

    emitApiEvent({
      action: 'sprints.create',
      status: 200,
      durationMs: 0,
      requestId: _auth.requestId,
      severity: 'info',
      actor: participantId as string,
      channelId: channelId as string,
      summary: `Sprint created: ${name}`,
    });

    return { sprint: newSprint };
  });
}

/**
 * sprints.update - Update a sprint
 */
export async function update(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sprint: CollabSprint }> {
  const channelId = body.channelId;
  const sprintId = body.sprintId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!sprintId || typeof sprintId !== 'string') {
    throw new Error('sprintId is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);

    if (!sprint) {
      throw new Error(`Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);
    }

    // Update fields if provided
    if (body.name !== undefined && typeof body.name === 'string') {
      sprint.name = body.name;
    }
    if (body.description !== undefined) {
      sprint.description = typeof body.description === 'string' ? body.description : undefined;
    }
    if (body.status !== undefined && ['planned', 'active', 'completed', 'cancelled'].includes(body.status as string)) {
      sprint.status = body.status as CollabSprintStatus;
    }
    if (body.startDate !== undefined) {
      sprint.startDate = typeof body.startDate === 'string' ? body.startDate : undefined;
    }
    if (body.endDate !== undefined) {
      sprint.endDate = typeof body.endDate === 'string' ? body.endDate : undefined;
    }

    sprint.updatedAt = new Date().toISOString();
    await saveTasksData(data);

    return { sprint };
  });
}

/**
 * sprints.activate - Set sprint to active (deactivates others)
 */
export async function activate(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sprint: CollabSprint }> {
  const channelId = body.channelId;
  const sprintId = body.sprintId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!sprintId || typeof sprintId !== 'string') {
    throw new Error('sprintId is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);

    if (!sprint) {
      throw new Error(`Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);
    }

    // Deactivate all other sprints in this channel
    (data.sprints || [])
      .filter(s => s.channelId === channelId && s.id !== sprintId && s.status === 'active')
      .forEach(s => {
        s.status = 'planned';
        s.updatedAt = new Date().toISOString();
      });

    // Activate this sprint
    const activationTime = new Date().toISOString();
    sprint.status = 'active';
    sprint.activatedAt = activationTime;
    sprint.updatedAt = activationTime;

    await saveTasksData(data);

    emitApiEvent({
      action: 'sprints.activate',
      status: 200,
      durationMs: 0,
      requestId: _auth.requestId,
      severity: 'info',
      channelId: channelId as string,
      summary: `Sprint activated: ${sprint.name}`,
    });

    return { sprint };
  });
}

/**
 * sprints.complete - Mark sprint as completed
 */
export async function complete(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sprint: CollabSprint; completed: boolean }> {
  const channelId = body.channelId;
  const sprintId = body.sprintId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!sprintId || typeof sprintId !== 'string') {
    throw new Error('sprintId is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);

    if (!sprint) {
      throw new Error(`Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);
    }

    // Sprint completion gate: validate all tasks are done before allowing completion.
    // Prevent the "95% complete" bug where a sprint is marked done with leftover tasks.
    const sprintTasks = (data.tasks || []).filter(t => t.sprintId === sprintId);
    const remaining = sprintTasks.filter(t => t.status !== 'done');
    if (remaining.length > 0) {
      const counts: Record<string, number> = {};
      for (const t of remaining) {
        counts[t.status] = (counts[t.status] || 0) + 1;
      }
      const breakdown = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
      throw Object.assign(
        new Error(`Cannot complete sprint: ${remaining.length} task(s) still not done (${breakdown}). Mark remaining tasks as done first, or cancel the sprint.`),
        { statusCode: 409 },
      );
    }

    sprint.status = 'completed';
    sprint.updatedAt = new Date().toISOString();

    await saveTasksData(data);

    emitApiEvent({
      action: 'sprints.complete',
      status: 200,
      durationMs: 0,
      requestId: _auth.requestId,
      severity: 'info',
      channelId: channelId as string,
      summary: `Sprint completed: ${sprint.name}`,
    });

    // Sprint 38 T4.3: fire-and-forget auto-compact sweep across the roster.
    // Never await — the sweep takes minutes and the API caller gets an
    // immediate response. Errors are captured inside triggerAutoCompactForChannel.
    // T4.5: sprintId is forwarded so each JSONL event can be correlated.
    void triggerAutoCompactForChannel(
      channelId as string,
      sprintId as string,
      _auth.requestId,
    );

    return { sprint, completed: true };
  });
}

/**
 * sprints.progress - Get sprint progress with phase breakdown
 */
export async function progress(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<ReturnType<typeof calculateSprintProgress> & { sprint: CollabSprint }> {
  const channelId = body.channelId;
  const sprintId = body.sprintId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!sprintId || typeof sprintId !== 'string') {
    throw new Error('sprintId is required');
  }

  const data = await loadTasksData();
  const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);

  if (!sprint) {
    throw new Error(`Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);
  }

  const progressData = calculateSprintProgress(sprint, data.phases || [], data.tasks);

  return {
    sprint,
    ...progressData,
  };
}

/**
 * sprints.health - Audit sprint health for stale tasks, inactive agents, abandoned work
 */
export async function health(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  sprints: Array<{
    sprint: CollabSprint;
    progress: ReturnType<typeof calculateSprintProgress>;
    health: {
      score: number;
      status: 'healthy' | 'warning' | 'critical';
      daysActive: number;
      issues: string[];
      staleTasks: Array<{ id: string; title: string; assigneeId?: string; daysSinceUpdate: number }>;
      unclaimedTasks: Array<{ id: string; title: string; daysSinceCreation: number }>;
      stuckInProgress: Array<{ id: string; title: string; assigneeId?: string; daysSinceClaim: number }>;
      emptyPhases: Array<{ id: string; name: string }>;
      skippedPhases: Array<{ id: string; name: string; todoCount: number; doneCount: number }>;
    };
  }>;
  summary: string;
}> {
  const channelId = body.channelId;
  const sprintId = body.sprintId as string | undefined;
  const staleDays = typeof body.staleDays === 'number' ? body.staleDays : 3;
  const includeCompleted = body.includeCompleted === true;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  const data = await loadTasksData();
  const now = new Date();

  // Filter sprints
  let sprints = (data.sprints || []).filter(s => s.channelId === channelId);
  if (sprintId) {
    sprints = sprints.filter(s => s.id === sprintId);
  }
  if (!includeCompleted) {
    sprints = sprints.filter(s => s.status !== 'completed' && s.status !== 'cancelled');
  }

  const daysBetween = (from: string, to: Date) => {
    const diff = to.getTime() - new Date(from).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  };

  const results = sprints.map(sprint => {
    const sprintPhases = (data.phases || []).filter(p => p.sprintId === sprint.id);
    const sprintTasks = data.tasks.filter(t => t.sprintId === sprint.id);
    const progressData = calculateSprintProgress(sprint, data.phases || [], data.tasks);
    const issues: string[] = [];

    const daysActive = sprint.status === 'active' && sprint.startDate
      ? daysBetween(sprint.startDate, now)
      : daysBetween(sprint.createdAt, now);

    // Stale tasks: in_progress with no update for staleDays
    const staleTasks = sprintTasks
      .filter(t => t.status === 'in_progress' && daysBetween(t.updatedAt, now) >= staleDays)
      .map(t => ({ id: t.id, title: t.title, assigneeId: t.assigneeId, daysSinceUpdate: daysBetween(t.updatedAt, now) }));

    if (staleTasks.length > 0) {
      issues.push(`${staleTasks.length} task(s) in_progress with no update for ${staleDays}+ days`);
    }

    // Unclaimed tasks: todo with no assignee for a while
    const unclaimedTasks = sprintTasks
      .filter(t => t.status === 'todo' && !t.assigneeId && daysBetween(t.createdAt, now) >= staleDays)
      .map(t => ({ id: t.id, title: t.title, daysSinceCreation: daysBetween(t.createdAt, now) }));

    if (unclaimedTasks.length > 0) {
      issues.push(`${unclaimedTasks.length} task(s) unclaimed for ${staleDays}+ days`);
    }

    // Stuck in progress: claimed but not completed for a long time
    const stuckInProgress = sprintTasks
      .filter(t => t.status === 'in_progress' && t.assignedAt && daysBetween(t.assignedAt, now) >= staleDays * 2)
      .map(t => ({ id: t.id, title: t.title, assigneeId: t.assigneeId, daysSinceClaim: daysBetween(t.assignedAt!, now) }));

    if (stuckInProgress.length > 0) {
      issues.push(`${stuckInProgress.length} task(s) stuck in_progress for ${staleDays * 2}+ days since claimed`);
    }

    // Empty phases: phases with no tasks
    const emptyPhases = sprintPhases
      .filter(phase => !sprintTasks.some(t => t.phaseId === phase.id))
      .map(p => ({ id: p.id, name: p.name }));

    if (emptyPhases.length > 0) {
      issues.push(`${emptyPhases.length} phase(s) have no tasks`);
    }

    // Skipped phases: earlier phases with incomplete tasks while later phases are being worked
    const sortedPhases = [...sprintPhases].sort((a, b) => a.sortOrder - b.sortOrder);
    const skippedPhases: Array<{ id: string; name: string; todoCount: number; doneCount: number }> = [];
    let foundActivePhase = false;
    for (let i = sortedPhases.length - 1; i >= 0; i--) {
      const phase = sortedPhases[i];
      const phaseTasks = sprintTasks.filter(t => t.phaseId === phase.id);
      const hasActive = phaseTasks.some(t => t.status === 'in_progress' || t.status === 'done');
      if (hasActive) foundActivePhase = true;
      if (foundActivePhase && !hasActive) continue; // Not yet reached
      if (foundActivePhase) {
        const todoCount = phaseTasks.filter(t => t.status === 'todo').length;
        const doneCount = phaseTasks.filter(t => t.status === 'done').length;
        if (todoCount > 0 && phaseTasks.length > 0) {
          // Check if later phases have activity
          const laterPhases = sortedPhases.slice(i + 1);
          const laterHasActivity = laterPhases.some(lp =>
            sprintTasks.filter(t => t.phaseId === lp.id).some(t => t.status === 'in_progress' || t.status === 'done')
          );
          if (laterHasActivity) {
            skippedPhases.push({ id: phase.id, name: phase.name, todoCount, doneCount });
          }
        }
      }
    }

    if (skippedPhases.length > 0) {
      issues.push(`${skippedPhases.length} earlier phase(s) have incomplete tasks while later phases are active`);
    }

    // Sprint-level issues
    if (sprint.status === 'active' && progressData.percentComplete === 100 && sprintTasks.length > 0) {
      issues.push('All tasks are done but sprint is still marked active — should be completed');
    }
    if (sprint.status === 'completed' && progressData.percentComplete < 100 && sprintTasks.length > 0) {
      issues.push(`Sprint is marked completed but ${progressData.todoTasks + progressData.inProgressTasks} task(s) are not done (${progressData.percentComplete}%) — progress is permanently stale`);
    }

    if (sprint.endDate && new Date(sprint.endDate) < now && sprint.status === 'active') {
      issues.push(`Sprint is past its end date (${sprint.endDate.split('T')[0]})`);
    }

    if (sprint.status === 'active' && sprintTasks.length === 0) {
      issues.push('Sprint is active but has no tasks');
    }

    // Calculate health score (100 = perfect, 0 = critical)
    let score = 100;
    score -= staleTasks.length * 10;
    score -= unclaimedTasks.length * 5;
    score -= stuckInProgress.length * 15;
    score -= emptyPhases.length * 5;
    score -= skippedPhases.length * 10;
    if (sprint.status === 'active' && progressData.percentComplete === 100) score -= 10;
    if (sprint.endDate && new Date(sprint.endDate) < now && sprint.status === 'active') score -= 20;
    score = Math.max(0, Math.min(100, score));

    const status: 'healthy' | 'warning' | 'critical' = score >= 70 ? 'healthy' : score >= 40 ? 'warning' : 'critical';

    return {
      sprint,
      progress: progressData,
      health: {
        score,
        status,
        daysActive,
        issues,
        staleTasks,
        unclaimedTasks,
        stuckInProgress,
        emptyPhases,
        skippedPhases,
      },
    };
  });

  // Build summary
  const critical = results.filter(r => r.health.status === 'critical').length;
  const warning = results.filter(r => r.health.status === 'warning').length;
  const healthy = results.filter(r => r.health.status === 'healthy').length;
  const totalIssues = results.reduce((sum, r) => sum + r.health.issues.length, 0);

  const summary = totalIssues === 0
    ? `All ${results.length} sprint(s) healthy. No issues found.`
    : `${results.length} sprint(s) audited: ${critical} critical, ${warning} warning, ${healthy} healthy. ${totalIssues} total issue(s) found.`;

  return { sprints: results, summary };
}

/**
 * sprints.delete - Delete a sprint
 */
export async function remove(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deleted: boolean; sprintId: string }> {
  const channelId = body.channelId;
  const sprintId = body.sprintId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!sprintId || typeof sprintId !== 'string') {
    throw new Error('sprintId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const sprintIndex = (data.sprints || []).findIndex(s => s.id === sprintId && s.channelId === channelId);

    if (sprintIndex === -1) {
      throw new Error(`Sprint not found: ${sprintId}. Sprint may have been completed or removed — fetch current state via /api/collab/tasks?channelId=${channelId}&includeHierarchy=true`);
    }

    // Remove sprint
    data.sprints!.splice(sprintIndex, 1);

    // Orphan all phases and tasks belonging to this sprint (set sprintId to undefined)
    (data.phases || [])
      .filter(p => p.sprintId === sprintId)
      .forEach(p => {
        delete p.sprintId; // Orphan from deleted sprint
      });

    data.tasks
      .filter(t => t.sprintId === sprintId)
      .forEach(t => {
        t.sprintId = undefined;
        t.phaseId = undefined; // Also orphan from phase
      });

    await saveTasksData(data);

    return { deleted: true, sprintId };
  });
}

// ============================================
// System participant for automated messages
// ============================================
function makeSystemParticipant(): CollabParticipant {
  const now = new Date().toISOString();
  return {
    id: 'system-sprint-reminder',
    type: 'user',
    name: 'Sprint Reminder',
    source: 'DevFlow Cron',
    joinedAt: now,
    lastSeen: now,
  };
}

/**
 * sprints.reminder - Check all channels for incomplete active sprints and post reminders
 *
 * Designed to be called by a cron job every 30 minutes.
 * Posts a system message to each channel that has active sprints with incomplete tasks.
 */
export async function reminder(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  channelsChecked: number;
  remindersPosted: number;
  details: Array<{
    channelId: string;
    channelName: string;
    sprintName: string;
    totalTasks: number;
    completedTasks: number;
    percentComplete: number;
    issues: string[];
  }>;
}> {
  const staleDays = typeof body.staleDays === 'number' ? body.staleDays : 1;
  const skipHealthy = body.skipHealthy !== false; // Default: only post for unhealthy sprints

  // Load channels to iterate
  const channelsData = await readJsonFile<CollabChannelsData>(
    DataPaths.collabChannels,
    { channels: [], lastUpdated: new Date().toISOString() }
  );

  // Load sprint/task data
  const tasksData = await loadTasksData();
  const now = new Date();
  const details: Array<{
    channelId: string;
    channelName: string;
    sprintName: string;
    totalTasks: number;
    completedTasks: number;
    percentComplete: number;
    issues: string[];
  }> = [];

  let remindersPosted = 0;

  for (const channel of channelsData.channels) {
    // Skip sub-channels
    if (channel.parentChannelId) continue;

    // Skip channels with reminders paused
    const pausedUntil = channel.settings?.reminderPausedUntil;
    if (pausedUntil && new Date(pausedUntil) > now) continue;

    // Find active sprints for this channel
    const activeSprints = (tasksData.sprints || []).filter(
      s => s.channelId === channel.id && s.status === 'active'
    );

    if (activeSprints.length === 0) continue;

    for (const sprint of activeSprints) {
      const progressData = calculateSprintProgress(sprint, tasksData.phases || [], tasksData.tasks);

      // Skip 100% complete sprints (they should be marked complete — that's an issue we flag)
      if (progressData.totalTasks === 0) continue;

      // Calculate health issues
      const daysBetween = (from: string, to: Date) => {
        const diff = to.getTime() - new Date(from).getTime();
        return Math.floor(diff / (1000 * 60 * 60 * 24));
      };

      const sprintTasks = tasksData.tasks.filter(t => t.sprintId === sprint.id);
      const issues: string[] = [];

      // Check for stale tasks
      const staleTasks = sprintTasks.filter(
        t => t.status === 'in_progress' && daysBetween(t.updatedAt, now) >= staleDays
      );
      if (staleTasks.length > 0) {
        issues.push(`${staleTasks.length} task(s) stale (in_progress with no update for ${staleDays}+ days)`);
      }

      // Check for unclaimed tasks
      const unclaimedTasks = sprintTasks.filter(
        t => t.status === 'todo' && !t.assigneeId
      );
      if (unclaimedTasks.length > 0) {
        issues.push(`${unclaimedTasks.length} task(s) unclaimed`);
      }

      // Check if sprint is past end date
      if (sprint.endDate && new Date(sprint.endDate) < now) {
        issues.push(`Sprint is past its end date (${sprint.endDate.split('T')[0]})`);
      }

      // Check if all tasks done but sprint still active
      if (progressData.percentComplete === 100) {
        issues.push('All tasks done but sprint still marked active — should be completed');
      }

      // Skip healthy sprints if configured
      if (skipHealthy && issues.length === 0 && progressData.percentComplete === 100) {
        continue;
      }

      // Only post reminder if there's actually incomplete work or issues
      if (progressData.completedTasks === progressData.totalTasks && issues.length === 0) {
        continue;
      }

      details.push({
        channelId: channel.id,
        channelName: channel.name,
        sprintName: sprint.name,
        totalTasks: progressData.totalTasks,
        completedTasks: progressData.completedTasks,
        percentComplete: progressData.percentComplete,
        issues,
      });

      // Build the reminder message
      const progressBar = buildProgressBar(progressData.percentComplete);
      let msg = `**Sprint Reminder: "${sprint.name}"**\n`;
      msg += `${progressBar} ${progressData.percentComplete}% complete`;
      msg += ` (${progressData.completedTasks}/${progressData.totalTasks} tasks done)`;

      if (progressData.todoTasks > 0) {
        msg += `\n• ${progressData.todoTasks} todo`;
      }
      if (progressData.inProgressTasks > 0) {
        msg += `\n• ${progressData.inProgressTasks} in progress`;
      }

      if (issues.length > 0) {
        msg += '\n\n**Issues:**\n' + issues.map(i => `• ${i}`).join('\n');
      }

      // Find team lead to @mention, fallback to any agent
      const teamLeadParticipant = channel.teamLeadId
        ? channel.participants.find(p => p.id === channel.teamLeadId)
        : undefined;
      const targetAgent = teamLeadParticipant
        || channel.participants.find(p => p.type !== 'user' && p.name);

      if (targetAgent) {
        msg += `\n\n@${targetAgent.name} — please review the sprint board.`;
      }

      // Post as silent system message
      const systemMessage: CollabMessage = {
        id: crypto.randomUUID(),
        channelId: channel.id,
        from: makeSystemParticipant(),
        content: msg,
        timestamp: now.toISOString(),
        silent: true,
      };

      try {
        await appendSilentMessage(channel.id, systemMessage);
        remindersPosted++;
      } catch (err) {
        console.error(`[sprints.reminder] Failed to post to channel ${channel.id}:`, err);
      }
    }
  }

  return {
    channelsChecked: channelsData.channels.filter(c => !c.parentChannelId).length,
    remindersPosted,
    details,
  };
}

/**
 * sprints.daily_summary - Generate a daily summary of all sprint activity
 *
 * Designed to be called by a cron job at end of day.
 * Produces a markdown summary and optionally posts it to channels.
 */
export async function dailySummary(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  channelsSummarized: number;
  summaries: Array<{
    channelId: string;
    channelName: string;
    markdown: string;
    posted: boolean;
  }>;
  archived: Array<{
    channelId: string;
    channelName: string;
    docTitle: string;
  }>;
}> {
  const postToChannels = body.postToChannels !== false; // Default: post summaries
  const archiveCompleted = body.archiveCompleted !== false; // Default: archive completed sprints

  const channelsData = await readJsonFile<CollabChannelsData>(
    DataPaths.collabChannels,
    { channels: [], lastUpdated: new Date().toISOString() }
  );

  const tasksData = await loadTasksData();
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  const summaries: Array<{
    channelId: string;
    channelName: string;
    markdown: string;
    posted: boolean;
  }> = [];

  for (const channel of channelsData.channels) {
    if (channel.parentChannelId) continue;

    // Skip channels with reminders paused
    const pausedUntil = channel.settings?.reminderPausedUntil;
    if (pausedUntil && new Date(pausedUntil) > now) continue;

    // Find all non-cancelled sprints for this channel
    const channelSprints = (tasksData.sprints || []).filter(
      s => s.channelId === channel.id && s.status !== 'cancelled'
    );

    if (channelSprints.length === 0) continue;

    let md = `# Daily Sprint Summary — ${today}\n`;
    md += `**Channel:** ${channel.name}\n\n`;

    let hasContent = false;

    for (const sprint of channelSprints) {
      const progressData = calculateSprintProgress(sprint, tasksData.phases || [], tasksData.tasks);
      const sprintTasks = tasksData.tasks.filter(t => t.sprintId === sprint.id);

      // Skip sprints with no tasks
      if (sprintTasks.length === 0 && sprint.status === 'completed') continue;

      hasContent = true;
      const statusEmoji = sprint.status === 'active' ? '▶' : sprint.status === 'completed' ? '✓' : '○';
      md += `## ${statusEmoji} ${sprint.name} (${sprint.status})\n\n`;
      md += `${buildProgressBar(progressData.percentComplete)} **${progressData.percentComplete}%** — `;
      md += `${progressData.completedTasks}/${progressData.totalTasks} tasks done\n\n`;

      // Phase breakdown
      if (progressData.phaseProgress.length > 0) {
        md += '| Phase | Progress | Status |\n';
        md += '|-------|----------|--------|\n';
        for (const phase of progressData.phaseProgress) {
          const phaseStatus = phase.completed === phase.total
            ? 'Done'
            : `${phase.completed}/${phase.total}`;
          md += `| ${phase.phaseName} | ${phase.percent}% | ${phaseStatus} |\n`;
        }
        md += '\n';
      }

      // Tasks completed today
      const todayCompleted = sprintTasks.filter(
        t => t.status === 'done' && t.updatedAt.startsWith(today)
      );
      if (todayCompleted.length > 0) {
        md += `**Completed today (${todayCompleted.length}):**\n`;
        for (const t of todayCompleted) {
          md += `- ✓ ${t.title}\n`;
        }
        md += '\n';
      }

      // Tasks currently in progress
      const inProgress = sprintTasks.filter(t => t.status === 'in_progress');
      if (inProgress.length > 0) {
        md += `**In progress (${inProgress.length}):**\n`;
        for (const t of inProgress) {
          const assignee = t.assigneeId || 'unassigned';
          md += `- ◉ ${t.title} (${assignee})\n`;
        }
        md += '\n';
      }

      // Remaining todo
      const remaining = sprintTasks.filter(t => t.status === 'todo');
      if (remaining.length > 0) {
        md += `**Remaining (${remaining.length}):**\n`;
        for (const t of remaining.slice(0, 10)) {
          md += `- ○ ${t.title}\n`;
        }
        if (remaining.length > 10) {
          md += `- ... and ${remaining.length - 10} more\n`;
        }
        md += '\n';
      }
    }

    if (!hasContent) continue;

    md += `---\n*Generated ${now.toISOString()} by ${PRODUCT_NAME} Sprint Automation*\n`;

    let posted = false;
    if (postToChannels) {
      // @mention Team Lead, or any agent as fallback
      const teamLeadParticipant = channel.teamLeadId
        ? channel.participants.find(p => p.id === channel.teamLeadId)
        : undefined;
      const targetAgent = teamLeadParticipant
        || channel.participants.find(p => p.type !== 'user' && p.name);

      if (targetAgent) {
        md += `\n@${targetAgent.name}\n`;
      }

      const summaryMessage: CollabMessage = {
        id: crypto.randomUUID(),
        channelId: channel.id,
        from: {
          ...makeSystemParticipant(),
          name: 'Daily Summary',
        },
        content: md,
        timestamp: now.toISOString(),
        silent: true,
      };

      try {
        await appendSilentMessage(channel.id, summaryMessage);
        posted = true;
      } catch (err) {
        console.error(`[sprints.daily_summary] Failed to post to channel ${channel.id}:`, err);
      }
    }

    summaries.push({
      channelId: channel.id,
      channelName: channel.name,
      markdown: md,
      posted,
    });
  }

  // Auto-archive completed sprints by generating FeatureDocs (same as "Close & Summarize" button)
  const archived: Array<{ channelId: string; channelName: string; docTitle: string }> = [];

  if (archiveCompleted) {
    for (const channel of channelsData.channels) {
      if (channel.parentChannelId) continue;

      // Find completed sprints in this channel
      const completedSprints = (tasksData.sprints || []).filter(
        s => s.channelId === channel.id && s.status === 'completed'
      );
      if (completedSprints.length === 0) continue;

      // Only auto-archive if ALL tasks in the completed sprints are done
      const sprintIds = completedSprints.map(s => s.id);
      const sprintTasks = tasksData.tasks.filter(
        t => sprintIds.includes(t.sprintId || '')
      );
      const allDone = sprintTasks.length > 0 && sprintTasks.every(t => t.status === 'done');
      if (!allDone) {
        continue;
      }

      // Call the feature-docs generate endpoint (same as the UI button)
      try {
        const res = await fetch(`${selfOrigin()}/api/feature-docs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate',
            channelId: channel.id,
            clearSprints: true,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.success && data.doc) {
            archived.push({
              channelId: channel.id,
              channelName: channel.name,
              docTitle: data.doc.title,
            });

            // Post archive notification as silent message
            if (postToChannels) {
              const archiveMsg: CollabMessage = {
                id: crypto.randomUUID(),
                channelId: channel.id,
                from: {
                  ...makeSystemParticipant(),
                  name: 'Sprint Automation',
                },
                content: `**Sprint archived:** ${completedSprints.map(s => s.name).join(', ')}\n\nA summary document "${data.doc.title}" has been generated and the completed sprint has been removed from the board.`,
                timestamp: new Date().toISOString(),
                silent: true,
              };
              try {
                await appendSilentMessage(channel.id, archiveMsg);
              } catch (err) {
                console.error(`[sprints.daily_summary] Failed to post archive notification to ${channel.id}:`, err);
              }
            }
          } else {
            console.error(`[sprints.daily_summary] Feature doc generation failed for ${channel.name}:`, data.error);
          }
        } else {
          console.error(`[sprints.daily_summary] Feature doc request failed for ${channel.name}: ${res.status}`);
        }
      } catch (err) {
        console.error(`[sprints.daily_summary] Failed to auto-archive for channel ${channel.id}:`, err);
      }
    }
  }

  return {
    channelsSummarized: summaries.length,
    summaries,
    archived,
  };
}

/**
 * sprints.pause_reminder - Pause or unpause sprint reminders for a specific channel
 *
 * duration: '1day' | '1week' | '1month' — how long to suppress reminders
 * clear: true — clear an existing pause (resume reminders immediately)
 */
export async function pauseReminder(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  channelId: string;
  channelName: string;
  paused: boolean;
  pausedUntil: string | null;
}> {
  const { channelId, duration, clear } = body as {
    channelId?: string;
    duration?: '1day' | '1week' | '1month';
    clear?: boolean;
  };

  if (!channelId) {
    throw new Error('channelId is required');
  }
  if (!clear && !duration) {
    throw new Error('Either duration (1day/1week/1month) or clear:true is required');
  }

  const result = await mutateChannels('agent-api:sprints-pause-reminder', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    if (clear) {
      delete channel.settings.reminderPausedUntil;
    } else {
      const ms: Record<string, number> = {
        '1day': 24 * 60 * 60 * 1000,
        '1week': 7 * 24 * 60 * 60 * 1000,
        '1month': 30 * 24 * 60 * 60 * 1000,
      };
      channel.settings.reminderPausedUntil = new Date(Date.now() + ms[duration!]).toISOString();
    }

    await saveChannels(channelsData);

    return {
      channelId: channel.id,
      channelName: channel.name,
      paused: !clear,
      pausedUntil: channel.settings.reminderPausedUntil ?? null,
    };
  });

  return result;
}

/**
 * sprints.reminderSnooze - Snooze stall reminders for a sprint until a specific time
 *
 * Params: sprintId, channelId, until (ISO timestamp), reason (required)
 * While snoozed the reminder worker skips this sprint regardless of idle time.
 * Snooze auto-clears at `until` or when any task in the sprint is updated.
 */
export async function reminderSnooze(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sprint: CollabSprint }> {
  const sprintId = body.sprintId;
  const channelId = body.channelId;
  const until = body.until;
  const reason = body.reason;

  if (!sprintId || typeof sprintId !== 'string') {
    throw Object.assign(new Error('sprintId is required'), { statusCode: 400 });
  }
  if (!channelId || typeof channelId !== 'string') {
    throw Object.assign(new Error('channelId is required'), { statusCode: 400 });
  }
  if (!until || typeof until !== 'string') {
    throw Object.assign(new Error('until (ISO timestamp) is required'), { statusCode: 400 });
  }
  // Validate ISO timestamp
  const untilDate = new Date(until);
  if (isNaN(untilDate.getTime())) {
    throw Object.assign(new Error('until must be a valid ISO timestamp'), { statusCode: 400 });
  }
  // reason is required — agents must explain why they're snoozing (audit trail)
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw Object.assign(new Error('reason is required (explain why reminders are snoozed)'), { statusCode: 400 });
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);

    if (!sprint) {
      throw Object.assign(
        new Error(`Sprint not found: ${sprintId}`),
        { statusCode: 404 }
      );
    }

    sprint.reminderSnoozeUntil = until;
    sprint.reminderSnoozeReason = reason.trim();
    sprint.updatedAt = new Date().toISOString();
    await saveTasksData(data);

    return { sprint };
  });
}

/**
 * sprints.reminderUnsnooze - Cancel an active snooze, resuming stall reminders immediately
 *
 * Params: sprintId, channelId
 */
export async function reminderUnsnooze(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ sprint: CollabSprint }> {
  const sprintId = body.sprintId;
  const channelId = body.channelId;

  if (!sprintId || typeof sprintId !== 'string') {
    throw Object.assign(new Error('sprintId is required'), { statusCode: 400 });
  }
  if (!channelId || typeof channelId !== 'string') {
    throw Object.assign(new Error('channelId is required'), { statusCode: 400 });
  }

  return withFileLock(TASKS_PATH, async () => {
    const data = await loadTasksData();
    const sprint = (data.sprints || []).find(s => s.id === sprintId && s.channelId === channelId);

    if (!sprint) {
      throw Object.assign(
        new Error(`Sprint not found: ${sprintId}`),
        { statusCode: 404 }
      );
    }

    delete sprint.reminderSnoozeUntil;
    delete sprint.reminderSnoozeReason;
    sprint.updatedAt = new Date().toISOString();
    await saveTasksData(data);

    return { sprint };
  });
}

/**
 * Build a text-based progress bar
 */
function buildProgressBar(percent: number): string {
  const filled = Math.round(percent / 10);
  const empty = 10 - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}
