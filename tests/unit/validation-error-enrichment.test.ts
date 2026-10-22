/**
 * Tests for T3.3 — API validation error messages include the action name.
 *
 * Before: every validator threw `"participantId is required"` as a plain
 * Error, and the /api/agent catch block logged `action: 'unknown'`. Triage
 * had to grep the codebase to find out which of the 16+ validators fired.
 *
 * After: the /api/agent outer catch prefixes the message with the resolved
 * action name (e.g. `[collab.message] participantId is required`) before
 * emitting the event and returning the error response. The `action` field
 * on emitApiError and emitApiEvent also carries the real action name.
 *
 * These tests hit the route handler with real action dispatch so we verify
 * the enriched response body end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the auth layer so requests bypass real token validation
vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api-auth');
  return {
    ...actual,
    validateApiToken: vi.fn().mockResolvedValue({
      valid: true,
      token: {
        id: 'test-token',
        name: 'Test',
        scope: 'admin',
        createdBy: 'test',
      },
    }),
  };
});

// Silence emitters so we don't touch the event bus / disk during tests
vi.mock('@/lib/event-bus', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/event-bus');
  return {
    ...actual,
    emitApiError: vi.fn(),
  };
});

vi.mock('@/lib/log-emitter', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/log-emitter');
  return {
    ...actual,
    emitApiEvent: vi.fn(),
  };
});

vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: Function) => handler,
  withTiming: (_path: string, handler: Function) => handler,
}));

vi.mock('@/lib/api-logger', () => ({
  withApiLogging: (handler: Function) => handler,
}));

async function postToAgent(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  // Fresh import so mocks apply
  const { POST } = await import('@/app/api/agent/route');
  const req = new Request('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(req);
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe('T3.3 — validation error messages include action name', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prefixes "participantId is required" with the action name for collab.message', async () => {
    const { status, json } = await postToAgent({
      action: 'collab.message',
      channelId: 'ch-1',
      // participantId deliberately omitted
      content: 'hello',
    });
    expect(status).toBe(400);
    expect(json.error).toBe('[collab.message] participantId is required');
  });

  it('prefixes "participantId is required" with the action name for phases.create', async () => {
    const { status, json } = await postToAgent({
      action: 'phases.create',
      channelId: 'ch-1',
      // participantId deliberately omitted
      sprintId: 's-1',
      name: 'Phase 1',
    });
    expect(status).toBe(400);
    expect(json.error).toBe('[phases.create] participantId is required');
  });

  it('prefixes "channelId is required" with the action name', async () => {
    const { status, json } = await postToAgent({
      action: 'collab.message',
      // channelId deliberately omitted
    });
    expect(status).toBe(400);
    expect(json.error).toBe('[collab.message] channelId is required');
  });

  it('returns Missing action field error without prefix when no action in body', async () => {
    const { status, json } = await postToAgent({
      // action deliberately omitted
      channelId: 'ch-1',
    });
    expect(status).toBe(400);
    // Pre-dispatch error — no action to prefix with, message is unchanged
    expect(json.error).toBe('Missing or invalid action field');
  });

  it('returns error with Unknown action prefix when action is not recognized', async () => {
    const { status, json } = await postToAgent({
      action: 'totally.bogus.action',
    });
    expect(status).toBe(400);
    // Handler lookup failed before dispatch — uses the route-level message
    expect(json.error).toContain('Unknown action');
  });

  it('infers statusCode 400 for "is required" validators that throw plain Error (no statusCode attached)', async () => {
    // phases.create / collab.message validators use `throw new Error('X is required')`
    // with no Object.assign — the outer catch must still classify these as 400.
    const { status } = await postToAgent({
      action: 'phases.create',
      channelId: 'ch-1',
      sprintId: 's-1',
      name: 'Phase 1',
      // participantId missing → plain Error('participantId is required')
    });
    expect(status).toBe(400);
  });

  it('preserves explicit statusCode when validator uses Object.assign pattern', async () => {
    // roster.list uses Object.assign(..., { statusCode: 400 }) — the explicit
    // value must be respected, not overridden by the pattern inference.
    const { status, json } = await postToAgent({
      action: 'roster.list',
      // channelId missing
    });
    expect(status).toBe(400);
    expect(json.error).toBe('[roster.list] channelId is required');
  });
});
