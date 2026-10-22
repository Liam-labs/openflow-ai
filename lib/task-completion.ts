/**
 * Guarded, idempotent task completion shared by POST /api/collab/tasks (action `complete`)
 * and the Agent API `tasks.complete` action.
 *
 * Contract (docs/atomic-task-completion/Plan.md):
 * - `expectedAssigneeId` (string, or explicit null for "unassigned") and `expectedUpdatedAt`
 *   (revision string) are optional guards. When supplied they are compared with the live task
 *   inside the caller's task-store lock, before any mutation. A mismatch is a conflict and the
 *   caller performs no write or side effect.
 * - `idempotencyKey` is optional. The successful completion is recorded as a receipt in the same
 *   tasks-file write as the mutation, scoped to channel/task/action and bound to a hash of the
 *   effective request. A retry with the same key and payload replays the receipt (no new
 *   transition, even if the card was reopened since); the same key with a different payload
 *   conflicts. Receipts are never pruned, so an old retry can never become a new completion.
 * - Every task mutation advances `updatedAt` strictly (see nextTaskRevision), so two changes
 *   within one millisecond still produce different revisions for the guard to compare.
 *
 * The functions here only read and mutate the in-memory CollabTasksData; callers hold the lock,
 * write the file and fire their own effects only for a `completed` outcome.
 */

import { createHash } from 'crypto';
import type { CollabTask, CollabTaskCompletionReceipt, CollabTasksData } from './types';

export const TASK_COMPLETION_CONFLICT = 'TASK_COMPLETION_CONFLICT';
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';
export const INVALID_COMPLETION_REQUEST = 'INVALID_COMPLETION_REQUEST';

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Next `updatedAt` for a task: now, or 1 ms past the previous revision when the clock has not
 * moved on (or went backwards), so successive revisions are always distinct and ordered.
 */
export function nextTaskRevision(previous: string | undefined, nowMs: number = Date.now()): string {
  const prevMs = previous ? Date.parse(previous) : NaN;
  const ms = Number.isFinite(prevMs) && prevMs >= nowMs ? prevMs + 1 : nowMs;
  return new Date(ms).toISOString();
}

type Guard<T> = { supplied: false } | { supplied: true; value: T };

export interface CompletionRequest {
  channelId: string;
  taskId: string;
  participantId: string;
  expectedAssigneeId: Guard<string | null>;
  expectedUpdatedAt: Guard<string>;
  idempotencyKey?: string;
}

export interface CompletionConflict {
  field: 'assigneeId' | 'updatedAt';
  expected: string | null;
  current: string | null;
}

export type CompletionOutcome =
  | { kind: 'completed'; task: CollabTask; receipt?: CollabTaskCompletionReceipt }
  | { kind: 'replay'; receipt: CollabTaskCompletionReceipt; liveTask: CollabTask | null; liveStateChanged: boolean }
  | { kind: 'not_found' }
  | {
      kind: 'conflict';
      conflicts: CompletionConflict[];
      current: { status: CollabTask['status']; assigneeId: string | null; updatedAt: string };
    }
  | { kind: 'key_conflict'; receipt: CollabTaskCompletionReceipt };

export type ParseResult = { ok: true; request: CompletionRequest } | { ok: false; error: string };

const has = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);

/**
 * Validate the optional guard and idempotency fields. A present field with the wrong type is an
 * error, never a silently disabled guard. Required ids are validated by the callers as before.
 */
export function parseCompletionRequest(body: Record<string, unknown>): ParseResult {
  const base = {
    channelId: String(body.channelId),
    taskId: String(body.taskId),
    participantId: String(body.participantId),
  };

  let expectedAssigneeId: CompletionRequest['expectedAssigneeId'] = { supplied: false };
  if (has(body, 'expectedAssigneeId')) {
    const v = body.expectedAssigneeId;
    if (v !== null && (typeof v !== 'string' || v.length === 0)) {
      return { ok: false, error: 'expectedAssigneeId must be a non-empty string, or null for an unassigned task' };
    }
    expectedAssigneeId = { supplied: true, value: v as string | null };
  }

  let expectedUpdatedAt: CompletionRequest['expectedUpdatedAt'] = { supplied: false };
  if (has(body, 'expectedUpdatedAt')) {
    const v = body.expectedUpdatedAt;
    if (typeof v !== 'string' || v.length === 0) {
      return { ok: false, error: 'expectedUpdatedAt must be the non-empty updatedAt string read from the task' };
    }
    expectedUpdatedAt = { supplied: true, value: v };
  }

  let idempotencyKey: string | undefined;
  if (has(body, 'idempotencyKey')) {
    const v = body.idempotencyKey;
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return { ok: false, error: `idempotencyKey must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` };
    }
    idempotencyKey = v;
  }

  return { ok: true, request: { ...base, expectedAssigneeId, expectedUpdatedAt, idempotencyKey } };
}

/** Receipt id: channel/task/action scoped, unambiguous whatever characters the key holds. */
export function receiptId(channelId: string, taskId: string, key: string): string {
  return JSON.stringify([channelId, taskId, 'complete', key]);
}

/** Hash of the effective request: who completes which task under which guards. */
export function completionRequestHash(req: CompletionRequest): string {
  const canonical = JSON.stringify([
    req.channelId,
    req.taskId,
    req.participantId,
    req.expectedAssigneeId.supplied ? ['assignee', req.expectedAssigneeId.value] : ['assignee-omitted'],
    req.expectedUpdatedAt.supplied ? ['updatedAt', req.expectedUpdatedAt.value] : ['updatedAt-omitted'],
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Decide and (for `completed` only) apply a completion to `data`. Must run inside the task-store
 * lock; the caller writes `data` and fires effects only when the outcome is `completed`.
 */
export function applyTaskCompletion(data: CollabTasksData, req: CompletionRequest, nowMs: number = Date.now()): CompletionOutcome {
  const requestHash = completionRequestHash(req);
  const findTask = () => data.tasks.find(t => t.id === req.taskId && t.channelId === req.channelId);

  if (req.idempotencyKey !== undefined) {
    const existing = data.completionReceipts?.[receiptId(req.channelId, req.taskId, req.idempotencyKey)];
    if (existing) {
      if (existing.requestHash !== requestHash) return { kind: 'key_conflict', receipt: existing };
      const live = findTask() ?? null;
      return {
        kind: 'replay',
        receipt: existing,
        liveTask: live,
        liveStateChanged: !live || live.updatedAt !== existing.task.updatedAt,
      };
    }
  }

  const task = findTask();
  if (!task) return { kind: 'not_found' };

  const conflicts: CompletionConflict[] = [];
  const currentAssignee = task.assigneeId || null;
  if (req.expectedAssigneeId.supplied && req.expectedAssigneeId.value !== currentAssignee) {
    conflicts.push({ field: 'assigneeId', expected: req.expectedAssigneeId.value, current: currentAssignee });
  }
  if (req.expectedUpdatedAt.supplied && req.expectedUpdatedAt.value !== task.updatedAt) {
    conflicts.push({ field: 'updatedAt', expected: req.expectedUpdatedAt.value, current: task.updatedAt });
  }
  if (conflicts.length > 0) {
    return {
      kind: 'conflict',
      conflicts,
      current: { status: task.status, assigneeId: currentAssignee, updatedAt: task.updatedAt },
    };
  }

  const revision = nextTaskRevision(task.updatedAt, nowMs);
  task.status = 'done';
  task.completedAt = revision;
  task.updatedAt = revision;

  let receipt: CollabTaskCompletionReceipt | undefined;
  if (req.idempotencyKey !== undefined) {
    receipt = {
      channelId: req.channelId,
      taskId: req.taskId,
      action: 'complete',
      idempotencyKey: req.idempotencyKey,
      requestHash,
      participantId: req.participantId,
      recordedAt: revision,
      task: structuredClone(task),
    };
    data.completionReceipts ??= {};
    data.completionReceipts[receiptId(req.channelId, req.taskId, req.idempotencyKey)] = receipt;
  }
  return { kind: 'completed', task, receipt };
}

/** Human-readable error for a guard conflict. */
export function conflictMessage(conflicts: CompletionConflict[]): string {
  const parts = conflicts.map(c => `${c.field} is ${JSON.stringify(c.current)}, expected ${JSON.stringify(c.expected)}`);
  return `Task changed since it was read (${parts.join('; ')}). Fetch the task and re-evaluate before completing; do not retry with the new values automatically.`;
}

export const KEY_REUSED_MESSAGE =
  'idempotencyKey was already used to complete this task with a different request. Use a new key for a new request.';
