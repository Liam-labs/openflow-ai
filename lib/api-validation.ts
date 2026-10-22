/**
 * Central API input-validation helper — Sprint Q1 Task 1 (Reynolds, 2026-05-27).
 *
 * Wraps Zod schemas around `request.json()` and `URLSearchParams` so every
 * route can fail-fast at the boundary with HTTP 400 INVALID_FIELD instead of
 * panicking deeper in the route handler (which surfaces as HTTP 500
 * INTERNAL_ERROR with often-empty body).
 *
 * Pre-fix pattern (the bug class this closes):
 *   const body = await request.json();
 *   const trimmed = body.agentId.trim();   // TypeError if agentId is number
 *                                          // → bubbles to 500 INTERNAL_ERROR
 *
 * Post-fix pattern:
 *   const result = await parseJsonBody(request, MyBodySchema);
 *   if (!result.ok) return result.response;   // 400 with details.issues path tree
 *   const { agentId } = result.data;          // typed + validated
 *
 * Reference: docs/spec-q1-api-input-validation.md (Decisions 1-3) and the QA
 * summary at docs/qa-summary-2026-05-25.md Pattern A.
 *
 * Closes (target): 6 critical + ~10 high/medium input-validation findings.
 */

import { NextResponse } from 'next/server';
import { z, type ZodType, type ZodError } from 'zod';
import { errorResponse } from './api-auth';
import type { AgentApiResponse } from './types';

/** Discriminated-union result of a parse attempt. Callers branch on `ok`. */
export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse<AgentApiResponse> };

/** Optional context plumbed through to the error envelope for tracing. */
export interface ParseContext {
  requestId?: string;
  /** Optional human label for the input source (e.g. 'snooze body'). */
  label?: string;
}

/**
 * Render Zod's path tree into the API envelope's `data.issues` array.
 * Each issue: `{ path: string[], message: string, code: string }` — stable
 * shape clients can render directly into form-level error messages.
 */
function formatZodIssues(error: ZodError): Array<Record<string, unknown>> {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Build the 400 INVALID_FIELD response for a schema failure.
 * Kept private so all error paths converge on the same shape.
 */
function makeValidationErrorResponse(
  error: ZodError,
  context?: ParseContext,
): NextResponse<AgentApiResponse> {
  const label = context?.label ?? 'request';
  const issueCount = error.issues.length;
  const summary = issueCount === 1
    ? `Invalid ${label}: ${error.issues[0].message}`
    : `Invalid ${label}: ${issueCount} validation issues`;
  return errorResponse(
    summary,
    'INVALID_FIELD',
    400,
    { issues: formatZodIssues(error) },
    context?.requestId,
  );
}

/**
 * Parse a JSON request body against a Zod schema.
 *
 * Returns `{ ok: true, data }` when the body parses AND matches the schema.
 * Returns `{ ok: false, response }` for ANY of:
 *   - JSON.parse failure (e.g. body is `not-json` or truncated)
 *   - body is `null` (the literal JSON null deserialises to JS null which most
 *     downstream code is not expecting)
 *   - schema validation failure
 *
 * Empty body (`Content-Length: 0`) is treated as JSON `{}` so schemas with
 * all-optional fields can still pass. Callers that need to forbid empty
 * bodies should mark required fields in the schema.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  context?: ParseContext,
): Promise<ParseResult<T>> {
  // Step 1: read the body text. `request.text()` always resolves (returns ''
  // for empty body) so we don't have to disambiguate "missing" vs "throws".
  let raw: string;
  try {
    raw = await request.text();
  } catch (err) {
    return {
      ok: false,
      response: errorResponse(
        `Could not read ${context?.label ?? 'request'} body`,
        'INVALID_FIELD',
        400,
        { reason: err instanceof Error ? err.message : 'unknown read error' },
        context?.requestId,
      ),
    };
  }

  // Step 2: parse JSON. Empty body → {} so all-optional schemas accept it.
  let parsed: unknown;
  if (raw === '' || raw.trim() === '') {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        response: errorResponse(
          `Invalid JSON in ${context?.label ?? 'request body'}`,
          'INVALID_FIELD',
          400,
          { reason: err instanceof Error ? err.message : 'parse error' },
          context?.requestId,
        ),
      };
    }
  }

  // Step 3: explicit null check. JSON.parse('null') returns null; most route
  // handlers dereference body.foo without null-guarding. This is one of the
  // critical 500s in the QA log (drift-alarm null body → 500).
  if (parsed === null) {
    return {
      ok: false,
      response: errorResponse(
        `${context?.label ?? 'Request body'} must be a JSON object, not null`,
        'INVALID_FIELD',
        400,
        undefined,
        context?.requestId,
      ),
    };
  }

  // Step 4: validate against the schema. Zod returns either success/data or
  // failure/error with the path tree.
  const validation = schema.safeParse(parsed);
  if (!validation.success) {
    return {
      ok: false,
      response: makeValidationErrorResponse(validation.error, context),
    };
  }

  return { ok: true, data: validation.data };
}

/**
 * Parse query parameters from a Request URL against a Zod schema.
 *
 * Query params are always strings before parsing, so schemas typically use
 * `z.coerce.number()` / `z.coerce.boolean()` for type coercion. Optional
 * params should be `.optional()` (absent param → undefined, not '').
 *
 * Returns the same `ParseResult<T>` shape as parseJsonBody so callers branch
 * identically on `ok`.
 */
export function parseQueryParams<T>(
  request: Request,
  schema: ZodType<T>,
  context?: ParseContext,
): ParseResult<T> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return {
      ok: false,
      response: errorResponse(
        'Invalid request URL',
        'INVALID_FIELD',
        400,
        undefined,
        context?.requestId,
      ),
    };
  }

  // Convert URLSearchParams to a plain object for schema parsing. Repeated
  // params land as the last value (URLSearchParams default); routes that need
  // array params should pull from url.searchParams.getAll directly before
  // passing to a custom schema.
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value;
  }

  const validation = schema.safeParse(params);
  if (!validation.success) {
    return {
      ok: false,
      response: makeValidationErrorResponse(
        validation.error,
        { ...context, label: context?.label ?? 'query parameters' },
      ),
    };
  }
  return { ok: true, data: validation.data };
}

/**
 * Reusable schema refinements for common security-sensitive patterns.
 *
 * Routes touching the filesystem MUST refine their path-like id fields with `noNullByte` AND
 * `safePathSegment` to close the ENAMETOOLONG + null-byte 500s in the QA log.
 *
 * Routes that persist user-supplied keys (snooze agentId) should refine with
 * `noControlChars` AND apply `.max(N)` so the store doesn't accumulate
 * garbage entries forever.
 */
export const refinements = {
  /**
   * Reject strings containing NUL (\x00). Node's fs APIs throw a TypeError
   * on null-byte paths — this turns that into a 400 at the boundary.
   */
  noNullByte: (value: string) => !value.includes('\x00'),

  /**
   * Reject strings containing ANY ASCII control character (NUL through US,
   * plus DEL and CSI). Allows printable chars + regular space — so names like
   * "AM New Website" pass but `tab\there` / `line1\nline2` are rejected.
   * Closes the QA-log medium where snooze agentId accepted newlines/tabs.
   */
  noControlChars: (value: string) => !/[\x00-\x1f\x7f\x9b]/.test(value),

  /**
   * Reject filesystem path components that contain `..`, `/`, `\`, or null
   * bytes. Use on any input that will be joined into a filesystem path.
   * NOTE: this is component-level — for full paths use a different rule.
   */
  safePathSegment: (value: string) =>
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\x00'),

  /**
   * Reject timestamps in the past. `until` fields in scaffolding/snooze
   * silently accepted past timestamps pre-fix; this closes the QA medium.
   * Pass either an ISO timestamp or shorthand-resolved Date.
   */
  notInPast: (value: string | Date) => {
    const t = typeof value === 'string' ? new Date(value).getTime() : value.getTime();
    if (!Number.isFinite(t)) return false;
    return t > Date.now();
  },
} as const;

/**
 * Construct an Error the /api/agent dispatcher routes to HTTP 400 INVALID_FIELD.
 *
 * The dispatcher (`app/api/agent/route.ts:285-318`) honours `statusCode` and
 * `code` fields attached to a thrown Error and routes through `errorResponse`
 * with that status/code. Without them, plain `throw new Error('X is required')`
 * either matches a regex heuristic (some do, e.g. "X is required") or falls to
 * 500 INTERNAL_ERROR (which is what the QA log catches as 500-class bugs).
 *
 * Use this in action handlers (`app/api/agent/actions/*.ts`) whenever you
 * need to reject a request synchronously inside the throw-based contract.
 * In Next.js Route Handlers (App Router), prefer parseJsonBody +
 * NextResponse directly — those don't throw.
 *
 * Sprint Q1 T4 (Reynolds, 2026-05-27).
 */
export function invalidField(message: string, code: 'INVALID_FIELD' | 'MISSING_FIELD' = 'INVALID_FIELD'): Error {
  const err: Error & { statusCode?: number; code?: string } = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

/**
 * Re-export Zod so route files can `import { z } from '@/lib/api-validation'`
 * without a second import line. Keeps schema declarations terse.
 */
export { z };
