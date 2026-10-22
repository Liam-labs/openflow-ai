import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { parseVisualReviewRunRequest } from '@/lib/delivery-evidence/schema';
import type { VisualReviewRunResponse } from '@/lib/delivery-evidence/types';

const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const ReasonCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,99}$/);
const FindingCountsSchema = z.object({
  p0: z.number().int().nonnegative(),
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
  p3: z.number().int().nonnegative(),
}).strict();

export const DeliveryEvidenceTelemetryEventInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task.eligible'),
    taskId: IdSchema,
    projectId: IdSchema,
  }).strict(),
  z.object({
    kind: z.literal('run.completed'),
    taskId: IdSchema,
    projectId: IdSchema,
    receiptId: IdSchema.optional(),
    checkpoint: z.enum(['slice', 'risk', 'final']),
    outcome: z.enum(['success', 'error']),
    decision: z.enum(['deliver', 'revise', 'disclose']).optional(),
    errorCode: ReasonCodeSchema.optional(),
    durationMs: z.number().int().nonnegative().max(10 * 60 * 1000),
    cleanupSucceeded: z.boolean(),
    findingCounts: FindingCountsSchema,
  }).strict(),
  z.object({
    kind: z.literal('decision.recorded'),
    taskId: IdSchema,
    projectId: IdSchema,
    receiptId: IdSchema,
    decision: z.enum(['deliver', 'revise', 'disclose']),
    codeChangedAfterEvidence: z.boolean(),
    dismissedObjectiveP0P1Count: z.number().int().nonnegative().max(10_000),
  }).strict(),
  z.object({
    kind: z.literal('task.waived'),
    taskId: IdSchema,
    projectId: IdSchema,
    reasonCode: ReasonCodeSchema,
  }).strict(),
  z.object({
    kind: z.literal('receipt.freshness'),
    taskId: IdSchema,
    projectId: IdSchema,
    receiptId: IdSchema,
    status: z.enum(['fresh', 'stale']),
  }).strict(),
]);

const StoredTelemetryEventSchema = z.intersection(
  DeliveryEvidenceTelemetryEventInputSchema,
  z.object({
    id: IdSchema,
    timestamp: z.iso.datetime(),
  }).strict(),
);

export type DeliveryEvidenceTelemetryEventInput = z.infer<
  typeof DeliveryEvidenceTelemetryEventInputSchema
>;
export type DeliveryEvidenceTelemetryEvent = DeliveryEvidenceTelemetryEventInput & {
  id: string;
  timestamp: string;
};

export type DeliveryEvidenceTelemetryErrorCode =
  | 'DELIVERY_EVIDENCE_TELEMETRY_INVALID_EVENT'
  | 'DELIVERY_EVIDENCE_TELEMETRY_STORAGE_FAILED';

export class DeliveryEvidenceTelemetryError extends Error {
  constructor(
    message: string,
    public readonly code: DeliveryEvidenceTelemetryErrorCode,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'DeliveryEvidenceTelemetryError';
  }
}

export interface DeliveryEvidenceTelemetryOptions {
  filePath?: string;
  now?: () => string;
  createId?: () => string;
}

export interface ReadDeliveryEvidenceTelemetryInput {
  projectId?: string;
  taskId?: string;
  limit?: number;
}

export interface DeliveryEvidenceTelemetrySummary {
  eligibleTaskCount: number;
  tasksWithRuns: number;
  runCount: number;
  adoptionRate: number | null;
  runsPerEligibleTask: number | null;
  findingTotals: { p0: number; p1: number; p2: number; p3: number };
  findingsPerRun: { p0: number; p1: number; p2: number; p3: number };
  revisionRate: number | null;
  overrideRate: number | null;
  waiverRate: number | null;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  cleanupSuccessRate: number | null;
  staleReceiptRate: number | null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function createDeliveryEvidenceTelemetry(
  options: DeliveryEvidenceTelemetryOptions = {},
) {
  const filePath = options.filePath ?? DataPaths.deliveryEvidenceTelemetry;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => `telemetry-${randomUUID()}`);

  async function record(input: unknown): Promise<DeliveryEvidenceTelemetryEvent> {
    let parsed: DeliveryEvidenceTelemetryEventInput;
    try {
      parsed = DeliveryEvidenceTelemetryEventInputSchema.parse(input);
    } catch {
      throw new DeliveryEvidenceTelemetryError(
        'Delivery Evidence telemetry event is invalid',
        'DELIVERY_EVIDENCE_TELEMETRY_INVALID_EVENT',
        400,
      );
    }

    const event = StoredTelemetryEventSchema.parse({
      ...parsed,
      id: createId(),
      timestamp: now(),
    }) as DeliveryEvidenceTelemetryEvent;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await withFileLock(filePath, async () => {
        await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      });
      return event;
    } catch (error) {
      if (error instanceof DeliveryEvidenceTelemetryError) throw error;
      throw new DeliveryEvidenceTelemetryError(
        'Unable to persist Delivery Evidence telemetry',
        'DELIVERY_EVIDENCE_TELEMETRY_STORAGE_FAILED',
        500,
      );
    }
  }

  async function read(
    input: ReadDeliveryEvidenceTelemetryInput = {},
  ): Promise<DeliveryEvidenceTelemetryEvent[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 10_000, 100_000));
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new DeliveryEvidenceTelemetryError(
        'Unable to read Delivery Evidence telemetry',
        'DELIVERY_EVIDENCE_TELEMETRY_STORAGE_FAILED',
        500,
      );
    }

    const events: DeliveryEvidenceTelemetryEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = StoredTelemetryEventSchema.parse(JSON.parse(line)) as DeliveryEvidenceTelemetryEvent;
        if (input.projectId && event.projectId !== input.projectId) continue;
        if (input.taskId && event.taskId !== input.taskId) continue;
        events.push(event);
      } catch {
        // A malformed historical line must not make the entire pilot dataset unreadable.
      }
    }
    return events.slice(-limit);
  }

  function summarize(events: DeliveryEvidenceTelemetryEvent[]): DeliveryEvidenceTelemetrySummary {
    const eligibleTasks = new Set<string>();
    const tasksWithRuns = new Set<string>();
    const waivedTasks = new Set<string>();
    const runs = events.filter((event) => event.kind === 'run.completed');
    const decisionsByReceipt = new Map<string, {
      codeChangedAfterEvidence: boolean;
      dismissedObjectiveP0P1Count: number;
    }>();
    const freshnessByReceipt = new Map<string, 'fresh' | 'stale'>();
    for (const event of events) {
      const taskKey = `${event.projectId}\u0000${event.taskId}`;
      if (event.kind === 'task.eligible') eligibleTasks.add(taskKey);
      if (event.kind === 'run.completed') tasksWithRuns.add(taskKey);
      if (event.kind === 'task.waived') waivedTasks.add(taskKey);
      if (event.kind === 'decision.recorded') {
        decisionsByReceipt.set(event.receiptId, {
          codeChangedAfterEvidence: event.codeChangedAfterEvidence,
          dismissedObjectiveP0P1Count: event.dismissedObjectiveP0P1Count,
        });
      }
      if (event.kind === 'receipt.freshness') {
        freshnessByReceipt.set(event.receiptId, event.status);
      }
    }
    const decisions = [...decisionsByReceipt.values()];
    const freshness = [...freshnessByReceipt.values()];

    const findingTotals = runs.reduce((totals, event) => ({
      p0: totals.p0 + event.findingCounts.p0,
      p1: totals.p1 + event.findingCounts.p1,
      p2: totals.p2 + event.findingCounts.p2,
      p3: totals.p3 + event.findingCounts.p3,
    }), { p0: 0, p1: 0, p2: 0, p3: 0 });
    const durations = runs.map((event) => event.durationMs).sort((left, right) => left - right);
    const objectiveP0P1 = findingTotals.p0 + findingTotals.p1;
    const dismissedObjectiveP0P1 = decisions.reduce(
      (total, event) => total + event.dismissedObjectiveP0P1Count,
      0,
    );
    const revisions = decisions.filter((event) => event.codeChangedAfterEvidence).length;
    const staleReceipts = freshness.filter((status) => status === 'stale').length;

    return {
      eligibleTaskCount: eligibleTasks.size,
      tasksWithRuns: tasksWithRuns.size,
      runCount: runs.length,
      adoptionRate: ratio(tasksWithRuns.size, eligibleTasks.size),
      runsPerEligibleTask: ratio(runs.length, eligibleTasks.size),
      findingTotals,
      findingsPerRun: {
        p0: ratio(findingTotals.p0, runs.length) ?? 0,
        p1: ratio(findingTotals.p1, runs.length) ?? 0,
        p2: ratio(findingTotals.p2, runs.length) ?? 0,
        p3: ratio(findingTotals.p3, runs.length) ?? 0,
      },
      revisionRate: ratio(revisions, runs.length),
      overrideRate: ratio(dismissedObjectiveP0P1, objectiveP0P1),
      waiverRate: ratio(waivedTasks.size, eligibleTasks.size),
      averageDurationMs: durations.length > 0
        ? durations.reduce((total, value) => total + value, 0) / durations.length
        : null,
      p95DurationMs: durations.length > 0
        ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)]
        : null,
      cleanupSuccessRate: ratio(
        runs.filter((event) => event.cleanupSucceeded).length,
        runs.length,
      ),
      staleReceiptRate: ratio(staleReceipts, freshness.length),
    };
  }

  return { filePath, record, read, summarize };
}

export const deliveryEvidenceTelemetry = createDeliveryEvidenceTelemetry();

export async function recordVisualReviewRunTelemetry(input: {
  request: unknown;
  response: VisualReviewRunResponse;
  startedAtMs: number;
  finishedAtMs: number;
  cleanupSucceeded: boolean;
}): Promise<void> {
  let request: ReturnType<typeof parseVisualReviewRunRequest>;
  try {
    request = parseVisualReviewRunRequest(input.request);
  } catch {
    return;
  }

  const findingCounts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  if (input.response.success) {
    for (const finding of input.response.receipt.findings) {
      findingCounts[finding.severity] += 1;
    }
  }
  await deliveryEvidenceTelemetry.record({
    kind: 'run.completed',
    taskId: request.taskId,
    projectId: request.projectId,
    receiptId: input.response.success ? input.response.receipt.id : undefined,
    checkpoint: request.checkpoint,
    outcome: input.response.success ? 'success' : 'error',
    decision: input.response.success ? input.response.receipt.decision.kind : undefined,
    errorCode: input.response.success ? undefined : input.response.code.toLowerCase(),
    durationMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
    cleanupSucceeded: input.cleanupSucceeded,
    findingCounts,
  });
}

export type RendererCircuitBreakerDecision =
  | { action: 'retry'; retryable: true; postHocReviewRequired: false }
  | {
      action: 'disclose';
      retryable: false;
      reasonCode: 'visual_verification_pending';
      postHocReviewRequired: true;
    };

export function evaluateRendererCircuitBreaker(input: {
  unavailableSinceMs: number;
  nowMs: number;
  thresholdMs: number;
}): RendererCircuitBreakerDecision {
  if (input.nowMs - input.unavailableSinceMs < input.thresholdMs) {
    return { action: 'retry', retryable: true, postHocReviewRequired: false };
  }
  return {
    action: 'disclose',
    retryable: false,
    reasonCode: 'visual_verification_pending',
    postHocReviewRequired: true,
  };
}
