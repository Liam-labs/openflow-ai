import { beforeEach, describe, expect, it, vi } from 'vitest';

const runVisualReview = vi.hoisted(() => vi.fn());
const recordVisualReviewRunTelemetry = vi.hoisted(() => vi.fn());
const readTelemetry = vi.hoisted(() => vi.fn());
const loadVerificationProfile = vi.hoisted(() => vi.fn());

vi.mock('@/lib/delivery-evidence/adapters/visual-review', () => ({ runVisualReview }));
vi.mock('@/lib/delivery-evidence/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/delivery-evidence/telemetry')>()),
  recordVisualReviewRunTelemetry,
  deliveryEvidenceTelemetry: { read: readTelemetry },
}));
vi.mock('@/lib/delivery-evidence/store', () => ({
  deliveryEvidenceStore: { loadVerificationProfile },
}));

import { executeDeliveryEvidenceRunner } from '@/lib/delivery-evidence/runner';

const request = {
  schemaVersion: 'devflow.visual-review.run.request/v1alpha1',
  taskId: 'task-telemetry-1',
  projectId: 'devflow',
  projectPath: '/home/user/DevFlow',
  contractId: 'contract-visual-pilot',
  contractFingerprint: 'a'.repeat(64),
  verificationProfileVersion: '1.0.1',
  checkpoint: 'final',
  changedPaths: ['app/page.tsx'],
};

describe('registered Visual Review runner telemetry', () => {
  beforeEach(() => {
    runVisualReview.mockReset();
    recordVisualReviewRunTelemetry.mockReset();
    recordVisualReviewRunTelemetry.mockResolvedValue(undefined);
    readTelemetry.mockReset();
    readTelemetry.mockResolvedValue([]);
    loadVerificationProfile.mockReset();
    loadVerificationProfile.mockResolvedValue({
      profile: { policy: { rendererUnavailableAfterMs: 1_800_000 } },
    });
    vi.restoreAllMocks();
  });

  it('records a structured run event without allowing telemetry failure to fail the review', async () => {
    const response = {
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Visual Review renderer is unavailable',
      retryable: true,
    } as const;
    runVisualReview.mockResolvedValue(response);
    recordVisualReviewRunTelemetry.mockRejectedValue(new Error('telemetry unavailable'));

    await expect(executeDeliveryEvidenceRunner({
      descriptorId: 'playwright.visual-review',
      descriptorVersion: '1.0.0',
      input: request,
    })).resolves.toEqual(response);
    expect(recordVisualReviewRunTelemetry).toHaveBeenCalledOnce();
    expect(recordVisualReviewRunTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      request,
      response,
      cleanupSucceeded: true,
      startedAtMs: expect.any(Number),
      finishedAtMs: expect.any(Number),
    }));
  });

  it('keeps renderer unavailability retryable while the durable outage is under the profile threshold', async () => {
    const nowMs = Date.parse('2026-08-03T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const response = {
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Visual Review renderer is unavailable',
      retryable: true,
    } as const;
    runVisualReview.mockResolvedValue(response);
    readTelemetry.mockResolvedValue([
      rendererUnavailableEvent(new Date(nowMs - 1_799_999).toISOString(), 'telemetry-1'),
      rendererUnavailableEvent(new Date(nowMs).toISOString(), 'telemetry-2'),
    ]);

    await expect(executeDeliveryEvidenceRunner({
      descriptorId: 'playwright.visual-review',
      descriptorVersion: '1.0.0',
      input: request,
    })).resolves.toEqual(response);
  });

  it('emits the frozen terminal disclosure at the registered threshold using durable telemetry history', async () => {
    const nowMs = Date.parse('2026-08-03T10:00:00.000Z');
    const registeredThresholdMs = 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    loadVerificationProfile.mockResolvedValue({
      profile: { policy: { rendererUnavailableAfterMs: registeredThresholdMs } },
    });
    runVisualReview.mockResolvedValue({
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Visual Review renderer is unavailable',
      retryable: true,
    });
    readTelemetry.mockResolvedValue([
      rendererUnavailableEvent(new Date(nowMs - registeredThresholdMs).toISOString(), 'telemetry-1'),
      {
        kind: 'task.eligible',
        id: 'telemetry-ignored',
        timestamp: new Date(nowMs - 900_000).toISOString(),
        taskId: request.taskId,
        projectId: request.projectId,
      },
      rendererUnavailableEvent(new Date(nowMs).toISOString(), 'telemetry-2'),
    ]);

    await expect(executeDeliveryEvidenceRunner({
      descriptorId: 'playwright.visual-review',
      descriptorVersion: '1.0.0',
      input: request,
    })).resolves.toEqual({
      success: false,
      code: 'DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING',
      error: 'Visual verification is pending after sustained renderer unavailability',
      retryable: false,
      reasonCode: 'visual_verification_pending',
      postHocReviewRequired: true,
    });
    expect(loadVerificationProfile).toHaveBeenCalledWith({
      projectId: request.projectId,
      projectPath: request.projectPath,
      expectedVersion: request.verificationProfileVersion,
    });
    expect(readTelemetry).toHaveBeenCalledWith({
      projectId: request.projectId,
      taskId: request.taskId,
      limit: 100_000,
    });
    expect(recordVisualReviewRunTelemetry.mock.invocationCallOrder[0])
      .toBeLessThan(readTelemetry.mock.invocationCallOrder[0]);
  });

  it('does not invent a terminal disclosure when durable telemetry cannot be read', async () => {
    const response = {
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Visual Review renderer is unavailable',
      retryable: true,
    } as const;
    runVisualReview.mockResolvedValue(response);
    readTelemetry.mockRejectedValue(new Error('telemetry unreadable'));

    await expect(executeDeliveryEvidenceRunner({
      descriptorId: 'playwright.visual-review',
      descriptorVersion: '1.0.0',
      input: request,
    })).resolves.toEqual(response);
  });

  it('resets the durable outage window after a successful run', async () => {
    const nowMs = Date.parse('2026-08-03T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const response = {
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Visual Review renderer is unavailable',
      retryable: true,
    } as const;
    runVisualReview.mockResolvedValue(response);
    readTelemetry.mockResolvedValue([
      rendererUnavailableEvent(new Date(nowMs - 3_600_000).toISOString(), 'telemetry-1'),
      {
        ...rendererUnavailableEvent(new Date(nowMs - 60_000).toISOString(), 'telemetry-success'),
        outcome: 'success',
        errorCode: undefined,
      },
      rendererUnavailableEvent(new Date(nowMs).toISOString(), 'telemetry-2'),
    ]);

    await expect(executeDeliveryEvidenceRunner({
      descriptorId: 'playwright.visual-review',
      descriptorVersion: '1.0.0',
      input: request,
    })).resolves.toEqual(response);
  });
});

function rendererUnavailableEvent(timestamp: string, id: string) {
  return {
    kind: 'run.completed' as const,
    id,
    timestamp,
    taskId: request.taskId,
    projectId: request.projectId,
    checkpoint: 'final' as const,
    outcome: 'error' as const,
    errorCode: 'delivery_evidence_renderer_unavailable',
    durationMs: 1,
    cleanupSucceeded: true,
    findingCounts: { p0: 0, p1: 0, p2: 0, p3: 0 },
  };
}
