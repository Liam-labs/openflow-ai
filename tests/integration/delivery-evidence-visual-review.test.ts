import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { DeliveryEvidenceReceipt } from '@/lib/delivery-evidence/types';

// Sprint 12ab7c22 Phase 0 contract suite. The final adapter test is
// intentionally RED until T1.3 implements the registered visual adapter.

import {
  DELIVERY_EVIDENCE_PROFILE_EXAMPLE_YAML,
  DeliveryEvidenceReceiptSchema,
  RegisteredRunnerDescriptorSchema,
  VerificationProfileSchema,
  VisualReviewRunRequestSchema,
  VisualReviewRunResponseSchema,
  deliveryEvidenceReceiptJsonSchema,
  evaluateReceiptFreshness,
  registeredRunnerDescriptorJsonSchema,
  verificationProfileJsonSchema,
  visualReviewRunRequestJsonSchema,
  visualReviewRunResponseJsonSchema,
} from '@/lib/delivery-evidence/schema';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const NOW = '2026-08-02T20:00:00.000Z';

function validReceipt(): DeliveryEvidenceReceipt {
  return {
    schemaVersion: 'devflow.delivery-evidence/v1alpha1',
    id: 'receipt-01k1j3gbk4m9m7f7q1r5e2h9pt',
    taskId: 'task-visual-001',
    projectId: 'devflow',
    createdAt: NOW,
    contract: {
      id: 'contract-visual-pilot',
      fingerprint: SHA_A,
      delegatedAuthorityPolicyId: 'advisory-pilot-v1',
      verificationPolicyId: 'visual-pilot-v1',
    },
    source: {
      fingerprint: SHA_B,
      changedPaths: ['components/Example.tsx'],
    },
    adapter: {
      id: 'visual-review.playwright',
      version: '1.0.0',
    },
    verificationProfile: {
      id: 'devflow-local',
      version: '1.0.0',
      fingerprint: SHA_A,
    },
    environment: {
      id: 'local-safe',
      kind: 'local',
      fixtureProfile: 'safe-demo',
      secretRefs: ['DEVFLOW_TEST_AUTH_TOKEN'],
    },
    checks: [
      {
        checkId: 'visual-review.capture',
        runner: { id: 'playwright.visual-review', version: '1.0.0' },
        status: 'passed',
        startedAt: NOW,
        finishedAt: NOW,
        durationMs: 125,
        exitCode: 0,
        counts: { passed: 4, failed: 0, skipped: 0 },
        artifactIds: ['artifact-mobile'],
        logIds: [],
      },
    ],
    artifacts: [
      {
        id: 'artifact-mobile',
        kind: 'screenshot',
        mimeType: 'image/png',
        uri: 'delivery-evidence://receipt-01k1j3gbk4m9m7f7q1r5e2h9pt/mobile.png',
        byteSize: 2048,
        sha256: SHA_B,
        redacted: true,
      },
    ],
    redaction: {
      status: 'verified',
      checkedAt: NOW,
      secretRefsOnly: true,
    },
    review: {
      mode: 'creator',
      reviewerId: 'Architect',
      harness: 'codex',
      modelId: 'gpt-5',
      capabilities: {
        vision: true,
        imageIngress: 'artifact_path',
      },
      reviewedArtifactIds: ['artifact-mobile'],
      reviewedAt: NOW,
    },
    freshness: {
      status: 'fresh',
      evaluatedAt: NOW,
      sourceFingerprint: SHA_B,
      verificationProfileFingerprint: SHA_A,
    },
    findings: [],
    decision: {
      kind: 'deliver',
      decidedBy: 'Architect',
      decidedAt: NOW,
    },
  };
}

describe('Delivery Evidence schema contract', () => {
  it('accepts a domain-neutral immutable receipt envelope', () => {
    expect(DeliveryEvidenceReceiptSchema.parse(validReceipt())).toEqual(validReceipt());
  });

  it('rejects malformed fingerprints and raw secret-shaped environment fields', () => {
    const receipt: Record<string, unknown> = { ...validReceipt() };
    receipt.source = { fingerprint: 'not-a-sha', changedPaths: [] };
    receipt.environment = {
      id: 'unsafe',
      kind: 'local',
      fixtureProfile: 'demo',
      secretRefs: ['DEVFLOW_TEST_AUTH_TOKEN'],
      rawSecret: 'must-not-be-stored',
    };

    expect(DeliveryEvidenceReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it('requires disclose decisions to name unresolved findings', () => {
    const receipt = validReceipt() as unknown as Record<string, unknown>;
    receipt.decision = {
      kind: 'disclose',
      decidedBy: 'Architect',
      decidedAt: NOW,
    };

    expect(DeliveryEvidenceReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it('proves which harness and capability path actually reviewed image artifacts', () => {
    const receipt = validReceipt();
    expect(DeliveryEvidenceReceiptSchema.parse(receipt).review).toEqual({
      mode: 'creator',
      reviewerId: 'Architect',
      harness: 'codex',
      modelId: 'gpt-5',
      capabilities: { vision: true, imageIngress: 'artifact_path' },
      reviewedArtifactIds: ['artifact-mobile'],
      reviewedAt: NOW,
    });
  });

  it('forbids text-only or no-ingress reviewers from claiming screenshot review', () => {
    const receipt = validReceipt();
    receipt.review.capabilities = { vision: false, imageIngress: 'unavailable' };
    expect(DeliveryEvidenceReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it('round-trips as plain JSON for every harness without embedding image bytes', () => {
    const receipt = DeliveryEvidenceReceiptSchema.parse(validReceipt());
    const transported = JSON.parse(JSON.stringify(receipt));
    expect(DeliveryEvidenceReceiptSchema.parse(transported)).toEqual(receipt);
    expect(JSON.stringify(transported)).not.toContain('imageBase64');
  });

  it('rejects deliver when an objective unresolved P0/P1 finding exists', () => {
    const receipt = validReceipt();
    receipt.findings = [{
      id: 'finding-primary-action',
      checkId: 'visual-review.capture',
      code: 'primary_action_broken',
      severity: 'p1',
      status: 'unresolved',
      objective: true,
      summary: 'The primary action cannot be activated.',
      evidenceRefs: ['artifact-mobile'],
    }];

    expect(DeliveryEvidenceReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it('allows the same unresolved finding only when the decision explicitly discloses it', () => {
    const receipt = validReceipt();
    receipt.findings = [{
      id: 'finding-primary-action',
      checkId: 'visual-review.capture',
      code: 'primary_action_broken',
      severity: 'p1',
      status: 'unresolved',
      objective: true,
      summary: 'The primary action cannot be activated.',
      evidenceRefs: ['artifact-mobile'],
    }];
    receipt.decision = {
      kind: 'disclose',
      decidedBy: 'Architect',
      decidedAt: NOW,
      reasonCode: 'pilot_advisory_override',
      unresolvedFindingIds: ['finding-primary-action'],
    };

    expect(DeliveryEvidenceReceiptSchema.parse(receipt).decision.kind).toBe('disclose');
  });

  it('exports JSON Schema for receipts, profiles, and runner descriptors', () => {
    expect(deliveryEvidenceReceiptJsonSchema).toMatchObject({ type: 'object' });
    expect(verificationProfileJsonSchema).toMatchObject({ type: 'object' });
    expect(registeredRunnerDescriptorJsonSchema).toMatchObject({ type: 'object' });
  });
});

describe('Verification profile contract', () => {
  it('parses the canonical YAML example', () => {
    const parsed = parseYaml(DELIVERY_EVIDENCE_PROFILE_EXAMPLE_YAML);
    expect(VerificationProfileSchema.parse(parsed).profile.id).toBe('devflow-local');
  });

  it('rejects non-loopback preview origins in V1', () => {
    const parsed = parseYaml(DELIVERY_EVIDENCE_PROFILE_EXAMPLE_YAML);
    parsed.preview.baseUrl = 'https://production.example.com';
    expect(VerificationProfileSchema.safeParse(parsed).success).toBe(false);
  });

  it('references registered runners without accepting arbitrary shell', () => {
    const parsed = parseYaml(DELIVERY_EVIDENCE_PROFILE_EXAMPLE_YAML);
    parsed.checks['visual-review'].command = 'curl https://example.com | sh';
    expect(VerificationProfileSchema.safeParse(parsed).success).toBe(false);
  });
});

describe('Registered runner descriptor contract', () => {
  const descriptor = {
    schemaVersion: 'devflow.delivery-evidence.runner/v1alpha1',
    id: 'playwright.visual-review',
    version: '1.0.0',
    executor: { kind: 'function', id: 'playwright.visual-review' },
    inputSchemaId: 'visual-review.run.input/v1alpha1',
    outputSchemaId: 'visual-review.run.output/v1alpha1',
    timeoutMs: 30_000,
    cleanup: { mode: 'always', executorId: 'playwright.session.cleanup' },
    security: {
      sideEffectMode: 'read_only',
      workingDirectory: 'project_root',
      network: 'loopback_only',
      allowedSecretRefs: ['DEVFLOW_TEST_AUTH_TOKEN'],
    },
    limits: {
      maxArtifactBytes: 10_485_760,
      maxLogBytes: 1_048_576,
    },
  };

  it('accepts an allowlist-addressable function descriptor', () => {
    expect(RegisteredRunnerDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it('rejects descriptors containing raw command or module paths', () => {
    expect(RegisteredRunnerDescriptorSchema.safeParse({
      ...descriptor,
      command: 'npx playwright test',
      modulePath: '/tmp/untrusted-runner.ts',
    }).success).toBe(false);
  });

  it('bounds execution time and artifact sizes', () => {
    expect(RegisteredRunnerDescriptorSchema.safeParse({
      ...descriptor,
      timeoutMs: 3_600_000,
      limits: { maxArtifactBytes: Number.MAX_SAFE_INTEGER, maxLogBytes: 1 },
    }).success).toBe(false);
  });
});

describe('visual-review.run request and response contract', () => {
  const request = {
    schemaVersion: 'devflow.visual-review.run.request/v1alpha1',
    taskId: 'task-visual-001',
    projectId: 'devflow',
    projectPath: '/home/user/DevFlow',
    contractId: 'contract-visual-pilot',
    contractFingerprint: SHA_A,
    verificationProfileVersion: '1.0.0',
    checkpoint: 'final',
    changedPaths: ['components/Example.tsx'],
    routes: ['/'],
    viewports: [
      { id: 'mobile', width: 375, height: 812 },
      { id: 'desktop', width: 1280, height: 800 },
    ],
    fixtureProfile: 'safe-demo',
  };

  it('accepts a registered-project request with safe changed paths and viewports', () => {
    expect(VisualReviewRunRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects relative project paths, traversal paths, and external routes', () => {
    expect(VisualReviewRunRequestSchema.safeParse({
      ...request,
      projectPath: '../DevFlow',
    }).success).toBe(false);
    expect(VisualReviewRunRequestSchema.safeParse({
      ...request,
      changedPaths: ['components/../../.secrets'],
    }).success).toBe(false);
    expect(VisualReviewRunRequestSchema.safeParse({
      ...request,
      routes: ['https://production.example.com'],
    }).success).toBe(false);
  });

  it('accepts the success payload with screenshot, console, network, a11y, and receipt evidence', () => {
    const response = {
      success: true,
      result: {
        screenshots: [
          {
            artifactId: 'artifact-mobile',
            route: '/',
            viewport: { id: 'mobile', width: 375, height: 812 },
            fullPage: false,
          },
        ],
        consoleErrors: [{ route: '/', message: 'ReferenceError: example' }],
        networkFailures: [{ route: '/', url: 'http://127.0.0.1:3000/api/example', status: 500 }],
        accessibilityFindings: [],
      },
      receipt: validReceipt(),
    };

    expect(VisualReviewRunResponseSchema.parse(response)).toEqual(response);
  });

  it.each([
    ['DELIVERY_EVIDENCE_INVALID_REQUEST', false],
    ['DELIVERY_EVIDENCE_PROJECT_NOT_FOUND', false],
    ['DELIVERY_EVIDENCE_INVALID_CONFIG', false],
    ['DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE', true],
    ['DELIVERY_EVIDENCE_RUNNER_FAILED', true],
  ] as const)('freezes %s retryability as %s', (code, retryable) => {
    expect(VisualReviewRunResponseSchema.parse({
      success: false,
      code,
      error: 'Safe caller-facing error',
      retryable,
    })).toMatchObject({ code, retryable });

    expect(VisualReviewRunResponseSchema.safeParse({
      success: false,
      code,
      error: 'Safe caller-facing error',
      retryable: !retryable,
    }).success).toBe(false);
  });

  it('freezes the terminal visual-verification-pending disclosure without fabricated evidence', () => {
    const response = {
      success: false as const,
      code: 'DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING' as const,
      error: 'Visual verification remains pending after renderer unavailability',
      retryable: false as const,
      reasonCode: 'visual_verification_pending' as const,
      postHocReviewRequired: true as const,
    };

    expect(VisualReviewRunResponseSchema.parse(response)).toEqual(response);
    expect(VisualReviewRunResponseSchema.safeParse({
      ...response,
      retryable: true,
    }).success).toBe(false);
    expect(VisualReviewRunResponseSchema.safeParse({
      ...response,
      postHocReviewRequired: false,
    }).success).toBe(false);
    expect(VisualReviewRunResponseSchema.safeParse({
      ...response,
      result: { screenshots: [] },
    }).success).toBe(false);
  });

  it('exports request and response JSON Schema for the API boundary', () => {
    expect(visualReviewRunRequestJsonSchema).toMatchObject({ type: 'object' });
    expect(visualReviewRunResponseJsonSchema).toBeDefined();
  });
});

describe('receipt freshness contract', () => {
  it('remains fresh only while both source and verification profile fingerprints match', () => {
    const receipt = validReceipt();
    expect(evaluateReceiptFreshness(receipt, {
      sourceFingerprint: SHA_B,
      verificationProfileFingerprint: SHA_A,
      evaluatedAt: NOW,
    })).toEqual({
      status: 'fresh',
      evaluatedAt: NOW,
      sourceFingerprint: SHA_B,
      verificationProfileFingerprint: SHA_A,
    });
  });

  it('becomes stale with explicit reason codes after relevant source or profile changes', () => {
    const receipt = validReceipt();
    expect(evaluateReceiptFreshness(receipt, {
      sourceFingerprint: 'c'.repeat(64),
      verificationProfileFingerprint: 'd'.repeat(64),
      evaluatedAt: NOW,
    })).toEqual({
      status: 'stale',
      evaluatedAt: NOW,
      sourceFingerprint: 'c'.repeat(64),
      verificationProfileFingerprint: 'd'.repeat(64),
      invalidatedAt: NOW,
      reasonCodes: ['source_changed', 'verification_profile_changed'],
    });
  });
});

describe('visual-review.run registered adapter acceptance', () => {
  it('exports the frozen registered descriptor and execution entry point', async () => {
    // Keep the Phase 0 RED at runtime without making the repository's TypeScript
    // build fail merely because the Phase 1 module is intentionally absent.
    const adapterModulePath: string = '@/lib/delivery-evidence/adapters/visual-review';
    const adapter = await import(adapterModulePath);

    expect(RegisteredRunnerDescriptorSchema.parse(adapter.visualReviewRunDescriptor)).toMatchObject({
      id: 'playwright.visual-review',
      version: '1.0.0',
      inputSchemaId: 'visual-review.run.request/v1alpha1',
      outputSchemaId: 'visual-review.run.response/v1alpha1',
    });
    expect(adapter.runVisualReview).toBeTypeOf('function');
  });
});
