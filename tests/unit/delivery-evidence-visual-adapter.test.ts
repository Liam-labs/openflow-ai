import { describe, expect, it, vi } from 'vitest';

import { ComputerUseError } from '@/lib/computer-use';
import { VisualReviewRunResponseSchema } from '@/lib/delivery-evidence/schema';
import {
  createVisualReviewRunner,
  type VisualReviewAdapterDependencies,
} from '@/lib/delivery-evidence/adapters/visual-review';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const NOW = '2026-08-03T00:00:00.000Z';

function dependencies(): VisualReviewAdapterDependencies {
  let counter = 0;
  return {
    store: {
      loadVerificationProfile: vi.fn().mockResolvedValue({
        profile: {
          schemaVersion: 'devflow.delivery-evidence.profile/v1alpha1',
          profile: { id: 'devflow-local', version: '1.0.0' },
          project: { id: 'devflow', root: '.' },
          preview: {
            baseUrl: 'http://127.0.0.1:3000',
            readiness: { path: '/api/health', timeoutMs: 15_000 },
            routes: ['/'],
            viewports: [{ id: 'desktop', width: 1280, height: 800 }],
          },
          fixtures: { default: 'safe-demo', profiles: [{ id: 'safe-demo' }] },
          checks: {
            'visual-review': {
              runnerId: 'playwright.visual-review',
              runnerVersion: '1.0.0',
              enabled: true,
              inputProfile: 'devflow-dashboard-v1',
            },
          },
          riskRules: [],
          policy: {
            mode: 'advisory',
            maxRevisionPasses: 2,
            rendererUnavailableAfterMs: 1_800_000,
          },
        },
        fingerprint: SHA_A,
        projectPath: '/home/user/DevFlow',
        profilePath: '/home/user/DevFlow/.devflow/delivery-evidence.yaml',
        policyFloorVersion: 'delivery-evidence-floor/v1',
      }),
      writeArtifact: vi.fn().mockImplementation(async (input) => ({
        path: `/tmp/${input.artifactId}.${input.extension}`,
        uri: `delivery-evidence://devflow/receipt-test/${input.artifactId}.${input.extension}`,
        sha256: SHA_B,
        byteSize: Buffer.byteLength(input.data),
      })),
      writeReceipt: vi.fn().mockImplementation(async (receipt) => receipt),
    },
    waitForReadiness: vi.fn().mockResolvedValue(undefined),
    startHeadlessSession: vi.fn().mockResolvedValue({
      config: { engine: 'chromium', viewport: { width: 1280, height: 800 } },
    }),
    stopHeadlessSession: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn().mockResolvedValue({
      screenshot: Buffer.from('png'),
      accessibilityTree: '- RootWebArea "Demo"',
      consoleErrors: [],
      networkFailures: [],
      accessibilityFindings: [{
        code: 'missing_alt',
        severity: 'p2',
        summary: 'Image is missing alt text',
        selector: 'img',
      }],
    }),
    computeSourceFingerprint: vi.fn().mockResolvedValue(SHA_B),
    now: () => NOW,
    createId: (prefix) => `${prefix}-${++counter}`,
  };
}

const request = {
  schemaVersion: 'devflow.visual-review.run.request/v1alpha1' as const,
  taskId: 'task-visual-001',
  projectId: 'devflow',
  projectPath: '/home/user/DevFlow',
  contractId: 'contract-visual-pilot',
  contractFingerprint: SHA_A,
  verificationProfileVersion: '1.0.0',
  checkpoint: 'final' as const,
  changedPaths: ['components/Example.tsx'],
  routes: ['/'],
  viewports: [{ id: 'desktop', width: 1280, height: 800 }],
  fixtureProfile: 'safe-demo',
};

describe('visual-review.run adapter', () => {
  it('captures viewport and full-page evidence, persists artifacts and an immutable receipt', async () => {
    const deps = dependencies();
    const run = createVisualReviewRunner(deps);

    const response = await run(request);

    expect(VisualReviewRunResponseSchema.parse(response).success).toBe(true);
    if (!response.success) throw new Error(response.error);
    expect(response.result.screenshots).toEqual([
      expect.objectContaining({ fullPage: false }),
      expect.objectContaining({ fullPage: true }),
    ]);
    expect(response.result.accessibilityFindings).toEqual([
      expect.objectContaining({ code: 'missing_alt', severity: 'p2' }),
    ]);
    expect(deps.startHeadlessSession).toHaveBeenCalledOnce();
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.capture).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({
      renderedReadiness: { selector: 'header' },
    }));
    expect(deps.stopHeadlessSession).toHaveBeenCalledOnce();
    expect(deps.store.writeReceipt).toHaveBeenCalledOnce();
    expect(response.receipt.freshness).toMatchObject({
      status: 'fresh',
      sourceFingerprint: SHA_B,
      verificationProfileFingerprint: SHA_A,
    });
  });

  it('always closes a started browser session when capture fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.capture).mockRejectedValueOnce(new Error('capture failed'));

    const response = await createVisualReviewRunner(deps)(request);

    expect(response).toEqual({
      success: false,
      code: 'DELIVERY_EVIDENCE_RUNNER_FAILED',
      error: 'Visual Review execution failed',
      retryable: true,
    });
    expect(deps.stopHeadlessSession).toHaveBeenCalledOnce();
    expect(deps.store.writeReceipt).not.toHaveBeenCalled();
  });

  it('omits an oversized full-page screenshot and persists a disclosure receipt', async () => {
    const deps = dependencies();
    vi.mocked(deps.capture)
      .mockResolvedValueOnce({
        screenshot: Buffer.from('viewport-png'),
        accessibilityTree: '- RootWebArea "Demo"',
        consoleErrors: [],
        networkFailures: [],
        accessibilityFindings: [],
      })
      .mockRejectedValueOnce(new ComputerUseError(
        'Visual Review screenshot exceeds the registered artifact limit',
        'COMPUTER_USE_HEADLESS_ARTIFACT_TOO_LARGE',
        413,
      ));

    const response = await createVisualReviewRunner(deps)(request);

    expect(response.success).toBe(true);
    if (!response.success) throw new Error(response.error);
    expect(response.result.screenshots).toEqual([
      expect.objectContaining({ fullPage: false }),
    ]);
    expect(response.receipt.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'full_page_screenshot_truncated',
        severity: 'p2',
        status: 'unresolved',
      }),
    ]));
    expect(response.receipt.decision).toMatchObject({
      kind: 'disclose',
      reasonCode: 'pilot_advisory_findings',
    });
    expect(deps.stopHeadlessSession).toHaveBeenCalledOnce();
    expect(deps.store.writeReceipt).toHaveBeenCalledOnce();
  });

  it('requires an implementing-agent visual decision even when deterministic checks are clean', async () => {
    const deps = dependencies();
    vi.mocked(deps.capture).mockResolvedValue({
      screenshot: Buffer.from('png'),
      accessibilityTree: '- RootWebArea "Demo"',
      consoleErrors: [],
      networkFailures: [],
      accessibilityFindings: [],
    });

    const response = await createVisualReviewRunner(deps)(request);

    expect(response.success).toBe(true);
    if (!response.success) throw new Error(response.error);
    expect(response.receipt.review).toMatchObject({
      mode: 'deterministic_only',
      reviewedArtifactIds: [],
    });
    expect(response.receipt.findings).toEqual([
      expect.objectContaining({
        code: 'visual_review_pending',
        severity: 'p2',
        status: 'unresolved',
      }),
    ]);
    expect(response.receipt.decision).toMatchObject({
      kind: 'disclose',
      reasonCode: 'visual_review_pending',
    });
  });
});
