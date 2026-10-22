import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as getArtifact } from '@/app/api/delivery-evidence/artifact/route';
import { GET as getProfile } from '@/app/api/delivery-evidence/profile/route';
import { GET as getReceipt, POST as postReceipt } from '@/app/api/delivery-evidence/receipt/route';
import { POST as executeRunner } from '@/app/api/delivery-evidence/runner/execute/route';
import { GET as getTelemetry, POST as postTelemetry } from '@/app/api/delivery-evidence/telemetry/route';
import { POST as runVisualReview } from '@/app/api/delivery-evidence/visual-review/run/route';
import {
  createDeliveryEvidenceStore,
  DeliveryEvidenceStoreError,
} from '@/lib/delivery-evidence/store';
import {
  DeliveryEvidenceRunnerError,
  executeDeliveryEvidenceRunner,
} from '@/lib/delivery-evidence/runner';
import type { DeliveryEvidenceReceipt } from '@/lib/delivery-evidence/types';

const roots: string[] = [];
const SHA = 'a'.repeat(64);
const NOW = '2026-08-03T10:00:00.000Z';

function externalRequest(pathname: string, method: 'GET' | 'POST'): NextRequest {
  return new NextRequest(`http://example.invalid${pathname}`, {
    method,
    headers: {
      'x-forwarded-for': '203.0.113.99',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? '{}' : undefined,
  });
}

function receipt(secretRef = 'DELIVERY_EVIDENCE_TEST_SECRET'): DeliveryEvidenceReceipt {
  return {
    schemaVersion: 'devflow.delivery-evidence/v1alpha1',
    id: 'receipt-security-1',
    taskId: 'task-security-1',
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
    environment: {
      id: 'local-safe',
      kind: 'local',
      fixtureProfile: 'safe-demo',
      secretRefs: [secretRef],
    },
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
    redaction: { status: 'verified', checkedAt: NOW, secretRefsOnly: true },
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
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('Delivery Evidence endpoint authentication', () => {
  it('denies every read and write endpoint before request processing', async () => {
    const responses = await Promise.all([
      getArtifact(externalRequest('/api/delivery-evidence/artifact', 'GET')),
      getProfile(externalRequest('/api/delivery-evidence/profile', 'GET')),
      getReceipt(externalRequest('/api/delivery-evidence/receipt', 'GET')),
      postReceipt(externalRequest('/api/delivery-evidence/receipt', 'POST')),
      executeRunner(externalRequest('/api/delivery-evidence/runner/execute', 'POST')),
      getTelemetry(externalRequest('/api/delivery-evidence/telemetry', 'GET')),
      postTelemetry(externalRequest('/api/delivery-evidence/telemetry', 'POST')),
      runVisualReview(externalRequest('/api/delivery-evidence/visual-review/run', 'POST')),
    ]);

    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(401));
  });
});

describe('Delivery Evidence trust boundaries', () => {
  it('rejects immutable receipt overwrite and unregistered runner execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-security-'));
    roots.push(root);
    const store = createDeliveryEvidenceStore({ rootDir: root });
    const valid = receipt();

    await store.writeReceipt(valid);
    await expect(store.writeReceipt(valid)).rejects.toMatchObject({
      code: 'DELIVERY_EVIDENCE_RECEIPT_EXISTS',
    } satisfies Partial<DeliveryEvidenceStoreError>);
    await expect(executeDeliveryEvidenceRunner({
      descriptorId: 'shell.arbitrary',
      descriptorVersion: '1.0.0',
      input: { command: 'ignored' },
    })).rejects.toMatchObject({
      code: 'DELIVERY_EVIDENCE_RUNNER_NOT_REGISTERED',
    } satisfies Partial<DeliveryEvidenceRunnerError>);
  });

  it('stores secret references but rejects a referenced raw secret inside a receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-security-'));
    roots.push(root);
    const rawSecret = 'test-only-raw-secret-value';
    const store = createDeliveryEvidenceStore({
      rootDir: root,
      resolveSecretReference: (reference) =>
        reference === 'DELIVERY_EVIDENCE_TEST_SECRET' ? rawSecret : undefined,
    });
    const leaked = receipt();
    leaked.findings = [{
      id: 'finding-secret',
      checkId: 'visual-review.capture',
      code: 'console_error',
      severity: 'p2',
      status: 'unresolved',
      objective: true,
      summary: rawSecret,
      evidenceRefs: [],
    }];

    await expect(store.writeReceipt(leaked)).rejects.toMatchObject({
      code: 'DELIVERY_EVIDENCE_INVALID_RECEIPT',
    } satisfies Partial<DeliveryEvidenceStoreError>);

    const referenceOnly = receipt();
    referenceOnly.findings = [{
      id: 'finding-reference',
      checkId: 'visual-review.capture',
      code: 'auth_profile_used',
      severity: 'p3',
      status: 'resolved',
      objective: true,
      summary: 'Used secret reference DELIVERY_EVIDENCE_TEST_SECRET',
      evidenceRefs: [],
    }];
    await expect(store.writeReceipt(referenceOnly)).resolves.toMatchObject({
      environment: { secretRefs: ['DELIVERY_EVIDENCE_TEST_SECRET'] },
    });
  });

  it('rejects a known raw secret even when a forged receipt omits its reference', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-security-'));
    roots.push(root);
    const rawSecret = 'another-test-only-raw-secret';
    const store = createDeliveryEvidenceStore({
      rootDir: root,
      knownSecretValues: () => [rawSecret],
    });
    const forged = receipt();
    forged.environment.secretRefs = [];
    forged.findings = [{
      id: 'finding-forged-secret',
      checkId: 'visual-review.capture',
      code: 'console_error',
      severity: 'p2',
      status: 'unresolved',
      objective: true,
      summary: rawSecret,
      evidenceRefs: [],
    }];

    await expect(store.writeReceipt(forged)).rejects.toMatchObject({
      code: 'DELIVERY_EVIDENCE_INVALID_RECEIPT',
    } satisfies Partial<DeliveryEvidenceStoreError>);
  });
});
