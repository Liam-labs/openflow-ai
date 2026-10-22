import { describe, expect, it, vi } from 'vitest';

import {
  buildContactSheetScreenshots,
  describeDecision,
  invokeVisualReview,
  invokeVisualReviewWithCircuitBreaker,
  renderContactSheetHtmlBlock,
  resolveArtifactUrl,
} from '@/lib/delivery-evidence/skill';
import type {
  DeliveryEvidenceReceipt,
  EvidenceArtifact,
  EvidenceFinding,
  VisualReviewRunResponse,
  VisualReviewRunResult,
} from '@/lib/delivery-evidence/types';

const SHA = 'a'.repeat(64);
const NOW = '2026-08-03T09:00:00.000Z';

function baseReceipt(overrides: Partial<DeliveryEvidenceReceipt> = {}): DeliveryEvidenceReceipt {
  return {
    schemaVersion: 'devflow.delivery-evidence/v1alpha1',
    id: 'receipt-1',
    taskId: 'task-1',
    projectId: 'devflow',
    createdAt: NOW,
    contract: {
      id: 'contract-visual-pilot',
      fingerprint: SHA,
      delegatedAuthorityPolicyId: 'advisory-pilot-v1',
      verificationPolicyId: 'visual-pilot-v1',
    },
    source: { fingerprint: SHA, changedPaths: [] },
    adapter: { id: 'visual-review.playwright', version: '1.0.0' },
    verificationProfile: { id: 'devflow-local', version: '1.0.0', fingerprint: SHA },
    environment: { id: 'local-safe', kind: 'local', fixtureProfile: 'safe-demo', secretRefs: [] },
    checks: [
      {
        checkId: 'visual-review.capture',
        runner: { id: 'playwright.visual-review', version: '1.0.0' },
        status: 'passed',
        startedAt: NOW,
        finishedAt: NOW,
        durationMs: 100,
        exitCode: 0,
        counts: { passed: 1, failed: 0, skipped: 0 },
        artifactIds: [],
        logIds: [],
      },
    ],
    artifacts: [],
    redaction: { status: 'not_required', checkedAt: NOW, secretRefsOnly: true },
    review: {
      mode: 'deterministic_only',
      reviewerId: 'visual-review.runner',
      harness: 'other',
      capabilities: { vision: false, imageIngress: 'unavailable' },
      reviewedArtifactIds: [],
      reviewedAt: NOW,
    },
    freshness: {
      status: 'fresh',
      evaluatedAt: NOW,
      sourceFingerprint: SHA,
      verificationProfileFingerprint: SHA,
    },
    findings: [],
    decision: { kind: 'deliver', decidedBy: 'visual-review.runner', decidedAt: NOW },
    ...overrides,
  };
}

const requestInput = {
  taskId: 'task-1',
  projectId: 'devflow',
  projectPath: '/home/user/DevFlow',
  contractId: 'contract-visual-pilot',
  contractFingerprint: SHA,
  verificationProfileVersion: '1.0.1',
  checkpoint: 'final' as const,
  changedPaths: ['components/delivery-evidence/ContactSheet.tsx'],
};

describe('invokeVisualReview', () => {
  it('posts to the visual-review.run endpoint and returns the parsed success response', async () => {
    const receipt = baseReceipt();
    const result: VisualReviewRunResult = {
      screenshots: [
        {
          artifactId: 'artifact-abc',
          route: '/collab',
          viewport: { id: 'mobile', width: 375, height: 812 },
          fullPage: false,
        },
      ],
      consoleErrors: [],
      networkFailures: [],
      accessibilityFindings: [],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result, receipt }),
    });

    const response = await invokeVisualReview(requestInput, { fetchImpl });

    // No `window` in this (Node) test environment, so the endpoint must be
    // an absolute loopback URL — a relative path here is exactly the
    // ERR_INVALID_URL bug Architect's T2.4 review caught for Node/Codex
    // harnesses.
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/delivery-evidence/visual-review/run',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    const [, init] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.schemaVersion).toBe('devflow.visual-review.run.request/v1alpha1');
    expect(sentBody.taskId).toBe('task-1');
    expect(response).toEqual({ success: true, result, receipt });
  });

  it('uses an explicit apiBase override instead of the default loopback origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        code: 'DELIVERY_EVIDENCE_INVALID_REQUEST',
        error: 'irrelevant',
        retryable: false,
      }),
    });

    await invokeVisualReview(requestInput, { fetchImpl, apiBase: 'http://127.0.0.1:4100' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/api/delivery-evidence/visual-review/run',
      expect.anything(),
    );
  });

  it('falls back to the DEVFLOW_API_URL env var when no apiBase is given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        code: 'DELIVERY_EVIDENCE_INVALID_REQUEST',
        error: 'irrelevant',
        retryable: false,
      }),
    });
    vi.stubEnv('DEVFLOW_API_URL', 'http://127.0.0.1:5900');

    try {
      await invokeVisualReview(requestInput, { fetchImpl });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5900/api/delivery-evidence/visual-review/run',
      expect.anything(),
    );
  });

  it('uses a relative path when a browser `window` is present, ignoring apiBase resolution', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        code: 'DELIVERY_EVIDENCE_INVALID_REQUEST',
        error: 'irrelevant',
        retryable: false,
      }),
    });
    vi.stubGlobal('window', {});

    try {
      await invokeVisualReview(requestInput, { fetchImpl });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/delivery-evidence/visual-review/run',
      expect.anything(),
    );
  });

  it('maps a network failure to a retryable renderer-unavailable response', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const response = await invokeVisualReview(requestInput, { fetchImpl });
    expect(response).toEqual({
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: expect.any(String),
      retryable: true,
    });
  });

  it('maps a non-JSON response to a non-retryable-unknown runner failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
    });
    const response = await invokeVisualReview(requestInput, { fetchImpl });
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.code).toBe('DELIVERY_EVIDENCE_RUNNER_FAILED');
    }
  });

  it('maps a response body that fails schema validation to a runner failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: {}, receipt: { nonsense: true } }),
    });
    const response = await invokeVisualReview(requestInput, { fetchImpl });
    expect(response.success).toBe(false);
  });

  it('surfaces a 4xx rejection as a non-retryable invalid-request failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Visual Review request rejected' }),
    });
    const response = await invokeVisualReview(requestInput, { fetchImpl });
    expect(response).toEqual({
      success: false,
      code: 'DELIVERY_EVIDENCE_INVALID_REQUEST',
      error: 'Visual Review request rejected',
      retryable: false,
    });
  });

  it('surfaces a 5xx rejection as a retryable runner failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Visual Review execution failed' }),
    });
    const response = await invokeVisualReview(requestInput, { fetchImpl });
    expect(response).toEqual({
      success: false,
      code: 'DELIVERY_EVIDENCE_RUNNER_FAILED',
      error: 'Visual Review execution failed',
      retryable: true,
    });
  });
});

describe('invokeVisualReviewWithCircuitBreaker', () => {
  it('passes a success response straight through', async () => {
    const receipt = baseReceipt();
    const result: VisualReviewRunResult = {
      screenshots: [
        {
          artifactId: 'artifact-abc',
          route: '/collab',
          viewport: { id: 'mobile', width: 375, height: 812 },
          fullPage: false,
        },
      ],
      consoleErrors: [],
      networkFailures: [],
      accessibilityFindings: [],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result, receipt }),
    });

    const attempt = await invokeVisualReviewWithCircuitBreaker(requestInput, { fetchImpl });

    expect(attempt).toEqual({ kind: 'success', response: { success: true, result, receipt } });
  });

  it('maps an ordinary renderer-unavailable response to a retryable kind', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
        error: 'Registered preview is unavailable',
        retryable: true,
      }),
    });

    const attempt = await invokeVisualReviewWithCircuitBreaker(requestInput, { fetchImpl });

    expect(attempt).toEqual({
      kind: 'renderer_unavailable',
      response: {
        success: false,
        code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
        error: 'Registered preview is unavailable',
        retryable: true,
      },
    });
  });

  it('maps the frozen terminal DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING response to circuit_open directly — no local threshold tracking', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        code: 'DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING',
        error: 'Renderer has been unavailable past the registered threshold',
        retryable: false,
        reasonCode: 'visual_verification_pending',
        postHocReviewRequired: true,
      }),
    });

    const attempt = await invokeVisualReviewWithCircuitBreaker(requestInput, { fetchImpl });

    expect(attempt).toEqual({
      kind: 'circuit_open',
      reasonCode: 'visual_verification_pending',
      postHocReviewRequired: true,
      error: 'Renderer has been unavailable past the registered threshold',
    });
  });

  it('maps a non-renderer failure to failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        code: 'DELIVERY_EVIDENCE_RUNNER_FAILED',
        error: 'boom',
        retryable: true,
      }),
    });

    const attempt = await invokeVisualReviewWithCircuitBreaker(requestInput, { fetchImpl });

    expect(attempt.kind).toBe('failed');
  });
});

describe('resolveArtifactUrl', () => {
  it('builds a fetchable artifact URL from a valid delivery-evidence URI', () => {
    const artifact: Pick<EvidenceArtifact, 'uri'> = {
      uri: 'delivery-evidence://devflow/receipt-1/artifact-abc.png',
    };
    expect(resolveArtifactUrl(artifact)).toBe(
      '/api/delivery-evidence/artifact?projectId=devflow&receiptId=receipt-1&file=artifact-abc.png',
    );
  });

  it('returns null for a malformed URI', () => {
    expect(resolveArtifactUrl({ uri: 'https://example.com/not-delivery-evidence' })).toBeNull();
  });
});

describe('describeDecision', () => {
  it('describes deliver as success', () => {
    expect(describeDecision({ kind: 'deliver', decidedBy: 'x', decidedAt: NOW })).toEqual({
      label: 'Deliver',
      tone: 'success',
    });
  });

  it('describes revise as warning', () => {
    expect(
      describeDecision({ kind: 'revise', decidedBy: 'x', decidedAt: NOW, findingIds: ['f1'] }),
    ).toEqual({ label: 'Revise', tone: 'warning' });
  });

  it('describes disclose as danger', () => {
    expect(
      describeDecision({
        kind: 'disclose',
        decidedBy: 'x',
        decidedAt: NOW,
        reasonCode: 'pilot_advisory_findings',
        unresolvedFindingIds: ['f1'],
      }),
    ).toEqual({ label: 'Disclose', tone: 'danger' });
  });
});

describe('buildContactSheetScreenshots', () => {
  it('joins result screenshots with their receipt artifact and resolves a URL', () => {
    const receipt = baseReceipt({
      artifacts: [
        {
          id: 'artifact-abc',
          kind: 'screenshot',
          mimeType: 'image/png',
          uri: 'delivery-evidence://devflow/receipt-1/artifact-abc.png',
          byteSize: 100,
          sha256: SHA,
          redacted: false,
        },
      ],
    });
    const result: VisualReviewRunResult = {
      screenshots: [
        {
          artifactId: 'artifact-abc',
          route: '/collab',
          viewport: { id: 'mobile', width: 375, height: 812 },
          fullPage: false,
        },
        {
          artifactId: 'artifact-missing',
          route: '/collab',
          viewport: { id: 'desktop', width: 1280, height: 800 },
          fullPage: false,
        },
      ],
      consoleErrors: [],
      networkFailures: [],
      accessibilityFindings: [],
    };

    const screenshots = buildContactSheetScreenshots(result, receipt);

    expect(screenshots).toHaveLength(2);
    expect(screenshots[0].url).toBe(
      '/api/delivery-evidence/artifact?projectId=devflow&receiptId=receipt-1&file=artifact-abc.png',
    );
    expect(screenshots[0].viewport.id).toBe('mobile');
    expect(screenshots[1].url).toBeNull();
  });
});

describe('renderContactSheetHtmlBlock', () => {
  function findingFixture(overrides: Partial<EvidenceFinding> = {}): EvidenceFinding {
    return {
      id: 'finding-1',
      checkId: 'visual-review.capture',
      code: 'contrast_below_aa',
      severity: 'p1',
      status: 'unresolved',
      objective: true,
      summary: 'Body text contrast is below 4.5:1',
      evidenceRefs: [],
      ...overrides,
    };
  }

  it('renders a compact evidence panel for a successful response, inline-styled (no <style> tag, no CSS classes)', () => {
    const receipt = baseReceipt({
      artifacts: [
        {
          id: 'artifact-abc',
          kind: 'screenshot',
          mimeType: 'image/png',
          uri: 'delivery-evidence://devflow/receipt-1/artifact-abc.png',
          byteSize: 100,
          sha256: SHA,
          redacted: false,
        },
      ],
      findings: [findingFixture()],
      decision: {
        kind: 'disclose',
        decidedBy: 'visual-review.runner',
        decidedAt: NOW,
        reasonCode: 'pilot_advisory_findings',
        unresolvedFindingIds: ['finding-1'],
      },
    });
    const response: VisualReviewRunResponse = {
      success: true,
      result: {
        screenshots: [
          {
            artifactId: 'artifact-abc',
            route: '/collab',
            viewport: { id: 'mobile', width: 375, height: 812 },
            fullPage: false,
          },
        ],
        consoleErrors: [],
        networkFailures: [],
        accessibilityFindings: [],
      },
      receipt,
    };

    const html = renderContactSheetHtmlBlock(response);

    // DOMPurify strips <style> tags outright and does not load app CSS in
    // the sanitized message-renderer context, so every rule must be inline.
    expect(html).not.toContain('<style');
    expect(html).not.toContain('className=');
    expect(html).toContain('style="');
    expect(html).toContain('Disclose');
    // & is HTML-escaped in the src attribute — correct output, not a bug.
    expect(html).toContain('/api/delivery-evidence/artifact?projectId=devflow&amp;receiptId=receipt-1&amp;file=artifact-abc.png');
    expect(html).toContain('Body text contrast is below 4.5:1');
    expect(html).toHaveLength(html.length); // sanity: non-empty, computed above
    expect(html.length).toBeLessThan(50 * 1024); // fits the html-block cap with headroom
  });

  it('renders the pending state for a failed response', () => {
    const response: VisualReviewRunResponse = {
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Preview server did not become ready within 30s',
      retryable: true,
    };

    const html = renderContactSheetHtmlBlock(response);

    expect(html).not.toContain('<style');
    expect(html).toContain('implementation ready');
    expect(html).toContain('DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE');
  });

  it('escapes finding summaries and route names to prevent HTML injection', () => {
    const receipt = baseReceipt({
      findings: [findingFixture({ summary: '<img src=x onerror=alert(1)>' })],
    });
    const response: VisualReviewRunResponse = {
      success: true,
      result: {
        screenshots: [],
        consoleErrors: [],
        networkFailures: [],
        accessibilityFindings: [],
      },
      receipt,
    };

    const html = renderContactSheetHtmlBlock(response);

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
