/**
 * T3: Backport statusCode passthrough from /api/collab/pty to /api/collab.
 *
 * RED:  Both GET and POST catch blocks always return 500, even for 4xx errors.
 * GREEN: Thrown errors carrying `statusCode: 400`-range produce 400 responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn(),
  withFileLock: vi.fn().mockImplementation(
    (_path: string, fn: () => Promise<unknown>) => fn()
  ),
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: vi.fn().mockImplementation((_: string, handler: unknown) => handler),
  withTiming: vi.fn().mockImplementation((_: string, handler: unknown) => handler),
  trackResponse: vi.fn(),
}));

vi.mock('@/lib/error-rate-tracker', () => ({
  trackResponse: vi.fn(),
}));

vi.mock('@/lib/event-bus', () => ({
  emitCollabError: vi.fn(),
}));

vi.mock('@/lib/collab-message-io', () => ({
  readChannelMessages: vi.fn(),
  getMessagesPaginated: vi.fn(),
  CACHE_TTL: new Map(),
  MAX_MESSAGES: 500,
}));

// ─── Dynamic import so mocks install first ───────────────────────────────────

type CollabRoute = typeof import('@/app/api/collab/route');
let GET: CollabRoute['GET'], POST: CollabRoute['POST'];
let withFileLock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const route = await import('@/app/api/collab/route');
  GET = route.GET;
  POST = route.POST;
  const dataIo = await import('@/lib/data-io');
  withFileLock = dataIo.withFileLock as ReturnType<typeof vi.fn>;
});

function makeRequest(body?: object, method = 'POST') {
  return new NextRequest('http://localhost:3000/api/collab', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/collab — statusCode passthrough', () => {
  it('returns 404 when handler throws with statusCode 404', async () => {
    withFileLock.mockImplementationOnce(() => {
      throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
    });

    const res = await POST(makeRequest({ action: 'join', channelId: 'missing', participantId: 'p1' }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('Channel not found');
  });

  it('returns 400 when handler throws with statusCode 400', async () => {
    withFileLock.mockImplementationOnce(() => {
      throw Object.assign(new Error('Bad request'), { statusCode: 400 });
    });

    const res = await POST(makeRequest({ action: 'join', channelId: 'x', participantId: 'p1' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Bad request');
  });

  it('returns 500 when handler throws without statusCode (regression guard)', async () => {
    withFileLock.mockImplementationOnce(() => {
      throw new Error('Internal failure');
    });

    const res = await POST(makeRequest({ action: 'join', channelId: 'x', participantId: 'p1' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal failure');
  });
});
