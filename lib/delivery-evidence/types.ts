/**
 * Delivery Evidence — frozen Phase 0 contracts.
 *
 * These types are intentionally domain-neutral. Visual Review is the first
 * adapter, not a special receipt format. Runtime validation lives in
 * `schema.ts`; persistence and execution are owned by later sprint tasks.
 */

export type DeliveryEvidenceSchemaVersion = 'devflow.delivery-evidence/v1alpha1';
export type VerificationProfileSchemaVersion = 'devflow.delivery-evidence.profile/v1alpha1';
export type RunnerDescriptorSchemaVersion = 'devflow.delivery-evidence.runner/v1alpha1';

export type EvidenceSeverity = 'p0' | 'p1' | 'p2' | 'p3';
export type EvidenceFindingStatus = 'unresolved' | 'resolved' | 'waived';
export type EvidenceCheckStatus = 'passed' | 'failed' | 'error' | 'skipped';
export type EvidenceArtifactKind =
  | 'screenshot'
  | 'contact_sheet'
  | 'accessibility_tree'
  | 'console_log'
  | 'network_log'
  | 'test_report'
  | 'contract_diff'
  | 'migration_diff'
  | 'other';

export interface EvidenceIdentity {
  id: string;
  version: string;
}

export interface DeliveryContractIdentity {
  id: string;
  fingerprint: string;
  delegatedAuthorityPolicyId: string;
  verificationPolicyId: string;
}

export interface DeliverySourceIdentity {
  fingerprint: string;
  revision?: string;
  changedPaths: string[];
}

export interface VerificationProfileIdentity extends EvidenceIdentity {
  fingerprint: string;
}

export interface EvidenceEnvironmentIdentity {
  id: string;
  kind: 'local' | 'staging';
  fixtureProfile: string;
  /** Environment-variable or server-side profile names only — never values. */
  secretRefs: string[];
}

export interface EvidenceCounts {
  passed: number;
  failed: number;
  skipped: number;
}

export type EvidenceRunnerIdentity = EvidenceIdentity;

export interface EvidenceCheckResult {
  checkId: string;
  runner: EvidenceRunnerIdentity;
  status: EvidenceCheckStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  counts: EvidenceCounts;
  artifactIds: string[];
  logIds: string[];
  errorCode?: string;
}

export interface EvidenceArtifact {
  id: string;
  kind: EvidenceArtifactKind;
  mimeType: string;
  /** Durable DevFlow artifact URI. Inline base64 is deliberately excluded. */
  uri: string;
  byteSize: number;
  sha256: string;
  redacted: boolean;
}

export interface EvidenceLocation {
  route?: string;
  viewport?: { width: number; height: number };
  sourcePath?: string;
  line?: number;
}

export interface EvidenceFinding {
  id: string;
  checkId: string;
  code: string;
  severity: EvidenceSeverity;
  status: EvidenceFindingStatus;
  objective: boolean;
  summary: string;
  evidenceRefs: string[];
  location?: EvidenceLocation;
}

export type EvidenceFreshness =
  | {
      status: 'fresh';
      evaluatedAt: string;
      sourceFingerprint: string;
      verificationProfileFingerprint: string;
    }
  | {
      status: 'stale';
      evaluatedAt: string;
      sourceFingerprint: string;
      verificationProfileFingerprint: string;
      invalidatedAt: string;
      reasonCodes: string[];
    };

export interface EvidenceRedaction {
  status: 'verified' | 'not_required';
  checkedAt: string;
  /** V1 receipts can store references to secrets, never their values. */
  secretRefsOnly: true;
}

export interface EvidenceReviewProvenance {
  mode: 'creator' | 'delegated' | 'deterministic_only';
  reviewerId: string;
  harness: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'grok' | 'other';
  modelId?: string;
  capabilities: {
    vision: boolean;
    imageIngress: 'direct' | 'artifact_path' | 'unavailable';
  };
  /** Empty unless the reviewer truly received and inspected those artifacts. */
  reviewedArtifactIds: string[];
  reviewedAt: string;
}

export type EvidenceDecision =
  | {
      kind: 'deliver';
      decidedBy: string;
      decidedAt: string;
    }
  | {
      kind: 'revise';
      decidedBy: string;
      decidedAt: string;
      findingIds: string[];
    }
  | {
      kind: 'disclose';
      decidedBy: string;
      decidedAt: string;
      reasonCode: string;
      unresolvedFindingIds: string[];
    };

export interface DeliveryEvidenceReceipt {
  schemaVersion: DeliveryEvidenceSchemaVersion;
  id: string;
  taskId: string;
  projectId: string;
  createdAt: string;
  contract: DeliveryContractIdentity;
  source: DeliverySourceIdentity;
  adapter: EvidenceIdentity;
  verificationProfile: VerificationProfileIdentity;
  environment: EvidenceEnvironmentIdentity;
  checks: EvidenceCheckResult[];
  artifacts: EvidenceArtifact[];
  redaction: EvidenceRedaction;
  review: EvidenceReviewProvenance;
  freshness: EvidenceFreshness;
  findings: EvidenceFinding[];
  decision: EvidenceDecision;
}

export interface VerificationPreviewConfig {
  baseUrl: string;
  startRunnerId?: string;
  cleanupRunnerId?: string;
  readiness: {
    path: string;
    timeoutMs: number;
  };
  routes: string[];
  viewports: Array<{
    id: string;
    width: number;
    height: number;
  }>;
}

export interface VerificationFixtureProfile {
  id: string;
  seedRunnerId?: string;
  cleanupRunnerId?: string;
}

export interface VerificationCheckBinding {
  runnerId: string;
  runnerVersion: string;
  enabled: boolean;
  inputProfile?: string;
}

export interface VerificationRiskRule {
  id: string;
  changedPathGlobs: string[];
  capabilities: string[];
  requireCheckIds: string[];
}

export interface VerificationProfile {
  schemaVersion: VerificationProfileSchemaVersion;
  profile: EvidenceIdentity;
  project: {
    id: string;
    root: string;
  };
  preview: VerificationPreviewConfig;
  fixtures: {
    default: string;
    profiles: VerificationFixtureProfile[];
  };
  authProfileRef?: string;
  checks: Record<string, VerificationCheckBinding>;
  riskRules: VerificationRiskRule[];
  policy: {
    mode: 'advisory';
    maxRevisionPasses: number;
    rendererUnavailableAfterMs: number;
  };
}

export interface RegisteredRunnerDescriptor {
  schemaVersion: RunnerDescriptorSchemaVersion;
  id: string;
  version: string;
  /** Resolves through a server-owned allowlist. This is never a path or shell. */
  executor: {
    kind: 'function' | 'command';
    id: string;
  };
  inputSchemaId: string;
  outputSchemaId: string;
  timeoutMs: number;
  cleanup: {
    mode: 'always' | 'on_error';
    executorId: string;
  };
  security: {
    sideEffectMode: 'read_only' | 'project_local_mutation';
    workingDirectory: 'project_root';
    network: 'none' | 'loopback_only' | 'registered_origins';
    allowedSecretRefs: string[];
  };
  limits: {
    maxArtifactBytes: number;
    maxLogBytes: number;
  };
}

export type VisualReviewCheckpoint = 'slice' | 'risk' | 'final';

export interface VisualReviewRunRequest {
  schemaVersion: 'devflow.visual-review.run.request/v1alpha1';
  taskId: string;
  projectId: string;
  projectPath: string;
  contractId: string;
  contractFingerprint: string;
  verificationProfileVersion: string;
  checkpoint: VisualReviewCheckpoint;
  changedPaths: string[];
  routes?: string[];
  viewports?: Array<{ id: string; width: number; height: number }>;
  fixtureProfile?: string;
}

export interface VisualReviewScreenshotArtifact {
  artifactId: string;
  route: string;
  viewport: { id: string; width: number; height: number };
  fullPage: boolean;
}

export interface VisualReviewRunResult {
  screenshots: VisualReviewScreenshotArtifact[];
  consoleErrors: Array<{ route: string; message: string }>;
  networkFailures: Array<{ route: string; url: string; status: number }>;
  accessibilityFindings: EvidenceFinding[];
}

export type VisualReviewRunResponse =
  | {
      success: true;
      result: VisualReviewRunResult;
      receipt: DeliveryEvidenceReceipt;
    }
  | {
      success: false;
      code:
        | 'DELIVERY_EVIDENCE_INVALID_REQUEST'
        | 'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND'
        | 'DELIVERY_EVIDENCE_INVALID_CONFIG'
        | 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE'
        | 'DELIVERY_EVIDENCE_RUNNER_FAILED';
      error: string;
      retryable: boolean;
    }
  | {
      success: false;
      code: 'DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING';
      error: string;
      retryable: false;
      reasonCode: 'visual_verification_pending';
      postHocReviewRequired: true;
    };
