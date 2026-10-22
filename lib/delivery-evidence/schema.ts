import { z } from 'zod';

import type {
  DeliveryEvidenceReceipt,
  EvidenceFreshness,
  RegisteredRunnerDescriptor,
  VerificationProfile,
  VisualReviewRunRequest,
  VisualReviewRunResponse,
} from './types';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const IdSchema = z.string().min(1).max(200).regex(ID_PATTERN);
const VersionSchema = z.string().regex(SEMVER_PATTERN);
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });
const SecretRefSchema = z.string().regex(SECRET_REF_PATTERN);
const NonNegativeIntSchema = z.number().int().nonnegative();

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function isDurableArtifactUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'delivery-evidence:' || url.protocol === 'file:';
  } catch {
    return false;
  }
}

const SafeRelativePathSchema = z.string().max(1024).refine(isSafeRelativePath, {
  message: 'Expected a safe project-relative POSIX path',
});

const EvidenceIdentitySchema = z.object({
  id: IdSchema,
  version: VersionSchema,
}).strict();

const ContractIdentitySchema = z.object({
  id: IdSchema,
  fingerprint: Sha256Schema,
  delegatedAuthorityPolicyId: IdSchema,
  verificationPolicyId: IdSchema,
}).strict();

const SourceIdentitySchema = z.object({
  fingerprint: Sha256Schema,
  revision: z.string().min(1).max(200).optional(),
  changedPaths: z.array(SafeRelativePathSchema).max(10_000),
}).strict();

const VerificationProfileIdentitySchema = EvidenceIdentitySchema.extend({
  fingerprint: Sha256Schema,
}).strict();

const EnvironmentIdentitySchema = z.object({
  id: IdSchema,
  kind: z.enum(['local', 'staging']),
  fixtureProfile: IdSchema,
  secretRefs: z.array(SecretRefSchema).max(100),
}).strict();

const EvidenceCountsSchema = z.object({
  passed: NonNegativeIntSchema,
  failed: NonNegativeIntSchema,
  skipped: NonNegativeIntSchema,
}).strict();

const EvidenceCheckResultSchema = z.object({
  checkId: IdSchema,
  runner: EvidenceIdentitySchema,
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  durationMs: NonNegativeIntSchema.max(30 * 60 * 1000),
  exitCode: z.number().int().min(-1).max(255).nullable(),
  counts: EvidenceCountsSchema,
  artifactIds: z.array(IdSchema).max(1_000),
  logIds: z.array(IdSchema).max(1_000),
  errorCode: IdSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (new Date(value.finishedAt).getTime() < new Date(value.startedAt).getTime()) {
    ctx.addIssue({
      code: 'custom',
      path: ['finishedAt'],
      message: 'finishedAt must not precede startedAt',
    });
  }
});

const EvidenceArtifactSchema = z.object({
  id: IdSchema,
  kind: z.enum([
    'screenshot',
    'contact_sheet',
    'accessibility_tree',
    'console_log',
    'network_log',
    'test_report',
    'contract_diff',
    'migration_diff',
    'other',
  ]),
  mimeType: z.string().max(200).regex(MIME_PATTERN),
  uri: z.string().max(2_048).refine(isDurableArtifactUri, {
    message: 'Artifact URI must use delivery-evidence: or file:',
  }),
  byteSize: NonNegativeIntSchema.max(100 * 1024 * 1024),
  sha256: Sha256Schema,
  redacted: z.boolean(),
}).strict();

const EvidenceLocationSchema = z.object({
  route: z.string().min(1).max(2_048).optional(),
  viewport: z.object({
    width: z.number().int().min(240).max(7_680),
    height: z.number().int().min(240).max(7_680),
  }).strict().optional(),
  sourcePath: SafeRelativePathSchema.optional(),
  line: z.number().int().positive().optional(),
}).strict();

const EvidenceFindingSchema = z.object({
  id: IdSchema,
  checkId: IdSchema,
  code: IdSchema,
  severity: z.enum(['p0', 'p1', 'p2', 'p3']),
  status: z.enum(['unresolved', 'resolved', 'waived']),
  objective: z.boolean(),
  summary: z.string().min(1).max(1_000),
  evidenceRefs: z.array(IdSchema).max(100),
  location: EvidenceLocationSchema.optional(),
}).strict();

const EvidenceFreshnessSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('fresh'),
    evaluatedAt: TimestampSchema,
    sourceFingerprint: Sha256Schema,
    verificationProfileFingerprint: Sha256Schema,
  }).strict(),
  z.object({
    status: z.literal('stale'),
    evaluatedAt: TimestampSchema,
    sourceFingerprint: Sha256Schema,
    verificationProfileFingerprint: Sha256Schema,
    invalidatedAt: TimestampSchema,
    reasonCodes: z.array(IdSchema).min(1).max(20),
  }).strict(),
]);

const EvidenceRedactionSchema = z.object({
  status: z.enum(['verified', 'not_required']),
  checkedAt: TimestampSchema,
  secretRefsOnly: z.literal(true),
}).strict();

const EvidenceReviewProvenanceSchema = z.object({
  mode: z.enum(['creator', 'delegated', 'deterministic_only']),
  reviewerId: IdSchema,
  harness: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'grok', 'other']),
  modelId: z.string().min(1).max(200).optional(),
  capabilities: z.object({
    vision: z.boolean(),
    imageIngress: z.enum(['direct', 'artifact_path', 'unavailable']),
  }).strict(),
  reviewedArtifactIds: z.array(IdSchema).max(10_000),
  reviewedAt: TimestampSchema,
}).strict().superRefine((review, ctx) => {
  const cannotInspectImages =
    !review.capabilities.vision || review.capabilities.imageIngress === 'unavailable';
  if (cannotInspectImages && review.reviewedArtifactIds.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewedArtifactIds'],
      message: 'A reviewer without vision and image ingress cannot claim image artifact review',
    });
  }
  if (review.mode === 'deterministic_only' && review.reviewedArtifactIds.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewedArtifactIds'],
      message: 'Deterministic-only review cannot claim visual artifact inspection',
    });
  }
});

const EvidenceDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deliver'),
    decidedBy: IdSchema,
    decidedAt: TimestampSchema,
  }).strict(),
  z.object({
    kind: z.literal('revise'),
    decidedBy: IdSchema,
    decidedAt: TimestampSchema,
    findingIds: z.array(IdSchema).min(1).max(1_000),
  }).strict(),
  z.object({
    kind: z.literal('disclose'),
    decidedBy: IdSchema,
    decidedAt: TimestampSchema,
    reasonCode: IdSchema,
    unresolvedFindingIds: z.array(IdSchema).min(1).max(1_000),
  }).strict(),
]);

export const DeliveryEvidenceReceiptSchema = z.object({
  schemaVersion: z.literal('devflow.delivery-evidence/v1alpha1'),
  id: IdSchema,
  taskId: IdSchema,
  projectId: IdSchema,
  createdAt: TimestampSchema,
  contract: ContractIdentitySchema,
  source: SourceIdentitySchema,
  adapter: EvidenceIdentitySchema,
  verificationProfile: VerificationProfileIdentitySchema,
  environment: EnvironmentIdentitySchema,
  checks: z.array(EvidenceCheckResultSchema).min(1).max(1_000),
  artifacts: z.array(EvidenceArtifactSchema).max(10_000),
  redaction: EvidenceRedactionSchema,
  review: EvidenceReviewProvenanceSchema,
  freshness: EvidenceFreshnessSchema,
  findings: z.array(EvidenceFindingSchema).max(10_000),
  decision: EvidenceDecisionSchema,
}).strict().superRefine((receipt, ctx) => {
  const artifactIds = new Set(receipt.artifacts.map((artifact) => artifact.id));
  for (const [checkIndex, check] of receipt.checks.entries()) {
    for (const [artifactIndex, artifactId] of check.artifactIds.entries()) {
      if (!artifactIds.has(artifactId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checks', checkIndex, 'artifactIds', artifactIndex],
          message: `Unknown artifact reference: ${artifactId}`,
        });
      }
    }
  }

  for (const [reviewIndex, artifactId] of receipt.review.reviewedArtifactIds.entries()) {
    if (!artifactIds.has(artifactId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['review', 'reviewedArtifactIds', reviewIndex],
        message: `Unknown reviewed artifact reference: ${artifactId}`,
      });
    }
  }

  const findingsById = new Map(receipt.findings.map((finding) => [finding.id, finding]));
  const decisionFindingIds = receipt.decision.kind === 'revise'
    ? receipt.decision.findingIds
    : receipt.decision.kind === 'disclose'
      ? receipt.decision.unresolvedFindingIds
      : [];

  for (const [index, findingId] of decisionFindingIds.entries()) {
    if (!findingsById.has(findingId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision', receipt.decision.kind === 'revise' ? 'findingIds' : 'unresolvedFindingIds', index],
        message: `Unknown finding reference: ${findingId}`,
      });
    }
  }

  if (receipt.decision.kind === 'deliver') {
    const blocking = receipt.findings.find((finding) =>
      finding.objective &&
      finding.status === 'unresolved' &&
      (finding.severity === 'p0' || finding.severity === 'p1')
    );
    if (blocking) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: `Cannot deliver with unresolved objective ${blocking.severity.toUpperCase()} finding ${blocking.id}`,
      });
    }
  }

  if (receipt.freshness.sourceFingerprint !== receipt.source.fingerprint) {
    ctx.addIssue({
      code: 'custom',
      path: ['freshness', 'sourceFingerprint'],
      message: 'Freshness source fingerprint must match the receipt source fingerprint',
    });
  }
  if (receipt.freshness.verificationProfileFingerprint !== receipt.verificationProfile.fingerprint) {
    ctx.addIssue({
      code: 'custom',
      path: ['freshness', 'verificationProfileFingerprint'],
      message: 'Freshness profile fingerprint must match the receipt profile fingerprint',
    });
  }
});

const ViewportSchema = z.object({
  id: IdSchema,
  width: z.number().int().min(240).max(7_680),
  height: z.number().int().min(240).max(7_680),
}).strict();

const FixtureProfileSchema = z.object({
  id: IdSchema,
  seedRunnerId: IdSchema.optional(),
  cleanupRunnerId: IdSchema.optional(),
}).strict();

const CheckBindingSchema = z.object({
  runnerId: IdSchema,
  runnerVersion: VersionSchema,
  enabled: z.boolean(),
  inputProfile: IdSchema.optional(),
}).strict();

const RiskRuleSchema = z.object({
  id: IdSchema,
  changedPathGlobs: z.array(z.string().min(1).max(500)).max(100),
  capabilities: z.array(IdSchema).max(100),
  requireCheckIds: z.array(IdSchema).min(1).max(100),
}).strict();

export const VerificationProfileSchema = z.object({
  schemaVersion: z.literal('devflow.delivery-evidence.profile/v1alpha1'),
  profile: EvidenceIdentitySchema,
  project: z.object({
    id: IdSchema,
    root: z.literal('.'),
  }).strict(),
  preview: z.object({
    baseUrl: z.string().max(2_048).refine(isLoopbackUrl, {
      message: 'V1 preview baseUrl must be an HTTP(S) loopback origin',
    }),
    startRunnerId: IdSchema.optional(),
    cleanupRunnerId: IdSchema.optional(),
    readiness: z.object({
      path: z.string().startsWith('/').max(2_048),
      timeoutMs: z.number().int().min(250).max(120_000),
    }).strict(),
    routes: z.array(z.string().startsWith('/').max(2_048)).min(1).max(100),
    viewports: z.array(ViewportSchema).min(1).max(20),
  }).strict(),
  fixtures: z.object({
    default: IdSchema,
    profiles: z.array(FixtureProfileSchema).min(1).max(100),
  }).strict(),
  authProfileRef: IdSchema.optional(),
  checks: z.record(IdSchema, CheckBindingSchema).refine(
    (checks) => Object.keys(checks).length > 0,
    'At least one check binding is required',
  ),
  riskRules: z.array(RiskRuleSchema).max(100),
  policy: z.object({
    mode: z.literal('advisory'),
    maxRevisionPasses: z.number().int().min(0).max(2),
    rendererUnavailableAfterMs: z.number().int().min(60_000).max(30 * 60 * 1000),
  }).strict(),
}).strict().superRefine((profile, ctx) => {
  const fixtureIds = new Set(profile.fixtures.profiles.map((fixture) => fixture.id));
  if (!fixtureIds.has(profile.fixtures.default)) {
    ctx.addIssue({
      code: 'custom',
      path: ['fixtures', 'default'],
      message: 'Default fixture must reference a declared fixture profile',
    });
  }
  for (const [ruleIndex, rule] of profile.riskRules.entries()) {
    for (const [checkIndex, checkId] of rule.requireCheckIds.entries()) {
      if (!profile.checks[checkId]) {
        ctx.addIssue({
          code: 'custom',
          path: ['riskRules', ruleIndex, 'requireCheckIds', checkIndex],
          message: `Unknown check binding: ${checkId}`,
        });
      }
    }
  }
});

export const RegisteredRunnerDescriptorSchema = z.object({
  schemaVersion: z.literal('devflow.delivery-evidence.runner/v1alpha1'),
  id: IdSchema,
  version: VersionSchema,
  executor: z.object({
    kind: z.enum(['function', 'command']),
    /** A server registry key — never a file path, executable, or shell string. */
    id: IdSchema,
  }).strict(),
  inputSchemaId: IdSchema,
  outputSchemaId: IdSchema,
  timeoutMs: z.number().int().min(250).max(5 * 60 * 1000),
  cleanup: z.object({
    mode: z.enum(['always', 'on_error']),
    executorId: IdSchema,
  }).strict(),
  security: z.object({
    sideEffectMode: z.enum(['read_only', 'project_local_mutation']),
    workingDirectory: z.literal('project_root'),
    network: z.enum(['none', 'loopback_only', 'registered_origins']),
    allowedSecretRefs: z.array(SecretRefSchema).max(100),
  }).strict(),
  limits: z.object({
    maxArtifactBytes: z.number().int().positive().max(100 * 1024 * 1024),
    maxLogBytes: z.number().int().positive().max(10 * 1024 * 1024),
  }).strict(),
}).strict();

const AbsoluteProjectPathSchema = z.string()
  .min(2)
  .max(4_096)
  .refine((value) => value.startsWith('/') && !value.includes('\0'), {
    message: 'projectPath must be an absolute path without NUL bytes',
  });

const RoutePathSchema = z.string()
  .min(1)
  .max(2_048)
  .refine((value) => value.startsWith('/') && !value.startsWith('//'), {
    message: 'Route must be a project-relative URL path',
  });

export const VisualReviewRunRequestSchema = z.object({
  schemaVersion: z.literal('devflow.visual-review.run.request/v1alpha1'),
  taskId: IdSchema,
  projectId: IdSchema,
  projectPath: AbsoluteProjectPathSchema,
  contractId: IdSchema,
  contractFingerprint: Sha256Schema,
  verificationProfileVersion: VersionSchema,
  checkpoint: z.enum(['slice', 'risk', 'final']),
  changedPaths: z.array(SafeRelativePathSchema).max(10_000),
  routes: z.array(RoutePathSchema).min(1).max(100).optional(),
  viewports: z.array(ViewportSchema).min(1).max(20).optional(),
  fixtureProfile: IdSchema.optional(),
}).strict();

const VisualReviewScreenshotArtifactSchema = z.object({
  artifactId: IdSchema,
  route: RoutePathSchema,
  viewport: ViewportSchema,
  fullPage: z.boolean(),
}).strict();

const VisualReviewRunResultSchema = z.object({
  screenshots: z.array(VisualReviewScreenshotArtifactSchema).min(1).max(1_000),
  consoleErrors: z.array(z.object({
    route: RoutePathSchema,
    message: z.string().min(1).max(20_000),
  }).strict()).max(10_000),
  networkFailures: z.array(z.object({
    route: RoutePathSchema,
    url: z.url(),
    status: z.number().int().min(400).max(599),
  }).strict()).max(10_000),
  accessibilityFindings: z.array(EvidenceFindingSchema).max(10_000),
}).strict();

const VisualReviewErrorResponseSchema = z.discriminatedUnion('code', [
  z.object({
    success: z.literal(false),
    code: z.literal('DELIVERY_EVIDENCE_INVALID_REQUEST'),
    error: z.string().min(1).max(2_000),
    retryable: z.literal(false),
  }).strict(),
  z.object({
    success: z.literal(false),
    code: z.literal('DELIVERY_EVIDENCE_PROJECT_NOT_FOUND'),
    error: z.string().min(1).max(2_000),
    retryable: z.literal(false),
  }).strict(),
  z.object({
    success: z.literal(false),
    code: z.literal('DELIVERY_EVIDENCE_INVALID_CONFIG'),
    error: z.string().min(1).max(2_000),
    retryable: z.literal(false),
  }).strict(),
  z.object({
    success: z.literal(false),
    code: z.literal('DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE'),
    error: z.string().min(1).max(2_000),
    retryable: z.literal(true),
  }).strict(),
  z.object({
    success: z.literal(false),
    code: z.literal('DELIVERY_EVIDENCE_RUNNER_FAILED'),
    error: z.string().min(1).max(2_000),
    retryable: z.literal(true),
  }).strict(),
  z.object({
    success: z.literal(false),
    code: z.literal('DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING'),
    error: z.string().min(1).max(2_000),
    retryable: z.literal(false),
    reasonCode: z.literal('visual_verification_pending'),
    postHocReviewRequired: z.literal(true),
  }).strict(),
]);

export const VisualReviewRunResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    result: VisualReviewRunResultSchema,
    receipt: DeliveryEvidenceReceiptSchema,
  }).strict(),
  VisualReviewErrorResponseSchema,
]);

export function evaluateReceiptFreshness(
  receipt: DeliveryEvidenceReceipt,
  current: {
    sourceFingerprint: string;
    verificationProfileFingerprint: string;
    evaluatedAt: string;
  },
): EvidenceFreshness {
  const currentValues = z.object({
    sourceFingerprint: Sha256Schema,
    verificationProfileFingerprint: Sha256Schema,
    evaluatedAt: TimestampSchema,
  }).strict().parse(current);

  const reasonCodes: string[] = [];
  if (receipt.source.fingerprint !== currentValues.sourceFingerprint) {
    reasonCodes.push('source_changed');
  }
  if (receipt.verificationProfile.fingerprint !== currentValues.verificationProfileFingerprint) {
    reasonCodes.push('verification_profile_changed');
  }

  if (reasonCodes.length === 0) {
    return {
      status: 'fresh',
      evaluatedAt: currentValues.evaluatedAt,
      sourceFingerprint: currentValues.sourceFingerprint,
      verificationProfileFingerprint: currentValues.verificationProfileFingerprint,
    };
  }

  return {
    status: 'stale',
    evaluatedAt: currentValues.evaluatedAt,
    sourceFingerprint: currentValues.sourceFingerprint,
    verificationProfileFingerprint: currentValues.verificationProfileFingerprint,
    invalidatedAt: currentValues.evaluatedAt,
    reasonCodes,
  };
}

export function parseDeliveryEvidenceReceipt(input: unknown): DeliveryEvidenceReceipt {
  return DeliveryEvidenceReceiptSchema.parse(input) as DeliveryEvidenceReceipt;
}

export function parseVerificationProfile(input: unknown): VerificationProfile {
  return VerificationProfileSchema.parse(input) as VerificationProfile;
}

export function parseRegisteredRunnerDescriptor(input: unknown): RegisteredRunnerDescriptor {
  return RegisteredRunnerDescriptorSchema.parse(input) as RegisteredRunnerDescriptor;
}

export function parseVisualReviewRunRequest(input: unknown): VisualReviewRunRequest {
  return VisualReviewRunRequestSchema.parse(input) as VisualReviewRunRequest;
}

export function parseVisualReviewRunResponse(input: unknown): VisualReviewRunResponse {
  return VisualReviewRunResponseSchema.parse(input) as VisualReviewRunResponse;
}

export const deliveryEvidenceReceiptJsonSchema = z.toJSONSchema(
  DeliveryEvidenceReceiptSchema,
  { target: 'draft-2020-12' },
);

export const verificationProfileJsonSchema = z.toJSONSchema(
  VerificationProfileSchema,
  { target: 'draft-2020-12' },
);

export const registeredRunnerDescriptorJsonSchema = z.toJSONSchema(
  RegisteredRunnerDescriptorSchema,
  { target: 'draft-2020-12' },
);

export const visualReviewRunRequestJsonSchema = z.toJSONSchema(
  VisualReviewRunRequestSchema,
  { target: 'draft-2020-12' },
);

export const visualReviewRunResponseJsonSchema = z.toJSONSchema(
  VisualReviewRunResponseSchema,
  { target: 'draft-2020-12' },
);

export const DELIVERY_EVIDENCE_PROFILE_EXAMPLE_YAML = `schemaVersion: devflow.delivery-evidence.profile/v1alpha1
profile:
  id: devflow-local
  version: 1.0.0
project:
  id: devflow
  root: .
preview:
  baseUrl: http://127.0.0.1:3000
  readiness:
    path: /api/health
    timeoutMs: 15000
  routes:
    - /
  viewports:
    - id: mobile
      width: 375
      height: 812
    - id: tablet
      width: 768
      height: 1024
    - id: desktop
      width: 1280
      height: 800
fixtures:
  default: safe-demo
  profiles:
    - id: safe-demo
authProfileRef: devflow-local-test
checks:
  visual-review:
    runnerId: playwright.visual-review
    runnerVersion: 1.0.0
    enabled: true
riskRules:
  - id: visual-surfaces
    changedPathGlobs:
      - components/**
      - app/**/*.tsx
    capabilities:
      - rendered-ui
    requireCheckIds:
      - visual-review
policy:
  mode: advisory
  maxRevisionPasses: 2
  rendererUnavailableAfterMs: 1800000
`;
