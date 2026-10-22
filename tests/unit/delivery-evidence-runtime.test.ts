import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DeliveryEvidenceReceipt,
  RegisteredRunnerDescriptor,
} from '@/lib/delivery-evidence/types';
import {
  createDeliveryEvidenceStore,
  DeliveryEvidenceStoreError,
} from '@/lib/delivery-evidence/store';
import {
  createRegisteredRunnerRegistry,
  DeliveryEvidenceRunnerError,
} from '@/lib/delivery-evidence/runner';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const NOW = '2026-08-03T00:00:00.000Z';

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-'));
  temporaryRoots.push(directory);
  return directory;
}

function validReceipt(projectId = 'test-project'): DeliveryEvidenceReceipt {
  return {
    schemaVersion: 'devflow.delivery-evidence/v1alpha1',
    id: 'receipt-test-001',
    taskId: 'task-test-001',
    projectId,
    createdAt: NOW,
    contract: {
      id: 'contract-test',
      fingerprint: SHA_A,
      delegatedAuthorityPolicyId: 'advisory-pilot-v1',
      verificationPolicyId: 'visual-pilot-v1',
    },
    source: { fingerprint: SHA_B, changedPaths: ['app/page.tsx'] },
    adapter: { id: 'visual-review.playwright', version: '1.0.0' },
    verificationProfile: {
      id: 'test-profile',
      version: '1.0.0',
      fingerprint: SHA_A,
    },
    environment: {
      id: 'local-safe',
      kind: 'local',
      fixtureProfile: 'safe-demo',
      secretRefs: [],
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
      sourceFingerprint: SHA_B,
      verificationProfileFingerprint: SHA_A,
    },
    findings: [],
    decision: { kind: 'deliver', decidedBy: 'visual-review.runner', decidedAt: NOW },
  };
}

async function writeProfile(projectPath: string): Promise<void> {
  await mkdir(path.join(projectPath, '.devflow'), { recursive: true });
  await writeFile(path.join(projectPath, '.devflow', 'delivery-evidence.yaml'), `
schemaVersion: devflow.delivery-evidence.profile/v1alpha1
profile:
  id: test-profile
  version: 1.0.0
project:
  id: test-project
  root: .
preview:
  baseUrl: http://127.0.0.1:3000
  readiness:
    path: /api/health
    timeoutMs: 15000
  routes: [/]
  viewports:
    - { id: desktop, width: 1280, height: 800 }
fixtures:
  default: safe-demo
  profiles:
    - { id: safe-demo }
checks:
  visual-review:
    runnerId: playwright.visual-review
    runnerVersion: 1.0.0
    enabled: true
riskRules: []
policy:
  mode: advisory
  maxRevisionPasses: 2
  rendererUnavailableAfterMs: 1800000
`, 'utf8');
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe('Delivery Evidence receipt and profile persistence', () => {
  it('writes a validated receipt once and rejects immutable overwrite', async () => {
    const rootDir = await temporaryDirectory();
    const store = createDeliveryEvidenceStore({ rootDir });
    const receipt = validReceipt();

    await expect(store.writeReceipt(receipt)).resolves.toEqual(receipt);
    await expect(store.readReceipt(receipt.projectId, receipt.id)).resolves.toEqual(receipt);

    await expect(store.writeReceipt(receipt)).rejects.toMatchObject({
      code: 'DELIVERY_EVIDENCE_RECEIPT_EXISTS',
    } satisfies Partial<DeliveryEvidenceStoreError>);
  });

  it('loads only the matching registered project and hashes the resolved policy floor', async () => {
    const rootDir = await temporaryDirectory();
    const projectPath = await temporaryDirectory();
    await writeProfile(projectPath);

    const projectLookup = vi.fn().mockResolvedValue({ id: 'test-project', path: projectPath });
    const storeV1 = createDeliveryEvidenceStore({
      rootDir,
      getProjectById: projectLookup,
      policyFloorVersion: 'delivery-evidence-floor/v1',
    });
    const storeV2 = createDeliveryEvidenceStore({
      rootDir,
      getProjectById: projectLookup,
      policyFloorVersion: 'delivery-evidence-floor/v2',
    });

    const first = await storeV1.loadVerificationProfile({
      projectId: 'test-project',
      projectPath,
      expectedVersion: '1.0.0',
    });
    const second = await storeV2.loadVerificationProfile({
      projectId: 'test-project',
      projectPath,
      expectedVersion: '1.0.0',
    });

    expect(first.profile.project).toEqual({ id: 'test-project', root: '.' });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);

    await expect(storeV1.loadVerificationProfile({
      projectId: 'test-project',
      projectPath: path.join(projectPath, 'other'),
    })).rejects.toMatchObject({ code: 'DELIVERY_EVIDENCE_PROJECT_NOT_FOUND' });
  });
});

describe('Registered Delivery Evidence runner', () => {
  const descriptor: RegisteredRunnerDescriptor = {
    schemaVersion: 'devflow.delivery-evidence.runner/v1alpha1',
    id: 'test.runner',
    version: '1.0.0',
    executor: { kind: 'function', id: 'test.executor' },
    inputSchemaId: 'test.input/v1',
    outputSchemaId: 'test.output/v1',
    timeoutMs: 1_000,
    cleanup: { mode: 'always', executorId: 'test.cleanup' },
    security: {
      sideEffectMode: 'read_only',
      workingDirectory: 'project_root',
      network: 'none',
      allowedSecretRefs: [],
    },
    limits: { maxArtifactBytes: 1_024, maxLogBytes: 1_024 },
  };

  it('executes only a registered descriptor and validates both boundaries', async () => {
    const executor = vi.fn().mockResolvedValue({ ok: true });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const registry = createRegisteredRunnerRegistry({
      descriptors: [descriptor],
      executors: { 'test.executor': executor },
      cleanupExecutors: { 'test.cleanup': cleanup },
      inputValidators: {
        'test.input/v1': (input) => {
          if (input !== 'allowed') throw new Error('invalid input');
          return input;
        },
      },
      outputValidators: {
        'test.output/v1': (output) => output,
      },
    });

    await expect(registry.execute({
      descriptorId: 'test.runner',
      descriptorVersion: '1.0.0',
      input: 'allowed',
    })).resolves.toEqual({ ok: true });
    expect(executor).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();

    await expect(registry.execute({
      descriptorId: 'unregistered.runner',
      descriptorVersion: '1.0.0',
      input: 'allowed',
    })).rejects.toMatchObject({
      code: 'DELIVERY_EVIDENCE_RUNNER_NOT_REGISTERED',
    } satisfies Partial<DeliveryEvidenceRunnerError>);
  });

  it('runs cleanup after executor failure without exposing the raw error', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const registry = createRegisteredRunnerRegistry({
      descriptors: [descriptor],
      executors: { 'test.executor': vi.fn().mockRejectedValue(new Error('secret raw failure')) },
      cleanupExecutors: { 'test.cleanup': cleanup },
      inputValidators: { 'test.input/v1': (input) => input },
      outputValidators: { 'test.output/v1': (output) => output },
    });

    await expect(registry.execute({
      descriptorId: 'test.runner',
      descriptorVersion: '1.0.0',
      input: {},
    })).rejects.toMatchObject({
      code: 'DELIVERY_EVIDENCE_RUNNER_FAILED',
      message: 'Registered runner execution failed',
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
