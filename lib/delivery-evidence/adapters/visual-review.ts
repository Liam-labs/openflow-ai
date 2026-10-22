import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  headlessReviewCapture,
  startHeadlessSession,
  stopHeadlessSession,
  type HeadlessReviewCaptureOptions,
  type HeadlessReviewCaptureResult,
  type StartHeadlessOptions,
} from '@/lib/computer-use-headless';
import { ComputerUseError } from '@/lib/computer-use';
import { visualReviewRunDescriptor } from '@/lib/delivery-evidence/descriptors';
import {
  parseVisualReviewRunRequest,
  parseVisualReviewRunResponse,
} from '@/lib/delivery-evidence/schema';
import {
  deliveryEvidenceStore,
  DeliveryEvidenceStoreError,
  type LoadVerificationProfileInput,
  type ResolvedVerificationProfile,
  type StoredEvidenceArtifact,
  type WriteArtifactInput,
} from '@/lib/delivery-evidence/store';
import type {
  DeliveryEvidenceReceipt,
  EvidenceArtifact,
  EvidenceFinding,
  VerificationProfile,
  VisualReviewRunRequest,
  VisualReviewRunResponse,
  VisualReviewScreenshotArtifact,
} from '@/lib/delivery-evidence/types';

export { visualReviewRunDescriptor };

const RUNNER_ERROR: VisualReviewRunResponse = {
  success: false,
  code: 'DELIVERY_EVIDENCE_RUNNER_FAILED',
  error: 'Visual Review execution failed',
  retryable: true,
};

const RENDERED_READINESS_PROFILES: Record<
  string,
  NonNullable<HeadlessReviewCaptureOptions['renderedReadiness']>
> = {
  'devflow-dashboard-v1': { selector: 'header' },
};

interface VisualReviewStore {
  loadVerificationProfile(input: LoadVerificationProfileInput): Promise<ResolvedVerificationProfile>;
  writeArtifact(input: WriteArtifactInput): Promise<StoredEvidenceArtifact>;
  writeReceipt(input: unknown): Promise<DeliveryEvidenceReceipt>;
}

export interface VisualReviewAdapterDependencies {
  store: VisualReviewStore;
  waitForReadiness(
    baseUrl: string,
    readiness: VerificationProfile['preview']['readiness'],
  ): Promise<void>;
  startHeadlessSession(options: StartHeadlessOptions): Promise<{
    config: { engine: 'chromium'; viewport: { width: number; height: number }; userAgent?: string; startUrl?: string };
  }>;
  stopHeadlessSession(sessionId: string): Promise<void>;
  capture(
    sessionId: string,
    options: HeadlessReviewCaptureOptions,
  ): Promise<HeadlessReviewCaptureResult>;
  computeSourceFingerprint(projectPath: string, changedPaths: string[]): Promise<string>;
  now(): string;
  createId(prefix: string): string;
}

async function defaultWaitForReadiness(
  baseUrl: string,
  readiness: VerificationProfile['preview']['readiness'],
): Promise<void> {
  const deadline = Date.now() + readiness.timeoutMs;
  const target = new URL(readiness.path, baseUrl);
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(2_000, readiness.timeoutMs));
    try {
      const response = await fetch(target, {
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
      if (response.status >= 200 && response.status < 400) return;
    } catch {
      // The preview may still be starting. Retry until the registered deadline.
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('preview unavailable');
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function computeVisualReviewSourceFingerprint(
  projectPath: string,
  changedPaths: string[],
): Promise<string> {
  const canonicalRoot = await fs.realpath(projectPath);
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const relativePath of [...changedPaths].sort()) {
    const candidate = path.resolve(canonicalRoot, relativePath);
    if (!isPathInside(canonicalRoot, candidate)) {
      throw new Error('changed path escapes project root');
    }
    try {
      const canonicalCandidate = await fs.realpath(candidate);
      if (!isPathInside(canonicalRoot, canonicalCandidate)) {
        throw new Error('changed path symlink escapes project root');
      }
      const data = await fs.readFile(canonicalCandidate);
      entries.push({
        path: relativePath,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries.push({ path: relativePath, sha256: 'missing' });
    }
  }
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

const defaultDependencies: VisualReviewAdapterDependencies = {
  store: deliveryEvidenceStore,
  waitForReadiness: defaultWaitForReadiness,
  startHeadlessSession,
  stopHeadlessSession,
  capture: headlessReviewCapture,
  computeSourceFingerprint: computeVisualReviewSourceFingerprint,
  now: () => new Date().toISOString(),
  createId: (prefix) => `${prefix}-${randomUUID()}`,
};

function sanitizeConsoleMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|secret|auth|password)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[REDACTED_JWT]')
    .slice(0, 20_000);
}

function sanitizeNetworkUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'invalid-url';
  }
}

function registeredSelections(
  request: VisualReviewRunRequest,
  profile: VerificationProfile,
): {
  routes: string[];
  viewports: VerificationProfile['preview']['viewports'];
  fixtureProfile: string;
  renderedReadiness?: HeadlessReviewCaptureOptions['renderedReadiness'];
} {
  const binding = Object.values(profile.checks).find((check) =>
    check.enabled
    && check.runnerId === visualReviewRunDescriptor.id
    && check.runnerVersion === visualReviewRunDescriptor.version
  );
  if (!binding) throw new Error('visual runner is not enabled by the registered profile');

  const routes = request.routes ?? profile.preview.routes;
  const registeredRoutes = new Set(profile.preview.routes);
  if (routes.some((route) => !registeredRoutes.has(route))) {
    throw new Error('requested route is not registered');
  }

  const viewports = request.viewports ?? profile.preview.viewports;
  const registeredViewports = new Set(
    profile.preview.viewports.map((viewport) => `${viewport.id}:${viewport.width}x${viewport.height}`),
  );
  if (viewports.some((viewport) =>
    !registeredViewports.has(`${viewport.id}:${viewport.width}x${viewport.height}`)
  )) {
    throw new Error('requested viewport is not registered');
  }

  const fixtureProfile = request.fixtureProfile ?? profile.fixtures.default;
  if (!profile.fixtures.profiles.some((fixture) => fixture.id === fixtureProfile)) {
    throw new Error('requested fixture profile is not registered');
  }

  const renderedReadiness = binding.inputProfile
    ? RENDERED_READINESS_PROFILES[binding.inputProfile]
    : undefined;
  if (binding.inputProfile && !renderedReadiness) {
    throw new Error('visual runner input profile is not registered');
  }
  return { routes, viewports, fixtureProfile, renderedReadiness };
}

function mapStoreError(error: DeliveryEvidenceStoreError): VisualReviewRunResponse {
  if (error.code === 'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND') {
    return {
      success: false,
      code: 'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND',
      error: 'Registered project not found',
      retryable: false,
    };
  }
  if (error.code === 'DELIVERY_EVIDENCE_INVALID_CONFIG') {
    return {
      success: false,
      code: 'DELIVERY_EVIDENCE_INVALID_CONFIG',
      error: 'Project verification profile is invalid',
      retryable: false,
    };
  }
  return RUNNER_ERROR;
}

function mapExecutionError(error: unknown): VisualReviewRunResponse {
  if (error instanceof DeliveryEvidenceStoreError) return mapStoreError(error);
  if (
    error instanceof ComputerUseError
    && (error.code === 'COMPUTER_USE_PLAYWRIGHT_MISSING'
      || error.code === 'COMPUTER_USE_HEADLESS_LAUNCH_FAILED'
      || error.code === 'COMPUTER_USE_HEADLESS_AT_CAPACITY'
      || error.code === 'COMPUTER_USE_HEADLESS_RENDERED_NOT_READY')
  ) {
    return {
      success: false,
      code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
      error: 'Visual Review renderer is unavailable',
      retryable: true,
    };
  }
  return RUNNER_ERROR;
}

export function createVisualReviewRunner(dependencies: VisualReviewAdapterDependencies) {
  return async function executeVisualReview(input: unknown): Promise<VisualReviewRunResponse> {
    let request: VisualReviewRunRequest;
    try {
      request = parseVisualReviewRunRequest(input);
    } catch {
      return {
        success: false,
        code: 'DELIVERY_EVIDENCE_INVALID_REQUEST',
        error: 'Visual Review request is invalid',
        retryable: false,
      };
    }

    try {
      const resolvedProfile = await dependencies.store.loadVerificationProfile({
        projectId: request.projectId,
        projectPath: request.projectPath,
        expectedVersion: request.verificationProfileVersion,
      });
      const { profile } = resolvedProfile;
      let selection: ReturnType<typeof registeredSelections>;
      try {
        selection = registeredSelections(request, profile);
      } catch {
        return {
          success: false,
          code: 'DELIVERY_EVIDENCE_INVALID_CONFIG',
          error: 'Visual Review request is not allowed by the registered profile',
          retryable: false,
        };
      }

      try {
        await dependencies.waitForReadiness(profile.preview.baseUrl, profile.preview.readiness);
      } catch {
        return {
          success: false,
          code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
          error: 'Registered preview is unavailable',
          retryable: true,
        };
      }

      const startedAt = dependencies.now();
      const startedAtMs = new Date(startedAt).getTime();
      const receiptId = dependencies.createId('receipt');
      const sourceFingerprint = await dependencies.computeSourceFingerprint(
        resolvedProfile.projectPath,
        request.changedPaths,
      );
      const artifacts: EvidenceArtifact[] = [];
      const screenshots: VisualReviewScreenshotArtifact[] = [];
      const accessibilityFindings: EvidenceFinding[] = [];
      const captureFindings: EvidenceFinding[] = [];
      const consoleErrorsByKey = new Map<string, { route: string; message: string }>();
      const networkFailuresByKey = new Map<string, { route: string; url: string; status: number }>();

      async function persistArtifact(
        artifactId: string,
        kind: EvidenceArtifact['kind'],
        mimeType: string,
        extension: WriteArtifactInput['extension'],
        data: Buffer | string,
        redacted: boolean,
      ): Promise<EvidenceArtifact> {
        const stored = await dependencies.store.writeArtifact({
          projectId: request.projectId,
          receiptId,
          artifactId,
          extension,
          data,
        });
        const artifact: EvidenceArtifact = {
          id: artifactId,
          kind,
          mimeType,
          uri: stored.uri,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          redacted,
        };
        artifacts.push(artifact);
        return artifact;
      }

      const fullPageViewport = [...selection.viewports]
        .sort((left, right) => right.width - left.width)[0];

      for (const route of selection.routes) {
        for (const viewport of selection.viewports) {
          const sessionId = dependencies.createId('cu-visual');
          let sessionStarted = false;
          try {
            await dependencies.startHeadlessSession({
              sessionId,
              viewport: { width: viewport.width, height: viewport.height },
            });
            sessionStarted = true;
            const url = new URL(route, profile.preview.baseUrl).toString();
            const capture = await dependencies.capture(sessionId, {
              url,
              timeoutMs: profile.preview.readiness.timeoutMs,
              fullPage: false,
              maxArtifactBytes: visualReviewRunDescriptor.limits.maxArtifactBytes,
              renderedReadiness: selection.renderedReadiness,
            });
            const screenshotId = dependencies.createId('artifact');
            await persistArtifact(
              screenshotId,
              'screenshot',
              'image/png',
              'png',
              capture.screenshot,
              false,
            );
            screenshots.push({ artifactId: screenshotId, route, viewport, fullPage: false });

            const treeId = dependencies.createId('artifact');
            await persistArtifact(
              treeId,
              'accessibility_tree',
              'text/plain',
              'txt',
              capture.accessibilityTree,
              false,
            );

            for (const [index, finding] of capture.accessibilityFindings.entries()) {
              accessibilityFindings.push({
                id: dependencies.createId('finding'),
                checkId: 'visual-review.capture',
                code: finding.code,
                severity: finding.severity,
                status: 'unresolved',
                objective: true,
                summary: `${finding.summary} (${finding.selector})`,
                evidenceRefs: [treeId],
                location: {
                  route,
                  viewport: { width: viewport.width, height: viewport.height },
                },
              });
              if (index >= 9_999) break;
            }
            for (const message of capture.consoleErrors) {
              const sanitized = sanitizeConsoleMessage(message);
              consoleErrorsByKey.set(`${route}\u0000${sanitized}`, { route, message: sanitized });
            }
            for (const failure of capture.networkFailures) {
              const sanitizedUrl = sanitizeNetworkUrl(failure.url);
              networkFailuresByKey.set(`${route}\u0000${sanitizedUrl}\u0000${failure.status}`, {
                route,
                url: sanitizedUrl,
                status: failure.status,
              });
            }

            if (viewport.id === fullPageViewport.id) {
              try {
                const fullPageCapture = await dependencies.capture(sessionId, {
                  url,
                  timeoutMs: profile.preview.readiness.timeoutMs,
                  fullPage: true,
                  maxArtifactBytes: visualReviewRunDescriptor.limits.maxArtifactBytes,
                  renderedReadiness: selection.renderedReadiness,
                });
                const fullPageId = dependencies.createId('artifact');
                await persistArtifact(
                  fullPageId,
                  'screenshot',
                  'image/png',
                  'png',
                  fullPageCapture.screenshot,
                  false,
                );
                screenshots.push({ artifactId: fullPageId, route, viewport, fullPage: true });
              } catch (error) {
                if (
                  !(error instanceof ComputerUseError)
                  || error.code !== 'COMPUTER_USE_HEADLESS_ARTIFACT_TOO_LARGE'
                ) {
                  throw error;
                }
                captureFindings.push({
                  id: dependencies.createId('finding'),
                  checkId: 'visual-review.capture',
                  code: 'full_page_screenshot_truncated',
                  severity: 'p2',
                  status: 'unresolved',
                  objective: true,
                  summary: 'Full-page screenshot exceeded the artifact limit and was omitted',
                  evidenceRefs: [screenshotId],
                  location: {
                    route,
                    viewport: { width: viewport.width, height: viewport.height },
                  },
                });
              }
            }
          } finally {
            if (sessionStarted) await dependencies.stopHeadlessSession(sessionId);
          }
        }
      }

      const consoleErrors = [...consoleErrorsByKey.values()];
      const networkFailures = [...networkFailuresByKey.values()];
      const findings = [...accessibilityFindings, ...captureFindings];
      const logIds: string[] = [];

      if (consoleErrors.length > 0) {
        const consoleLogId = dependencies.createId('artifact');
        await persistArtifact(
          consoleLogId,
          'console_log',
          'application/json',
          'json',
          `${JSON.stringify(consoleErrors, null, 2)}\n`,
          true,
        );
        logIds.push(consoleLogId);
        for (const entry of consoleErrors) {
          findings.push({
            id: dependencies.createId('finding'),
            checkId: 'visual-review.capture',
            code: 'browser_console_error',
            severity: 'p1',
            status: 'unresolved',
            objective: true,
            summary: entry.message,
            evidenceRefs: [consoleLogId],
            location: { route: entry.route },
          });
        }
      }

      if (networkFailures.length > 0) {
        const networkLogId = dependencies.createId('artifact');
        await persistArtifact(
          networkLogId,
          'network_log',
          'application/json',
          'json',
          `${JSON.stringify(networkFailures, null, 2)}\n`,
          true,
        );
        logIds.push(networkLogId);
        for (const entry of networkFailures) {
          findings.push({
            id: dependencies.createId('finding'),
            checkId: 'visual-review.capture',
            code: 'network_request_failed',
            severity: entry.status >= 500 ? 'p1' : 'p2',
            status: 'unresolved',
            objective: true,
            summary: `HTTP ${entry.status} from ${entry.url}`,
            evidenceRefs: [networkLogId],
            location: { route: entry.route },
          });
        }
      }

      const substantiveFindingCount = findings.length;
      const visualReviewPendingFinding: EvidenceFinding = {
        id: dependencies.createId('finding'),
        checkId: 'visual-review.capture',
        code: 'visual_review_pending',
        severity: 'p2',
        status: 'unresolved',
        objective: true,
        summary: 'Implementing-agent visual review is required before delivery',
        evidenceRefs: screenshots.slice(0, 100).map((screenshot) => screenshot.artifactId),
      };
      findings.push(visualReviewPendingFinding);

      const blockingFindingIds = findings
        .filter((finding) => finding.objective && (finding.severity === 'p0' || finding.severity === 'p1'))
        .map((finding) => finding.id);
      const disclosureFindingIds = [
        ...new Set(findings
          .filter((finding) => finding.status === 'unresolved')
          .map((finding) => finding.id)),
      ];
      const checkFailureFindingIds = [
        ...blockingFindingIds,
        ...captureFindings.map((finding) => finding.id),
      ];
      const finishedAt = dependencies.now();
      const receipt: DeliveryEvidenceReceipt = {
        schemaVersion: 'devflow.delivery-evidence/v1alpha1',
        id: receiptId,
        taskId: request.taskId,
        projectId: request.projectId,
        createdAt: finishedAt,
        contract: {
          id: request.contractId,
          fingerprint: request.contractFingerprint,
          delegatedAuthorityPolicyId: 'advisory-pilot-v1',
          verificationPolicyId: 'visual-pilot-v1',
        },
        source: {
          fingerprint: sourceFingerprint,
          changedPaths: request.changedPaths,
        },
        adapter: { id: 'visual-review.playwright', version: '1.0.0' },
        verificationProfile: {
          id: profile.profile.id,
          version: profile.profile.version,
          fingerprint: resolvedProfile.fingerprint,
        },
        environment: {
          id: `local-${profile.profile.id}`,
          kind: 'local',
          fixtureProfile: selection.fixtureProfile,
          secretRefs: [],
        },
        checks: [{
          checkId: 'visual-review.capture',
          runner: { id: visualReviewRunDescriptor.id, version: visualReviewRunDescriptor.version },
          status: checkFailureFindingIds.length > 0 ? 'failed' : 'passed',
          startedAt,
          finishedAt,
          durationMs: Math.max(0, new Date(finishedAt).getTime() - startedAtMs),
          exitCode: checkFailureFindingIds.length > 0 ? 1 : 0,
          counts: {
            passed: screenshots.length,
            failed: findings.length,
            skipped: 0,
          },
          artifactIds: artifacts.map((artifact) => artifact.id),
          logIds,
        }],
        artifacts,
        redaction: {
          status: 'not_required',
          checkedAt: finishedAt,
          secretRefsOnly: true,
        },
        review: {
          mode: 'deterministic_only',
          reviewerId: 'visual-review.runner',
          harness: 'other',
          capabilities: { vision: false, imageIngress: 'unavailable' },
          reviewedArtifactIds: [],
          reviewedAt: finishedAt,
        },
        freshness: {
          status: 'fresh',
          evaluatedAt: finishedAt,
          sourceFingerprint,
          verificationProfileFingerprint: resolvedProfile.fingerprint,
        },
        findings,
        decision: {
          kind: 'disclose',
          decidedBy: 'visual-review.runner',
          decidedAt: finishedAt,
          reasonCode: substantiveFindingCount > 0
            ? 'pilot_advisory_findings'
            : 'visual_review_pending',
          unresolvedFindingIds: disclosureFindingIds,
        },
      };

      const response = parseVisualReviewRunResponse({
        success: true,
        result: {
          screenshots,
          consoleErrors,
          networkFailures,
          accessibilityFindings,
        },
        receipt,
      });
      if (!response.success) return response;
      await dependencies.store.writeReceipt(response.receipt);
      return response;
    } catch (error) {
      return mapExecutionError(error);
    }
  };
}

export const runVisualReview = createVisualReviewRunner(defaultDependencies);
