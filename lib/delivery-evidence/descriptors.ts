import { parseRegisteredRunnerDescriptor } from '@/lib/delivery-evidence/schema';
import type { RegisteredRunnerDescriptor } from '@/lib/delivery-evidence/types';

export const visualReviewRunDescriptor: RegisteredRunnerDescriptor =
  parseRegisteredRunnerDescriptor({
    schemaVersion: 'devflow.delivery-evidence.runner/v1alpha1',
    id: 'playwright.visual-review',
    version: '1.0.0',
    executor: {
      kind: 'function',
      id: 'playwright.visual-review',
    },
    inputSchemaId: 'visual-review.run.request/v1alpha1',
    outputSchemaId: 'visual-review.run.response/v1alpha1',
    timeoutMs: 120_000,
    cleanup: {
      mode: 'always',
      executorId: 'playwright.session.cleanup',
    },
    security: {
      sideEffectMode: 'read_only',
      workingDirectory: 'project_root',
      network: 'loopback_only',
      allowedSecretRefs: [],
    },
    limits: {
      maxArtifactBytes: 10 * 1024 * 1024,
      maxLogBytes: 1024 * 1024,
    },
  });

export const registeredDeliveryEvidenceDescriptors = Object.freeze([
  visualReviewRunDescriptor,
]);
