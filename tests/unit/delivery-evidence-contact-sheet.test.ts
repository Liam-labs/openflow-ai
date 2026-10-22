import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ContactSheet } from '@/components/delivery-evidence/ContactSheet';
import type {
  DeliveryEvidenceReceipt,
  EvidenceFinding,
  VisualReviewRunResponse,
} from '@/lib/delivery-evidence/types';

const SHA = 'a'.repeat(64);
const NOW = '2026-08-03T09:00:00.000Z';

function finding(overrides: Partial<EvidenceFinding> = {}): EvidenceFinding {
  return {
    id: `finding-${Math.random().toString(36).slice(2)}`,
    checkId: 'visual-review.capture',
    code: 'contrast_below_aa',
    severity: 'p1',
    status: 'unresolved',
    objective: true,
    summary: 'Body text contrast is below 4.5:1 on the pricing card',
    evidenceRefs: [],
    location: { route: '/collab', viewport: { width: 375, height: 812 } },
    ...overrides,
  };
}

function baseReceipt(overrides: Partial<DeliveryEvidenceReceipt> = {}): DeliveryEvidenceReceipt {
  return {
    schemaVersion: 'devflow.delivery-evidence/v1alpha1',
    id: 'receipt-visual-01',
    taskId: 'task-1',
    projectId: 'devflow',
    createdAt: NOW,
    contract: {
      id: 'contract-visual-pilot',
      fingerprint: SHA,
      delegatedAuthorityPolicyId: 'advisory-pilot-v1',
      verificationPolicyId: 'visual-pilot-v1',
    },
    source: { fingerprint: SHA, changedPaths: ['components/delivery-evidence/ContactSheet.tsx'] },
    adapter: { id: 'visual-review.playwright', version: '1.0.0' },
    verificationProfile: { id: 'devflow-local', version: '1.0.0', fingerprint: SHA },
    environment: { id: 'local-safe', kind: 'local', fixtureProfile: 'safe-demo', secretRefs: [] },
    checks: [
      {
        checkId: 'visual-review.capture',
        runner: { id: 'playwright.visual-review', version: '1.0.0' },
        status: 'failed',
        startedAt: NOW,
        finishedAt: NOW,
        durationMs: 420,
        exitCode: 1,
        counts: { passed: 2, failed: 2, skipped: 0 },
        artifactIds: ['artifact-mobile', 'artifact-desktop'],
        logIds: [],
      },
    ],
    artifacts: [
      {
        id: 'artifact-mobile',
        kind: 'screenshot',
        mimeType: 'image/png',
        uri: 'delivery-evidence://devflow/receipt-visual-01/artifact-mobile.png',
        byteSize: 2048,
        sha256: SHA,
        redacted: false,
      },
      {
        id: 'artifact-desktop',
        kind: 'screenshot',
        mimeType: 'image/png',
        uri: 'delivery-evidence://devflow/receipt-visual-01/artifact-desktop.png',
        byteSize: 4096,
        sha256: SHA,
        redacted: false,
      },
    ],
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
    findings: [
      finding({ id: 'finding-1', severity: 'p1' }),
      finding({ id: 'finding-2', severity: 'p2', code: 'missing_alt_text', summary: 'Hero image has no alt text' }),
      finding({ id: 'finding-3', severity: 'p2', code: 'heading_skip', summary: 'H1 skips to H3' }),
      finding({ id: 'finding-4', severity: 'p3', code: 'network_request_failed', summary: 'HTTP 404 from /api/preview-asset' }),
    ],
    decision: {
      kind: 'disclose',
      decidedBy: 'visual-review.runner',
      decidedAt: NOW,
      reasonCode: 'pilot_advisory_findings',
      unresolvedFindingIds: ['finding-1'],
    },
    ...overrides,
  };
}

describe('ContactSheet', () => {
  it('renders the decision badge, grouped screenshot thumbnails, stats, and a truncated findings list', () => {
    const response: VisualReviewRunResponse = {
      success: true,
      result: {
        screenshots: [
          {
            artifactId: 'artifact-mobile',
            route: '/collab',
            viewport: { id: 'mobile', width: 375, height: 812 },
            fullPage: false,
          },
          {
            artifactId: 'artifact-desktop',
            route: '/collab',
            viewport: { id: 'desktop', width: 1280, height: 800 },
            fullPage: true,
          },
        ],
        consoleErrors: [{ route: '/collab', message: 'TypeError: x is not a function' }],
        networkFailures: [{ route: '/collab', url: '/api/preview-asset', status: 404 }],
        accessibilityFindings: [],
      },
      receipt: baseReceipt(),
    };

    const html = renderToStaticMarkup(React.createElement(ContactSheet, { response }));

    expect(html).toContain('Visual Review');
    expect(html).toContain('dvc-decision--danger');
    expect(html).toContain('>Disclose<');
    expect(html).toContain('/collab');
    expect(html).toContain('mobile 375');
    expect(html).toContain('desktop 1280');
    expect(html).toContain('full page');
    expect(html).toContain('api/delivery-evidence/artifact?projectId=devflow&amp;receiptId=receipt-visual-01&amp;file=artifact-mobile.png');
    expect(html).toContain('1 console error');
    expect(html).toContain('1 network failure');
    // 4 findings, only 3 shown by default + a "show N more" toggle
    expect(html).toContain('Body text contrast is below 4.5:1');
    expect(html).toContain('Show 1 more');
    expect(html).not.toContain('HTTP 404 from /api/preview-asset');
  });

  it('renders a clean state with no findings', () => {
    const response: VisualReviewRunResponse = {
      success: true,
      result: {
        screenshots: [
          {
            artifactId: 'artifact-mobile',
            route: '/collab',
            viewport: { id: 'mobile', width: 375, height: 812 },
            fullPage: false,
          },
        ],
        consoleErrors: [],
        networkFailures: [],
        accessibilityFindings: [],
      },
      receipt: baseReceipt({
        findings: [],
        decision: { kind: 'deliver', decidedBy: 'visual-review.runner', decidedAt: NOW },
      }),
    };

    const html = renderToStaticMarkup(React.createElement(ContactSheet, { response }));

    expect(html).toContain('dvc-decision--success');
    expect(html).toContain('>Deliver<');
    expect(html).toContain('No findings');
    expect(html).toContain('clean');
  });

  it('renders a placeholder tile for a screenshot whose artifact is missing from the receipt', () => {
    const response: VisualReviewRunResponse = {
      success: true,
      result: {
        screenshots: [
          {
            artifactId: 'artifact-not-in-receipt',
            route: '/collab',
            viewport: { id: 'mobile', width: 375, height: 812 },
            fullPage: false,
          },
        ],
        consoleErrors: [],
        networkFailures: [],
        accessibilityFindings: [],
      },
      receipt: baseReceipt({ artifacts: [], findings: [] }),
    };

    const html = renderToStaticMarkup(React.createElement(ContactSheet, { response }));
    expect(html).toContain('dvc-thumb--missing');
    expect(html).toContain('artifact unavailable');
  });

  it('renders the advisory pending state for a failure response instead of throwing', () => {
    const response: VisualReviewRunResponse = {
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Preview server did not become ready within 30s',
      retryable: true,
    };

    const html = renderToStaticMarkup(React.createElement(ContactSheet, { response }));

    expect(html).toContain('Implementation ready; visual verification pending');
    expect(html).toContain('DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE');
    expect(html).toContain('retry once the renderer is available');
  });
});
