import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const closeBrowser = vi.hoisted(() => vi.fn(async () => undefined));
const closeContext = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => ({
      isConnected: () => true,
      close: closeBrowser,
      newContext: vi.fn(async () => ({
        close: closeContext,
        newPage: vi.fn(async () => ({})),
      })),
    })),
  },
}));

import { evaluateRendererCircuitBreaker } from '@/lib/delivery-evidence/telemetry';
import { evaluateReceiptFreshness } from '@/lib/delivery-evidence/schema';
import { createDeliveryEvidenceStore } from '@/lib/delivery-evidence/store';
import type { DeliveryEvidenceReceipt } from '@/lib/delivery-evidence/types';
import {
  headlessSessionCount,
  startHeadlessSession,
  stopHeadlessSession,
} from '@/lib/computer-use-headless';

const roots: string[] = [];
const SHA = 'a'.repeat(64);
const NOW = '2026-08-03T10:00:00.000Z';

async function writeProfile(projectPath: string, route: string): Promise<void> {
  await mkdir(path.join(projectPath, '.devflow'), { recursive: true });
  await writeFile(path.join(projectPath, '.devflow', 'delivery-evidence.yaml'), `
schemaVersion: devflow.delivery-evidence.profile/v1alpha1
profile: { id: test-profile, version: 1.0.0 }
project: { id: test-project, root: . }
preview:
  baseUrl: http://127.0.0.1:3000
  readiness: { path: /api/health, timeoutMs: 15000 }
  routes: [${route}]
  viewports: [{ id: desktop, width: 1280, height: 800 }]
fixtures:
  default: safe-demo
  profiles: [{ id: safe-demo }]
checks:
  visual-review: { runnerId: playwright.visual-review, runnerVersion: 1.0.0, enabled: true }
riskRules: []
policy: { mode: advisory, maxRevisionPasses: 2, rendererUnavailableAfterMs: 1800000 }
`, 'utf8');
}

function receipt(profileFingerprint: string): DeliveryEvidenceReceipt {
  return {
    schemaVersion: 'devflow.delivery-evidence/v1alpha1',
    id: 'receipt-lifecycle-1',
    taskId: 'task-lifecycle-1',
    projectId: 'test-project',
    createdAt: NOW,
    contract: {
      id: 'contract-1',
      fingerprint: SHA,
      delegatedAuthorityPolicyId: 'advisory-pilot-v1',
      verificationPolicyId: 'visual-pilot-v1',
    },
    source: { fingerprint: SHA, changedPaths: ['app/page.tsx'] },
    adapter: { id: 'visual-review.playwright', version: '1.0.0' },
    verificationProfile: { id: 'test-profile', version: '1.0.0', fingerprint: profileFingerprint },
    environment: { id: 'local-safe', kind: 'local', fixtureProfile: 'safe-demo', secretRefs: [] },
    checks: [{
      checkId: 'visual-review.capture',
      runner: { id: 'playwright.visual-review', version: '1.0.0' },
      status: 'passed',
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 0,
      exitCode: 0,
      counts: { passed: 1, failed: 0, skipped: 0 },
      artifactIds: [],
      logIds: [],
    }],
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
      verificationProfileFingerprint: profileFingerprint,
    },
    findings: [],
    decision: { kind: 'deliver', decidedBy: 'visual-review.runner', decidedAt: NOW },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('Delivery Evidence lifecycle policy', () => {
  it('has no retained Playwright session through the 30-second idle window', async () => {
    vi.useFakeTimers();
    await startHeadlessSession({ sessionId: 'visual-lifecycle-1' });
    expect(headlessSessionCount()).toBe(1);

    await stopHeadlessSession('visual-lifecycle-1');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(headlessSessionCount()).toBe(0);
    expect(closeContext).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
  });

  it('opens the renderer circuit after 30 minutes and returns a disclosure instead of another retry', () => {
    const unavailableSince = Date.parse('2026-08-03T09:30:00.000Z');
    expect(evaluateRendererCircuitBreaker({
      unavailableSinceMs: unavailableSince,
      nowMs: unavailableSince + 1_799_999,
      thresholdMs: 1_800_000,
    })).toEqual({ action: 'retry', retryable: true, postHocReviewRequired: false });

    expect(evaluateRendererCircuitBreaker({
      unavailableSinceMs: unavailableSince,
      nowMs: unavailableSince + 1_800_000,
      thresholdMs: 1_800_000,
    })).toEqual({
      action: 'disclose',
      retryable: false,
      reasonCode: 'visual_verification_pending',
      postHocReviewRequired: true,
    });
  });

  it('marks an existing receipt stale after the canonical resolved profile changes', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-profile-'));
    roots.push(projectPath);
    await writeProfile(projectPath, '/');
    const store = createDeliveryEvidenceStore({
      rootDir: path.join(projectPath, '.evidence'),
      getProjectById: async () => ({ id: 'test-project', path: projectPath }),
    });
    const before = await store.loadVerificationProfile({ projectId: 'test-project', projectPath });
    const existing = receipt(before.fingerprint);

    await writeProfile(projectPath, '/changed');
    const after = await store.loadVerificationProfile({ projectId: 'test-project', projectPath });
    const freshness = evaluateReceiptFreshness(existing, {
      sourceFingerprint: existing.source.fingerprint,
      verificationProfileFingerprint: after.fingerprint,
      evaluatedAt: '2026-08-03T10:01:00.000Z',
    });

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(freshness).toMatchObject({
      status: 'stale',
      reasonCodes: ['verification_profile_changed'],
    });
  });
});
