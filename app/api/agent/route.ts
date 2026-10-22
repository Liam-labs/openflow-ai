/**
 * Unified Agent API Endpoint
 *
 * POST /api/agent
 *
 * A single endpoint for all agent operations, using action-based routing.
 * All requests require a valid API token in the Authorization header.
 *
 * Request format:
 * {
 *   "action": "domain.verb",
 *   ...action-specific fields
 * }
 *
 * Response format:
 * {
 *   "success": boolean,
 *   "data"?: unknown,
 *   "error"?: string,
 *   "code"?: ErrorCode,
 *   "timestamp": string,
 *   "requestId"?: string,
 *   "timing"?: number
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  validateApiToken,
  hasPermission,
  errorResponse,
  successResponse,
} from '@/lib/api-auth';
import { getActionHandler, getRequiredScope, listAvailableActions } from './actions';
import type { AgentAuthContext, AgentApiRequest, AgentApiErrorCode } from '@/lib/types';
import { emitApiError } from '@/lib/event-bus';
import { withApiLogging } from '@/lib/api-logger';
import { emitApiEvent } from '@/lib/log-emitter';
import { tracked, withTiming } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

interface ApiError {
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>; // returned as `data` on 4xx (e.g. completion conflict state)
}

/**
 * GET /api/agent - List available actions (for discovery)
 */
export const GET = withTiming('/api/agent', tracked('/api/agent', async (request: NextRequest) => {
  try {
    // Validate token
    const authResult = await validateApiToken(request);

    if (!authResult.valid || !authResult.token) {
      return errorResponse(
        authResult.error || 'Authentication required',
        authResult.code || 'AUTH_MISSING',
        authResult.code === 'RATE_LIMITED' ? 429 : 401
      );
    }

    // Return list of available actions based on token scope
    const actions = listAvailableActions(authResult.token.scope);

    return successResponse({
      scope: authResult.token.scope,
      actions,
      totalActions: actions.length,
    });
  } catch (error) {
    console.error('[api/agent] GET error:', error);
    emitApiError(error, 'api/agent', { severity: 'high', context: { method: 'GET' } });
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      'INTERNAL_ERROR',
      500
    );
  }
}));

/**
 * POST /api/agent - Execute an action
 */
/**
 * If we know which action was being executed, prefix the error message with it
 * so triage can tell `phases.create` from `collab.message` when both throw
 * `participantId is required` (T3.3). Idempotent — won't double-prefix.
 */
function enrichValidationMessage(msg: string, action: string | undefined): string {
  if (!action || !msg) return msg;
  if (msg.startsWith(`[${action}] `)) return msg;
  return `[${action}] ${msg}`;
}

/**
 * Heuristic: messages matching common validation patterns are client errors
 * (400) even when the validator threw a plain Error without a statusCode.
 * Keeps the T3.3 fix small — no need to touch every validator to attach
 * `Object.assign(new Error(...), { statusCode: 400 })`.
 */
const VALIDATION_MESSAGE_PATTERNS: RegExp[] = [
  / is required(?: and .*)?$/i,
  /^Invalid (?:duration|interval|request format|field|action|JSON|task status|sprint status)/i,
  /^Missing (?:or invalid )?/i,
  / must (?:be|not exceed|not be)/i,
  / belongs to .* not /i,             // "phaseId X belongs to sprint Y, not Z"
  / references unknown /i,            // "sprintId references unknown sprint"
  /^Did you mean /i,                  // suggestion-style validation
];
// Map "X not found" / "no such Y" / "Y not registered" → 404 (client error,
// not a 500). Without this, action handlers that throw bare `Error("Task not
// found: ...")` fall through to the catch-all 500 path and get logged as
// CRITICAL. 2026-05-18 fix — stale "Participant not found: system" / "Task
// not found" critical entries were polluting the digest.
const NOT_FOUND_MESSAGE_PATTERNS: RegExp[] = [
  /not found:/i,
  /does not exist/i,
  /no such (channel|participant|agent|task|sprint|phase|project|role)/i,
];

function inferValidationStatusCode(msg: string): number | undefined {
  for (const re of VALIDATION_MESSAGE_PATTERNS) {
    if (re.test(msg)) return 400;
  }
  for (const re of NOT_FOUND_MESSAGE_PATTERNS) {
    if (re.test(msg)) return 404;
  }
  return undefined;
}

async function postHandler(request: NextRequest): Promise<NextResponse> {
  const startTime = Date.now();
  const requestId = randomUUID();
  // Hoisted so the catch block can attribute errors to the action that was
  // being executed (T3.3 — validators like "participantId is required" used
  // to be logged with action='unknown', making triage require a full code grep).
  let resolvedAction: string | undefined;

  try {
    // 1. Validate token
    const authResult = await validateApiToken(request);

    if (!authResult.valid || !authResult.token) {
      const authStatus = authResult.code === 'RATE_LIMITED' ? 429 : 401;
      // Triage-hint metadata: without these, the entry only carried `requestId`,
      // making it impossible to tell whether the failures were a misconfigured
      // local script, a probe from outside, or a stale agent caller. Added 2026-05-19.
      const url = new URL(request.url);
      emitApiEvent({
        action: 'auth.failure',
        status: authStatus,
        durationMs: Date.now() - startTime,
        requestId,
        severity: 'medium',
        summary: `Auth failure: ${authResult.error || 'Authentication required'}`,
        error: authResult.error,
        metadata: {
          path: url.pathname,
          method: request.method,
          userAgent: request.headers.get('user-agent') || undefined,
          origin: request.headers.get('origin') || undefined,
          referer: request.headers.get('referer') || undefined,
          remoteAddr: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
        },
      });
      return errorResponse(
        authResult.error || 'Authentication required',
        authResult.code || 'AUTH_MISSING',
        authStatus,
        undefined,
        requestId
      );
    }

    // 2. Parse request body
    let body: AgentApiRequest;
    try {
      body = await request.json();
    } catch {
      return errorResponse(
        'Invalid JSON in request body',
        'INVALID_FIELD',
        400,
        undefined,
        requestId
      );
    }

    // 3. Validate action field
    const action = body.action;
    if (action && typeof action === 'string') {
      resolvedAction = action;
    }
    if (!action || typeof action !== 'string') {
      return errorResponse(
        'Missing or invalid action field',
        'INVALID_ACTION',
        400,
        { hint: 'Use GET /api/agent to list available actions' },
        requestId
      );
    }

    // 4. Get action handler
    const handler = getActionHandler(action);
    if (!handler) {
      return errorResponse(
        `Unknown action: ${action}`,
        'INVALID_ACTION',
        400,
        { hint: 'Use GET /api/agent to list available actions' },
        requestId
      );
    }

    // 5. Check permission for action
    const requiredScope = getRequiredScope(action);
    if (!hasPermission(authResult.token.scope, requiredScope)) {
      emitApiEvent({
        action: action,
        status: 403,
        durationMs: Date.now() - startTime,
        requestId,
        severity: 'medium',
        summary: `Permission denied: ${action} requires ${requiredScope}`,
        error: 'Insufficient permissions',
      });
      return errorResponse(
        'Insufficient permissions for this action',
        'AUTH_INSUFFICIENT',
        403,
        { required: requiredScope, available: authResult.token.scope },
        requestId
      );
    }

    // 6. Build auth context
    const authContext: AgentAuthContext = {
      tokenId: authResult.token.id,
      tokenName: authResult.token.name,
      scope: authResult.token.scope,
      createdBy: authResult.token.createdBy,
      requestId,
    };

    // 7. Execute action handler
    const result = await handler(body, authContext);

    // 8. Normalise response — propagate inner success:false to outer layer
    const timing = Date.now() - startTime;
    const inner = result as Record<string, unknown> | null | undefined;
    if (inner && typeof inner === 'object' && inner.success === false) {
      const err = (inner.error as string | undefined) ?? 'Action failed';
      const code = (inner.code as string | undefined) ?? 'ACTION_FAILED';
      // Re-wrap as a proper outer error so callers get success:false at the top level
      return NextResponse.json(
        {
          success: false,
          error: err,
          code,
          data: inner,
          timestamp: new Date().toISOString(),
          requestId,
          timing,
        },
        { status: 200 } // keep 200 — it was a valid request, the action itself failed
      );
    }
    return successResponse(result, requestId, timing);

  } catch (error) {
    console.error(`[api/agent] POST error (requestId: ${requestId}):`, error);

    // Check for specific error types
    if (error instanceof SyntaxError) {
      return errorResponse('Invalid request format', 'INVALID_FIELD', 400, undefined, requestId);
    }

    // Prefix the error message with the action name so triage can distinguish
    // `phases.create: participantId is required` from `collab.message: participantId is required`.
    // Mutating the Error in place ensures emitApiError captures the enriched message too.
    if (error instanceof Error && resolvedAction) {
      error.message = enrichValidationMessage(error.message, resolvedAction);
    }

    // Respect statusCode set by action handlers (e.g. 400 for validation, 404 for not found)
    // Fall back to message-pattern inference for plain-Error validators that don't attach one.
    let statusCode = (error as ApiError)?.statusCode;
    const errorCode = (error as ApiError)?.code;
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    if (typeof statusCode !== 'number') {
      const inferred = inferValidationStatusCode(errMsg);
      if (inferred) statusCode = inferred;
    }
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
      // 5xx = server fault → emit error event. 4xx = client fault → skip.
      if (statusCode >= 500) {
        emitApiError(error, 'api/agent', { severity: 'high', requestId, context: { statusCode, action: resolvedAction } });
        emitApiEvent({
          action: resolvedAction || 'unknown',
          status: statusCode,
          durationMs: Date.now() - startTime,
          requestId,
          severity: 'high',
          summary: `Server error ${statusCode}: ${errMsg}`,
          error: errMsg,
        });
      }
      return errorResponse(
        errMsg,
        (errorCode as AgentApiErrorCode | undefined) || (statusCode === 404 ? 'NOT_FOUND' : 'INVALID_FIELD'),
        statusCode,
        (error as ApiError)?.details,
        requestId
      );
    }

    emitApiError(error, 'api/agent', { severity: 'critical', requestId, context: { method: 'POST', action: resolvedAction } });
    emitApiEvent({
      action: resolvedAction || 'unknown',
      status: 500,
      durationMs: Date.now() - startTime,
      requestId,
      severity: 'high',
      summary: `Internal server error: ${errMsg}`,
      error: errMsg,
    });
    return errorResponse(
      errMsg,
      'INTERNAL_ERROR',
      500,
      undefined,
      requestId
    );
  }
}

export const POST = withTiming('/api/agent', withApiLogging(postHandler));
