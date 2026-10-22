/**
 * Computer Use — structured error codes (audit task 276bc8cc).
 *
 * Single source of truth for the error taxonomy defined in
 * `.DevData/docs/ComputerUse/error-code-taxonomy.md`. Every Computer Use
 * surface uses these codes; CI grep guards in `tests/unit/computer-use-error-shape-guard.test.ts`
 * fail the build if a code-less response or a bare `throw new Error(...)` slips through.
 *
 * Layered scope: this module lives under `app/api/computer-use/` because the
 * `lib/computer-use*.ts` files are owned by another agent. Once the lib-side
 * `ComputerUseError` class is widened to carry `context` and a matching
 * `toResponse()` method, this file can re-export from there.
 */

/**
 * Stable machine-readable error identifiers — taxonomy §3.2.
 * Defined as a string-literal union so TypeScript catches free-form codes at compile time.
 */
export type ComputerUseErrorCode =
  // Session
  | 'COMPUTER_USE_SESSION_NOT_FOUND'
  | 'COMPUTER_USE_SESSION_CLOSED'
  | 'COMPUTER_USE_SESSION_LOST'
  | 'COMPUTER_USE_SESSION_AT_CAPACITY'
  // Bridge
  | 'COMPUTER_USE_BRIDGE_UNAVAILABLE'
  | 'COMPUTER_USE_BRIDGE_STARTUP_TIMEOUT'
  | 'COMPUTER_USE_BRIDGE_PYTHON_MISSING'
  | 'COMPUTER_USE_BRIDGE_SCRIPT_MISSING'
  | 'COMPUTER_USE_BRIDGE_SPAWN_FAILED'
  | 'COMPUTER_USE_BRIDGE_BAD_RESPONSE'
  | 'COMPUTER_USE_BRIDGE_ERROR'
  | 'COMPUTER_USE_BRIDGE_PORT_HELD'
  | 'COMPUTER_USE_TIMEOUT'
  // Headless
  | 'COMPUTER_USE_PLAYWRIGHT_MISSING'
  | 'COMPUTER_USE_HEADLESS_LAUNCH_FAILED'
  | 'COMPUTER_USE_HEADLESS_AT_CAPACITY'
  | 'COMPUTER_USE_HEADLESS_UNSUPPORTED'
  | 'COMPUTER_USE_HEADLESS_ERROR'
  // DOM / refs
  | 'COMPUTER_USE_DOM_REF_NOT_FOUND'
  | 'COMPUTER_USE_DOM_REF_NOT_INTERACTABLE'
  | 'COMPUTER_USE_DOM_SNAPSHOT_FAILED'
  // Grounding
  | 'COMPUTER_USE_GROUNDING_NO_PROVIDER_AVAILABLE'
  | 'COMPUTER_USE_GROUNDING_ELEMENT_NOT_FOUND'
  // Task (AI loop)
  | 'COMPUTER_USE_TASK_NOT_FOUND'
  | 'COMPUTER_USE_TASK_ALREADY_DONE'
  | 'COMPUTER_USE_TASK_DISPATCH_FAILED'
  | 'COMPUTER_USE_TASK_DISPATCHER_UNAVAILABLE'
  | 'COMPUTER_USE_TASK_SPAWN_FAILED'
  | 'COMPUTER_USE_TASK_PROMPT_TOO_LARGE'
  // Launch (audit task 7f854785)
  | 'COMPUTER_USE_LAUNCH_NOT_FOUND'
  | 'COMPUTER_USE_LAUNCH_UWP_NO_ARGS'
  // Validation
  | 'COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING'
  | 'COMPUTER_USE_VALIDATION_FIELD_TYPE'
  | 'COMPUTER_USE_VALIDATION_FIELD_RANGE'
  | 'COMPUTER_USE_UNKNOWN_ACTION'
  // Config
  | 'COMPUTER_USE_DISABLED'
  | 'COMPUTER_USE_TOKEN_MISSING'
  | 'COMPUTER_USE_AUTH_REQUIRED'
  // Internal
  | 'COMPUTER_USE_INTERNAL'
  // Back-compat: callers that still expect the old generic code receive it
  // alongside the new one only via the bridge alias logic — never raw-emitted.
  | 'COMPUTER_USE_INVALID_PARAMS';

/**
 * HTTP status mapping — taxonomy §3.2. Source of truth for handlers and tests.
 */
export const ERROR_CODE_HTTP_STATUS: Record<ComputerUseErrorCode, number> = {
  COMPUTER_USE_SESSION_NOT_FOUND: 404,
  COMPUTER_USE_SESSION_CLOSED: 400,
  COMPUTER_USE_SESSION_LOST: 410,
  COMPUTER_USE_SESSION_AT_CAPACITY: 429,
  COMPUTER_USE_BRIDGE_UNAVAILABLE: 503,
  COMPUTER_USE_BRIDGE_STARTUP_TIMEOUT: 503,
  COMPUTER_USE_BRIDGE_PYTHON_MISSING: 501,
  COMPUTER_USE_BRIDGE_SCRIPT_MISSING: 500,
  COMPUTER_USE_BRIDGE_SPAWN_FAILED: 500,
  COMPUTER_USE_BRIDGE_BAD_RESPONSE: 502,
  COMPUTER_USE_BRIDGE_ERROR: 500,
  COMPUTER_USE_BRIDGE_PORT_HELD: 503,
  COMPUTER_USE_TIMEOUT: 504,
  COMPUTER_USE_PLAYWRIGHT_MISSING: 501,
  COMPUTER_USE_HEADLESS_LAUNCH_FAILED: 500,
  COMPUTER_USE_HEADLESS_AT_CAPACITY: 429,
  COMPUTER_USE_HEADLESS_UNSUPPORTED: 400,
  COMPUTER_USE_HEADLESS_ERROR: 500,
  COMPUTER_USE_DOM_REF_NOT_FOUND: 404,
  COMPUTER_USE_DOM_REF_NOT_INTERACTABLE: 400,
  COMPUTER_USE_DOM_SNAPSHOT_FAILED: 502,
  COMPUTER_USE_GROUNDING_NO_PROVIDER_AVAILABLE: 503,
  COMPUTER_USE_GROUNDING_ELEMENT_NOT_FOUND: 404,
  COMPUTER_USE_TASK_NOT_FOUND: 404,
  COMPUTER_USE_TASK_ALREADY_DONE: 400,
  COMPUTER_USE_TASK_DISPATCH_FAILED: 502,
  COMPUTER_USE_TASK_DISPATCHER_UNAVAILABLE: 503,
  COMPUTER_USE_TASK_SPAWN_FAILED: 500,
  COMPUTER_USE_TASK_PROMPT_TOO_LARGE: 413,
  COMPUTER_USE_LAUNCH_NOT_FOUND: 404,
  COMPUTER_USE_LAUNCH_UWP_NO_ARGS: 400,
  COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING: 400,
  COMPUTER_USE_VALIDATION_FIELD_TYPE: 400,
  COMPUTER_USE_VALIDATION_FIELD_RANGE: 400,
  COMPUTER_USE_UNKNOWN_ACTION: 400,
  COMPUTER_USE_DISABLED: 403,
  COMPUTER_USE_TOKEN_MISSING: 500,
  COMPUTER_USE_AUTH_REQUIRED: 401,
  COMPUTER_USE_INTERNAL: 500,
  COMPUTER_USE_INVALID_PARAMS: 400,
};

/**
 * Structured error context — taxonomy §4. Optional fields populated when knowable.
 */
export interface ComputerUseErrorContext {
  sessionId?: string;
  action?: string;
  bridgeUrl?: string;
  taskId?: string;
  terminalTaskId?: string;
  ref?: string;
  elementId?: string;
  field?: string;
  durationMs?: number;
  bridgeDetail?: string;
  logId?: string;
}

/**
 * The error response shape every Computer Use surface returns.
 */
export interface ComputerUseErrorResponse {
  success: false;
  code: ComputerUseErrorCode;
  error: string;
  context?: ComputerUseErrorContext;
}

/**
 * Construct a typed error response. Use this in handlers that return errors;
 * use the `ComputerUseError` class (lib/computer-use.ts) when *throwing*.
 */
export function fail(
  code: ComputerUseErrorCode,
  message: string,
  context?: ComputerUseErrorContext,
): ComputerUseErrorResponse {
  if (context && Object.keys(context).length > 0) {
    return { success: false, code, error: message, context };
  }
  return { success: false, code, error: message };
}

/**
 * Shape predicate — used by tests and handlers that route caught errors.
 */
export function isComputerUseErrorResponse(value: unknown): value is ComputerUseErrorResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.success === false && typeof v.code === 'string' && typeof v.error === 'string';
}

/**
 * Mandatory-context rules from taxonomy §4.1. Returns the list of missing
 * required context fields for a given code, or [] if all rules are satisfied.
 *
 * Used by the contract test suite (§7.3) to assert handlers populate context.
 */
export function missingRequiredContext(
  code: ComputerUseErrorCode,
  context?: ComputerUseErrorContext,
): string[] {
  const ctx = context ?? {};
  const missing: string[] = [];
  if (code.startsWith('COMPUTER_USE_VALIDATION_') && !ctx.field) missing.push('field');
  if (code === 'COMPUTER_USE_INTERNAL' && !ctx.logId) missing.push('logId');
  if (code === 'COMPUTER_USE_TIMEOUT' && ctx.durationMs === undefined) missing.push('durationMs');
  // SESSION_* codes (other than SESSION_AT_CAPACITY) require sessionId
  if (
    (code === 'COMPUTER_USE_SESSION_NOT_FOUND' ||
     code === 'COMPUTER_USE_SESSION_CLOSED' ||
     code === 'COMPUTER_USE_SESSION_LOST') &&
    !ctx.sessionId
  ) {
    missing.push('sessionId');
  }
  return missing;
}
