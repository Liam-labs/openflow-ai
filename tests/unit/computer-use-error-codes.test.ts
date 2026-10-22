/**
 * Unit tests for the structured error-code helpers (audit task 276bc8cc).
 *
 * Validates the taxonomy invariants from `.DevData/docs/ComputerUse/error-code-taxonomy.md`:
 *   §3.2 — every code maps to a documented HTTP status
 *   §4   — response shape is { success:false, code, error, context? }
 *   §4.1 — mandatory context fields per code class
 */

import { describe, it, expect } from 'vitest';
import {
  fail,
  isComputerUseErrorResponse,
  missingRequiredContext,
  ERROR_CODE_HTTP_STATUS,
  type ComputerUseErrorCode,
} from '@/app/api/computer-use/error-codes';

describe('fail()', () => {
  it('returns the canonical error shape without context when none provided', () => {
    const r = fail('COMPUTER_USE_INVALID_PARAMS', 'sessionId required');
    expect(r).toEqual({
      success: false,
      code: 'COMPUTER_USE_INVALID_PARAMS',
      error: 'sessionId required',
    });
  });

  it('omits the context key when context is an empty object', () => {
    const r = fail('COMPUTER_USE_INVALID_PARAMS', 'msg', {});
    expect(r).not.toHaveProperty('context');
  });

  it('includes context when populated', () => {
    const r = fail('COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING', 'sessionId required', {
      field: 'sessionId',
      action: 'computer-use.click',
    });
    expect(r).toEqual({
      success: false,
      code: 'COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING',
      error: 'sessionId required',
      context: { field: 'sessionId', action: 'computer-use.click' },
    });
  });
});

describe('isComputerUseErrorResponse()', () => {
  it('returns true for a valid error response', () => {
    expect(isComputerUseErrorResponse({
      success: false, code: 'COMPUTER_USE_INTERNAL', error: 'boom',
    })).toBe(true);
  });

  it('returns false for success responses', () => {
    expect(isComputerUseErrorResponse({ success: true, data: 1 })).toBe(false);
  });

  it('returns false for null / undefined / non-object inputs', () => {
    expect(isComputerUseErrorResponse(null)).toBe(false);
    expect(isComputerUseErrorResponse(undefined)).toBe(false);
    expect(isComputerUseErrorResponse('boom')).toBe(false);
    expect(isComputerUseErrorResponse(42)).toBe(false);
  });

  it('returns false when code field is missing', () => {
    expect(isComputerUseErrorResponse({ success: false, error: 'boom' })).toBe(false);
  });
});

describe('ERROR_CODE_HTTP_STATUS', () => {
  it('maps SESSION_* codes to the documented statuses', () => {
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_SESSION_NOT_FOUND).toBe(404);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_SESSION_CLOSED).toBe(400);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_SESSION_LOST).toBe(410);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_SESSION_AT_CAPACITY).toBe(429);
  });

  it('maps BRIDGE_* codes to the right status class', () => {
    // 503 — bridge gone
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_UNAVAILABLE).toBe(503);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_STARTUP_TIMEOUT).toBe(503);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_PORT_HELD).toBe(503);
    // 502 — bridge garbage
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_BAD_RESPONSE).toBe(502);
    // 504 — bridge slow
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TIMEOUT).toBe(504);
    // 501 — environment missing
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_PYTHON_MISSING).toBe(501);
    // 500 — devflow itself failed
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_SCRIPT_MISSING).toBe(500);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_SPAWN_FAILED).toBe(500);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_BRIDGE_ERROR).toBe(500);
  });

  it('reflects the two HTTP status corrections from sprint kickoff', () => {
    // (1) HEADLESS_LAUNCH_FAILED is 500, replaces the 501 PLAYWRIGHT_MISSING for chromium-launch failures
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_HEADLESS_LAUNCH_FAILED).toBe(500);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_PLAYWRIGHT_MISSING).toBe(501);
    // (2) TASK_ALREADY_DONE is 400 (was using SESSION_CLOSED before)
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TASK_ALREADY_DONE).toBe(400);
  });

  it('maps TASK_* codes to the documented statuses', () => {
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TASK_NOT_FOUND).toBe(404);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TASK_DISPATCH_FAILED).toBe(502);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TASK_DISPATCHER_UNAVAILABLE).toBe(503);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TASK_SPAWN_FAILED).toBe(500);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TASK_PROMPT_TOO_LARGE).toBe(413);
  });

  it('maps CONFIG / VALIDATION / INTERNAL codes', () => {
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_DISABLED).toBe(403);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_TOKEN_MISSING).toBe(500);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_AUTH_REQUIRED).toBe(401);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING).toBe(400);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_VALIDATION_FIELD_TYPE).toBe(400);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_VALIDATION_FIELD_RANGE).toBe(400);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_UNKNOWN_ACTION).toBe(400);
    expect(ERROR_CODE_HTTP_STATUS.COMPUTER_USE_INTERNAL).toBe(500);
  });
});

describe('missingRequiredContext()', () => {
  it('flags VALIDATION_* codes missing context.field', () => {
    expect(missingRequiredContext('COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING')).toEqual(['field']);
    expect(missingRequiredContext('COMPUTER_USE_VALIDATION_FIELD_TYPE', {})).toEqual(['field']);
    expect(missingRequiredContext('COMPUTER_USE_VALIDATION_FIELD_RANGE', { field: '' as string }))
      .toEqual(['field']);
  });

  it('passes VALIDATION_* codes when context.field is present', () => {
    expect(missingRequiredContext('COMPUTER_USE_VALIDATION_REQUIRED_FIELD_MISSING', { field: 'sessionId' }))
      .toEqual([]);
  });

  it('flags INTERNAL missing context.logId', () => {
    expect(missingRequiredContext('COMPUTER_USE_INTERNAL')).toEqual(['logId']);
    expect(missingRequiredContext('COMPUTER_USE_INTERNAL', { logId: 'req-abc' })).toEqual([]);
  });

  it('flags TIMEOUT missing context.durationMs', () => {
    expect(missingRequiredContext('COMPUTER_USE_TIMEOUT')).toEqual(['durationMs']);
    expect(missingRequiredContext('COMPUTER_USE_TIMEOUT', { durationMs: 0 })).toEqual([]); // 0 is valid
  });

  it('flags SESSION_NOT_FOUND / SESSION_CLOSED / SESSION_LOST missing sessionId', () => {
    expect(missingRequiredContext('COMPUTER_USE_SESSION_NOT_FOUND')).toEqual(['sessionId']);
    expect(missingRequiredContext('COMPUTER_USE_SESSION_CLOSED')).toEqual(['sessionId']);
    expect(missingRequiredContext('COMPUTER_USE_SESSION_LOST')).toEqual(['sessionId']);
  });

  it('does NOT flag SESSION_AT_CAPACITY for missing sessionId', () => {
    // Per taxonomy §4.1: SESSION_AT_CAPACITY is the exception
    expect(missingRequiredContext('COMPUTER_USE_SESSION_AT_CAPACITY')).toEqual([]);
  });

  it('returns empty array for codes with no mandatory context', () => {
    expect(missingRequiredContext('COMPUTER_USE_DISABLED')).toEqual([]);
    expect(missingRequiredContext('COMPUTER_USE_AUTH_REQUIRED')).toEqual([]);
  });
});

describe('ComputerUseErrorCode TS literal union', () => {
  it('compile-time check: every code in the HTTP status table is a valid code', () => {
    // This is a runtime smoke test mirroring the static guarantee — if a new
    // code is added to the union but missed in ERROR_CODE_HTTP_STATUS, TS
    // will fail compile because the Record key set is exhaustive.
    const codes = Object.keys(ERROR_CODE_HTTP_STATUS) as ComputerUseErrorCode[];
    expect(codes.length).toBeGreaterThanOrEqual(33); // 32 from taxonomy §3.2 + BRIDGE_PORT_HELD + INVALID_PARAMS legacy
    for (const code of codes) {
      expect(ERROR_CODE_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
