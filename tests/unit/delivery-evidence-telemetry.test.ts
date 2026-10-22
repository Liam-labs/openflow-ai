import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDeliveryEvidenceTelemetry } from '@/lib/delivery-evidence/telemetry';

const temporaryRoots: string[] = [];
const NOW = '2026-08-03T10:00:00.000Z';

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-telemetry-'));
  temporaryRoots.push(root);
  return path.join(root, 'events.jsonl');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('Delivery Evidence pilot telemetry', () => {
  it('persists structured events and computes the pilot rates without severity inflation', async () => {
    let id = 0;
    const telemetry = createDeliveryEvidenceTelemetry({
      filePath: await temporaryFile(),
      now: () => NOW,
      createId: () => `telemetry-${++id}`,
    });

    await telemetry.record({ kind: 'task.eligible', taskId: 'task-1', projectId: 'devflow' });
    await telemetry.record({ kind: 'task.eligible', taskId: 'task-2', projectId: 'devflow' });
    await telemetry.record({
      kind: 'run.completed',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-1',
      checkpoint: 'final',
      outcome: 'success',
      decision: 'disclose',
      durationMs: 100,
      cleanupSucceeded: true,
      findingCounts: { p0: 0, p1: 1, p2: 0, p3: 0 },
    });
    await telemetry.record({
      kind: 'run.completed',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-2',
      checkpoint: 'final',
      outcome: 'success',
      decision: 'deliver',
      durationMs: 300,
      cleanupSucceeded: false,
      findingCounts: { p0: 0, p1: 0, p2: 2, p3: 0 },
    });
    await telemetry.record({
      kind: 'decision.recorded',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-1',
      decision: 'revise',
      codeChangedAfterEvidence: true,
      dismissedObjectiveP0P1Count: 1,
    });
    await telemetry.record({
      kind: 'task.waived',
      taskId: 'task-2',
      projectId: 'devflow',
      reasonCode: 'non_rendered_type_only_change',
    });
    await telemetry.record({
      kind: 'receipt.freshness',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-1',
      status: 'fresh',
    });
    await telemetry.record({
      kind: 'receipt.freshness',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-2',
      status: 'stale',
    });

    const events = await telemetry.read({ projectId: 'devflow' });
    const summary = telemetry.summarize(events);

    expect(events).toHaveLength(8);
    expect(summary).toMatchObject({
      eligibleTaskCount: 2,
      tasksWithRuns: 1,
      runCount: 2,
      adoptionRate: 0.5,
      runsPerEligibleTask: 1,
      revisionRate: 0.5,
      overrideRate: 1,
      waiverRate: 0.5,
      averageDurationMs: 200,
      p95DurationMs: 300,
      cleanupSuccessRate: 0.5,
      staleReceiptRate: 0.5,
    });
    expect(summary.findingTotals).toEqual({ p0: 0, p1: 1, p2: 2, p3: 0 });
    expect(summary.findingsPerRun).toEqual({ p0: 0, p1: 0.5, p2: 1, p3: 0 });
  });

  it('rejects unstructured waiver prose so telemetry cannot become review paperwork', async () => {
    const telemetry = createDeliveryEvidenceTelemetry({ filePath: await temporaryFile() });
    await expect(telemetry.record({
      kind: 'task.waived',
      taskId: 'task-1',
      projectId: 'devflow',
      reasonCode: 'because I felt like it',
    })).rejects.toMatchObject({ code: 'DELIVERY_EVIDENCE_TELEMETRY_INVALID_EVENT' });
  });

  it('uses the latest decision and freshness event per receipt instead of inflating rates', async () => {
    const telemetry = createDeliveryEvidenceTelemetry({ filePath: await temporaryFile() });
    await telemetry.record({ kind: 'task.eligible', taskId: 'task-1', projectId: 'devflow' });
    await telemetry.record({
      kind: 'run.completed',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-1',
      checkpoint: 'final',
      outcome: 'success',
      decision: 'disclose',
      durationMs: 100,
      cleanupSucceeded: true,
      findingCounts: { p0: 0, p1: 1, p2: 0, p3: 0 },
    });
    for (let index = 0; index < 2; index += 1) {
      await telemetry.record({
        kind: 'decision.recorded',
        taskId: 'task-1',
        projectId: 'devflow',
        receiptId: 'receipt-1',
        decision: 'revise',
        codeChangedAfterEvidence: true,
        dismissedObjectiveP0P1Count: 1,
      });
    }
    await telemetry.record({
      kind: 'receipt.freshness',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-1',
      status: 'stale',
    });
    await telemetry.record({
      kind: 'receipt.freshness',
      taskId: 'task-1',
      projectId: 'devflow',
      receiptId: 'receipt-1',
      status: 'fresh',
    });

    const summary = telemetry.summarize(await telemetry.read());
    expect(summary.revisionRate).toBe(1);
    expect(summary.overrideRate).toBe(1);
    expect(summary.staleReceiptRate).toBe(0);
  });
});
