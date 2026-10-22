import {
  parseVisualReviewRunRequest,
  parseVisualReviewRunResponse,
  parseRegisteredRunnerDescriptor,
} from '@/lib/delivery-evidence/schema';
import { registeredDeliveryEvidenceDescriptors } from '@/lib/delivery-evidence/descriptors';
import { runVisualReview } from '@/lib/delivery-evidence/adapters/visual-review';
import { deliveryEvidenceStore } from '@/lib/delivery-evidence/store';
import {
  deliveryEvidenceTelemetry,
  evaluateRendererCircuitBreaker,
  recordVisualReviewRunTelemetry,
  type DeliveryEvidenceTelemetryEvent,
} from '@/lib/delivery-evidence/telemetry';
import type {
  RegisteredRunnerDescriptor,
  VisualReviewRunRequest,
  VisualReviewRunResponse,
} from '@/lib/delivery-evidence/types';

export type DeliveryEvidenceRunnerErrorCode =
  | 'DELIVERY_EVIDENCE_RUNNER_NOT_REGISTERED'
  | 'DELIVERY_EVIDENCE_RUNNER_MISCONFIGURED'
  | 'DELIVERY_EVIDENCE_RUNNER_INVALID_INPUT'
  | 'DELIVERY_EVIDENCE_RUNNER_INVALID_OUTPUT'
  | 'DELIVERY_EVIDENCE_RUNNER_TIMEOUT'
  | 'DELIVERY_EVIDENCE_RUNNER_FAILED';

export class DeliveryEvidenceRunnerError extends Error {
  constructor(
    message: string,
    public readonly code: DeliveryEvidenceRunnerErrorCode,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'DeliveryEvidenceRunnerError';
  }
}

export interface RegisteredRunnerExecutionContext {
  descriptor: RegisteredRunnerDescriptor;
  signal: AbortSignal;
  registerCleanup(callback: () => Promise<void> | void): void;
}

export type RegisteredRunnerExecutor = (
  input: unknown,
  context: RegisteredRunnerExecutionContext,
) => Promise<unknown>;

export type RegisteredRunnerCleanupExecutor = (
  context: RegisteredRunnerExecutionContext,
) => Promise<void>;

type BoundaryValidator = (input: unknown) => unknown;

export interface RegisteredRunnerRegistryOptions {
  descriptors: RegisteredRunnerDescriptor[];
  executors: Record<string, RegisteredRunnerExecutor>;
  cleanupExecutors: Record<string, RegisteredRunnerCleanupExecutor>;
  inputValidators: Record<string, BoundaryValidator>;
  outputValidators: Record<string, BoundaryValidator>;
}

export interface ExecuteRegisteredRunnerInput {
  descriptorId: string;
  descriptorVersion: string;
  input: unknown;
}

function descriptorKey(id: string, version: string): string {
  return `${id}@${version}`;
}

const RENDERER_UNAVAILABLE_TELEMETRY_CODE = 'delivery_evidence_renderer_unavailable';

export function findRendererUnavailableSinceMs(
  events: DeliveryEvidenceTelemetryEvent[],
): number | undefined {
  const runs = events.filter((event) => event.kind === 'run.completed');
  let unavailableSinceMs: number | undefined;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const event = runs[index];
    if (
      event.outcome !== 'error'
      || event.errorCode !== RENDERER_UNAVAILABLE_TELEMETRY_CODE
    ) {
      break;
    }
    const timestampMs = Date.parse(event.timestamp);
    if (!Number.isFinite(timestampMs)) break;
    unavailableSinceMs = timestampMs;
  }
  return unavailableSinceMs;
}

async function applyRendererCircuitBreaker(
  request: VisualReviewRunRequest,
  response: VisualReviewRunResponse,
  nowMs: number,
): Promise<VisualReviewRunResponse> {
  if (response.success || response.code !== 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE') {
    return response;
  }

  try {
    const [resolvedProfile, events] = await Promise.all([
      deliveryEvidenceStore.loadVerificationProfile({
        projectId: request.projectId,
        projectPath: request.projectPath,
        expectedVersion: request.verificationProfileVersion,
      }),
      deliveryEvidenceTelemetry.read({
        projectId: request.projectId,
        taskId: request.taskId,
        limit: 100_000,
      }),
    ]);
    const unavailableSinceMs = findRendererUnavailableSinceMs(events);
    if (unavailableSinceMs === undefined) return response;

    const decision = evaluateRendererCircuitBreaker({
      unavailableSinceMs,
      nowMs,
      thresholdMs: resolvedProfile.profile.policy.rendererUnavailableAfterMs,
    });
    if (decision.action === 'retry') return response;

    return parseVisualReviewRunResponse({
      success: false,
      code: 'DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING',
      error: 'Visual verification is pending after sustained renderer unavailability',
      retryable: decision.retryable,
      reasonCode: decision.reasonCode,
      postHocReviewRequired: decision.postHocReviewRequired,
    });
  } catch {
    // Circuit-breaker persistence is advisory. If durable state cannot be read,
    // preserve the registered renderer-unavailable response instead of
    // inventing a terminal disclosure without evidence of the outage window.
    return response;
  }
}

export function createRegisteredRunnerRegistry(options: RegisteredRunnerRegistryOptions) {
  const descriptors = new Map<string, RegisteredRunnerDescriptor>();
  for (const candidate of options.descriptors) {
    let descriptor: RegisteredRunnerDescriptor;
    try {
      descriptor = parseRegisteredRunnerDescriptor(candidate);
    } catch {
      throw new DeliveryEvidenceRunnerError(
        'Registered runner descriptor is invalid',
        'DELIVERY_EVIDENCE_RUNNER_MISCONFIGURED',
        500,
      );
    }
    const key = descriptorKey(descriptor.id, descriptor.version);
    if (descriptors.has(key)) {
      throw new DeliveryEvidenceRunnerError(
        'Duplicate registered runner descriptor',
        'DELIVERY_EVIDENCE_RUNNER_MISCONFIGURED',
        500,
      );
    }
    if (
      !options.executors[descriptor.executor.id]
      || !options.cleanupExecutors[descriptor.cleanup.executorId]
      || !options.inputValidators[descriptor.inputSchemaId]
      || !options.outputValidators[descriptor.outputSchemaId]
    ) {
      throw new DeliveryEvidenceRunnerError(
        'Registered runner descriptor references an unknown allowlist entry',
        'DELIVERY_EVIDENCE_RUNNER_MISCONFIGURED',
        500,
      );
    }
    descriptors.set(key, descriptor);
  }

  async function execute(request: ExecuteRegisteredRunnerInput): Promise<unknown> {
    const descriptor = descriptors.get(descriptorKey(
      request.descriptorId,
      request.descriptorVersion,
    ));
    if (!descriptor) {
      throw new DeliveryEvidenceRunnerError(
        'Registered runner not found',
        'DELIVERY_EVIDENCE_RUNNER_NOT_REGISTERED',
        404,
      );
    }

    let validatedInput: unknown;
    try {
      validatedInput = options.inputValidators[descriptor.inputSchemaId](request.input);
    } catch {
      throw new DeliveryEvidenceRunnerError(
        'Registered runner input is invalid',
        'DELIVERY_EVIDENCE_RUNNER_INVALID_INPUT',
        400,
      );
    }

    const controller = new AbortController();
    const cleanupCallbacks: Array<() => Promise<void> | void> = [];
    const context: RegisteredRunnerExecutionContext = {
      descriptor,
      signal: controller.signal,
      registerCleanup(callback) {
        cleanupCallbacks.push(callback);
      },
    };
    const executor = options.executors[descriptor.executor.id];
    const cleanupExecutor = options.cleanupExecutors[descriptor.cleanup.executorId];

    let timer: NodeJS.Timeout | undefined;
    let output: unknown;
    let primaryError: DeliveryEvidenceRunnerError | undefined;
    let executionFailed = false;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DeliveryEvidenceRunnerError(
            'Registered runner timed out',
            'DELIVERY_EVIDENCE_RUNNER_TIMEOUT',
            504,
          ));
        }, descriptor.timeoutMs);
      });
      output = await Promise.race([executor(validatedInput, context), timeout]);
      try {
        output = options.outputValidators[descriptor.outputSchemaId](output);
      } catch {
        throw new DeliveryEvidenceRunnerError(
          'Registered runner output is invalid',
          'DELIVERY_EVIDENCE_RUNNER_INVALID_OUTPUT',
          500,
        );
      }

      const serializedBytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
      if (serializedBytes > descriptor.limits.maxLogBytes) {
        throw new DeliveryEvidenceRunnerError(
          'Registered runner output exceeds its configured limit',
          'DELIVERY_EVIDENCE_RUNNER_INVALID_OUTPUT',
          500,
        );
      }
    } catch (error) {
      executionFailed = true;
      primaryError = error instanceof DeliveryEvidenceRunnerError
        ? error
        : new DeliveryEvidenceRunnerError(
            'Registered runner execution failed',
            'DELIVERY_EVIDENCE_RUNNER_FAILED',
            500,
          );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const shouldCleanup = descriptor.cleanup.mode === 'always'
      || (descriptor.cleanup.mode === 'on_error' && executionFailed);
    if (shouldCleanup) {
      try {
        for (const callback of cleanupCallbacks.reverse()) {
          await callback();
        }
        await cleanupExecutor(context);
      } catch {
        if (!primaryError) {
          primaryError = new DeliveryEvidenceRunnerError(
            'Registered runner cleanup failed',
            'DELIVERY_EVIDENCE_RUNNER_FAILED',
            500,
          );
        }
      }
    }

    if (primaryError) throw primaryError;
    return output;
  }

  return {
    execute,
    getDescriptor(id: string, version: string) {
      return descriptors.get(descriptorKey(id, version));
    },
  };
}

const deliveryEvidenceRunnerRegistry = createRegisteredRunnerRegistry({
  descriptors: [...registeredDeliveryEvidenceDescriptors],
  executors: {
    'playwright.visual-review': async (input) => {
      const startedAtMs = Date.now();
      const response = await runVisualReview(input);
      const finishedAtMs = Date.now();
      await recordVisualReviewRunTelemetry({
        request: input,
        response,
        startedAtMs,
        finishedAtMs,
        // The adapter awaits its idempotent session stop in `finally` before
        // returning any frozen response.
        cleanupSucceeded: true,
      }).catch(() => undefined);
      return applyRendererCircuitBreaker(
        parseVisualReviewRunRequest(input),
        response,
        finishedAtMs,
      );
    },
  },
  cleanupExecutors: {
    // The visual adapter owns each browser session and closes it in a `finally`
    // block. The registered cleanup hook remains explicit so future executors
    // cannot omit a lifecycle policy from their descriptor.
    'playwright.session.cleanup': async () => undefined,
  },
  inputValidators: {
    'visual-review.run.request/v1alpha1': parseVisualReviewRunRequest,
  },
  outputValidators: {
    'visual-review.run.response/v1alpha1': parseVisualReviewRunResponse,
  },
});

export async function executeDeliveryEvidenceRunner(
  input: ExecuteRegisteredRunnerInput,
): Promise<unknown> {
  return deliveryEvidenceRunnerRegistry.execute(input);
}
