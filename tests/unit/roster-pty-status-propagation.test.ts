/**
 * Tests for T2.2 + T2.3 combined fix — callPtyApi status propagation and
 * PTY-layer raw-throw 404 classification.
 *
 * Before the fix:
 *   - `roster.ts:callPtyApi` discarded `res.status` and returned only the JSON body.
 *   - Every `throw new Error(data.error)` in the roster.* wrappers produced a
 *     plain Error with no statusCode attached.
 *   - /api/agent/route.ts only skipped `emitApiError` for 4xx when statusCode
 *     was set, so these all fell through to the critical fallback path and
 *     were logged as 'critical' server errors.
 *
 * After the fix:
 *   - callPtyApi returns `{ status, body }`.
 *   - Wrappers throw via `Object.assign(new Error(...), { statusCode: ptyErrorStatusCode(status) })`.
 *   - PTY-layer raw throws inside withFileLock (`roster-ops.ts`, `message-inject.ts`)
 *     attach statusCode 404 via Object.assign, and `pty/route.ts`'s outer catch
 *     reads statusCode and returns the correct HTTP status instead of always 500.
 *
 * These unit tests mock fetch and verify that the statusCode propagates end-to-end
 * through the roster.* wrappers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch — we only exercise the wrapper's branching logic
const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  vi.resetModules();
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockPtyResponse(status: number, body: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce({
    status,
    json: async () => body,
  });
}

async function catchStatus<T>(fn: () => Promise<T>): Promise<{ message: string; statusCode: number | undefined }> {
  try {
    await fn();
    throw new Error('Expected function to throw');
  } catch (err: unknown) {
    const e = err as { message?: string; statusCode?: number };
    return { message: e.message || '', statusCode: e.statusCode };
  }
}

describe('roster.spawn status propagation', () => {
  it('attaches statusCode 404 when PTY returns 404 "Agent not found in roster"', async () => {
    mockPtyResponse(404, { success: false, error: 'Agent not found in roster' });
    const { spawn } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      spawn({ channelId: 'ch-1', agentId: 'missing' } as never, { requestId: 'r1' } as never),
    );
    expect(result.message).toContain('Agent not found in roster');
    expect(result.statusCode).toBe(404);
  });

  it('attaches statusCode 400 when PTY returns 400 "Agent is already running"', async () => {
    mockPtyResponse(400, { success: false, error: 'Agent is already running' });
    const { spawn } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      spawn({ channelId: 'ch-1', agentId: 'a1' } as never, { requestId: 'r2' } as never),
    );
    expect(result.message).toContain('already running');
    expect(result.statusCode).toBe(400);
  });

  it('attaches statusCode 409 when PTY returns 409 "Agent is already starting"', async () => {
    mockPtyResponse(409, { success: false, error: 'Agent is already starting (concurrent request)' });
    const { spawn } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      spawn({ channelId: 'ch-1', agentId: 'a1' } as never, { requestId: 'r3' } as never),
    );
    expect(result.message).toContain('already starting');
    expect(result.statusCode).toBe(409);
  });

  it('attaches statusCode 500 when PTY returns a 500 server error', async () => {
    mockPtyResponse(500, { success: false, error: 'Unexpected server error' });
    const { spawn } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      spawn({ channelId: 'ch-1', agentId: 'a1' } as never, { requestId: 'r4' } as never),
    );
    expect(result.statusCode).toBe(500);
  });

  it('clamps out-of-range status to 500 on thrown errors', async () => {
    mockPtyResponse(200, { success: false, error: 'body-level failure with 200 status' });
    const { spawn } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      spawn({ channelId: 'ch-1', agentId: 'a1' } as never, { requestId: 'r5' } as never),
    );
    expect(result.statusCode).toBe(500);
  });
});

describe('roster.kill / roster.respawn / roster.remove status propagation', () => {
  it('roster.kill attaches statusCode 404 on "Agent not found in roster"', async () => {
    mockPtyResponse(404, { success: false, error: 'Agent not found in roster' });
    const { kill } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      kill({ channelId: 'ch-1', agentId: 'missing' } as never, { requestId: 'r6' } as never),
    );
    expect(result.statusCode).toBe(404);
  });

  it('roster.respawn attaches statusCode 404 on "Agent not found in roster"', async () => {
    mockPtyResponse(404, { success: false, error: 'Agent not found in roster' });
    const { respawn } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      respawn({ channelId: 'ch-1', agentId: 'missing' } as never, { requestId: 'r7' } as never),
    );
    expect(result.statusCode).toBe(404);
  });

  it('roster.remove attaches statusCode 404 on "Agent not found in roster"', async () => {
    mockPtyResponse(404, { success: false, error: 'Agent not found in roster' });
    const { remove } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      remove({ channelId: 'ch-1', agentId: 'missing' } as never, { requestId: 'r8' } as never),
    );
    expect(result.statusCode).toBe(404);
  });

  it('roster.launchAll attaches statusCode from PTY response', async () => {
    mockPtyResponse(404, { success: false, error: 'Channel or roster not found' });
    const { launchAll } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      launchAll({ channelId: 'ch-1' } as never, { requestId: 'r9' } as never),
    );
    expect(result.statusCode).toBe(404);
  });

  it('roster.list attaches statusCode from PTY response on failure', async () => {
    mockPtyResponse(500, { success: false, error: 'PTY server error' });
    const { list } = await import('@/app/api/agent/actions/roster');
    const result = await catchStatus(() =>
      list({ channelId: 'ch-1' } as never, { requestId: 'r10' } as never),
    );
    expect(result.statusCode).toBe(500);
  });
});

describe('roster.spawn successful path is unchanged', () => {
  it('returns session + participant on 200 success', async () => {
    mockPtyResponse(200, {
      success: true,
      session: { id: 'sess-1', pid: 42 },
      participant: { id: 'p1', name: 'Builder' },
    });
    // Second call is the fire-and-forget roster_list for sync.py — mock it too
    mockPtyResponse(200, { success: true, agents: [] });
    const { spawn } = await import('@/app/api/agent/actions/roster');
    const result = await spawn(
      { channelId: 'ch-1', agentId: 'a1' } as never,
      { requestId: 'r11' } as never,
    );
    expect((result as { session: { id: string } }).session.id).toBe('sess-1');
    expect((result as { participant: { name: string } }).participant.name).toBe('Builder');
  });
});
