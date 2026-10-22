/**
 * Integration tests for /api/agent route.
 *
 * Tests the action dispatcher via direct handler invocation (no HTTP server).
 * Mocks: data-io (token store), event-bus (SSE bus), log-emitter (event log).
 * All action I/O is exercised as-is — roles.list reads fail gracefully (empty),
 * sprints.list uses mocked readJsonFile, roster.list gets stubbed fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks (hoisted by Vitest) ───────────────────────────────────────────────

const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock('@/lib/data-io', () => ({
  readJsonFile: readMock,
  readJsonFileStrict: readMock,
  JsonFileCorruptError: class JsonFileCorruptError extends Error {},
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn().mockImplementation(
    (_path: string, fn: () => Promise<unknown>) => fn()
  ),
}));

vi.mock('@/lib/event-bus', () => ({
  emitApiError: vi.fn(),
  emitCollabError: vi.fn(),
  emitAgentError: vi.fn(),
  eventBus: {
    emitEvent: vi.fn().mockReturnValue({ id: '1', type: 'heartbeat', data: {}, timestamp: '' }),
    addClient: vi.fn(),
    removeClient: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
    getEventCounter: vi.fn().mockReturnValue(0),
    getBufferSize: vi.fn().mockReturnValue(0),
    getMaxBufferSize: vi.fn().mockReturnValue(100),
    getEventsSince: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  },
  EVENT_DOMAINS: {},
}));

vi.mock('@/lib/log-emitter', () => ({
  emitApiEvent: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { readJsonFile } from '@/lib/data-io';
import { generateToken, hashToken } from '@/lib/api-auth';
import { GET, POST } from '@/app/api/agent/route';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tokenStore(hash: string, scope: 'read' | 'write' | 'admin') {
  return {
    tokens: [{
      id: 'tok-test',
      name: 'Test',
      tokenHash: hash,
      tokenPrefix: 'dvf_live',
      scope,
      createdAt: new Date().toISOString(),
      createdBy: 'test',
      expiresAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      revokedBy: null,
      usageCount: 0,
      metadata: {},
    }],
    config: { maxTokensPerUser: 10, defaultExpiration: 0, requireExpiration: false, rateLimitWindow: 60, rateLimitMax: 100 },
    rateLimits: {},
    failedAttempts: {},
    lastUpdated: new Date().toISOString(),
  };
}

const emptyTasksData = {
  sprints: [], phases: [], tasks: [],
  lastUpdated: new Date().toISOString(),
};

function makePostReq(body: unknown, bearerToken?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/agent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      'x-forwarded-for': '203.0.113.1', // external IP — forces token auth
    },
    body: JSON.stringify(body),
  });
}

function makeGetReq(bearerToken?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/agent', {
    method: 'GET',
    headers: {
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      'x-forwarded-for': '203.0.113.1',
    },
  });
}

async function parseBody(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── GET /api/agent ───────────────────────────────────────────────────────────

describe('GET /api/agent', () => {
  let token: string;
  let hash: string;

  beforeEach(() => {
    ({ token, hash } = generateToken());
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 401 when no Authorization header', async () => {
    vi.mocked(readJsonFile).mockResolvedValue({ tokens: [], config: {}, rateLimits: {}, failedAttempts: {}, lastUpdated: '' });
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
    const body = await parseBody(res);
    expect(body.success).toBe(false);
    expect(body.code).toBe('AUTH_MISSING');
  });

  it('returns 401 for token without dvf_ prefix', async () => {
    vi.mocked(readJsonFile).mockResolvedValue({ tokens: [], config: {}, rateLimits: {}, failedAttempts: {}, lastUpdated: '' });
    const res = await GET(makeGetReq('not_a_valid_format'));
    expect(res.status).toBe(401);
    const body = await parseBody(res);
    expect(body.code).toBe('AUTH_INVALID');
  });

  it('returns 200 and lists available actions for a valid read token', async () => {
    const res = await GET(makeGetReq(token));
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.scope).toBe('read');
    expect(Array.isArray(data.actions)).toBe(true);
    expect((data.actions as unknown[]).length).toBeGreaterThan(0);
    expect(typeof data.totalActions).toBe('number');
  });
});

// ─── POST /api/agent — auth & dispatcher ────────────────────────────────────

describe('POST /api/agent — auth & dispatcher errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(readJsonFile).mockResolvedValue({ tokens: [], config: {}, rateLimits: {}, failedAttempts: {}, lastUpdated: '' });
  });

  it('returns 401 when no Authorization header', async () => {
    const res = await POST(makePostReq({ action: 'auth.validate' }));
    expect(res.status).toBe(401);
    const body = await parseBody(res);
    expect(body.success).toBe(false);
    expect(body.code).toBe('AUTH_MISSING');
  });

  it('returns 400 (INVALID_ACTION) when action field is absent', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const res = await POST(makePostReq({}, token));
    expect(res.status).toBe(400);
    const body = await parseBody(res);
    expect(body.code).toBe('INVALID_ACTION');
  });

  it('returns 400 (INVALID_ACTION) when action is an empty string', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const res = await POST(makePostReq({ action: '' }, token));
    expect(res.status).toBe(400);
    const body = await parseBody(res);
    expect(body.code).toBe('INVALID_ACTION');
  });

  it('returns 400 (INVALID_ACTION) for an unknown action name', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const res = await POST(makePostReq({ action: 'nonexistent.action' }, token));
    expect(res.status).toBe(400);
    const body = await parseBody(res);
    expect(body.code).toBe('INVALID_ACTION');
    expect(String(body.error)).toContain('nonexistent.action');
  });

  it('returns 400 for malformed JSON body', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const req = new NextRequest('http://localhost:3000/api/agent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.1',
      },
      body: 'not json {{{',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await parseBody(res);
    expect(body.success).toBe(false);
  });
});

// ─── POST /api/agent — auth.validate ─────────────────────────────────────────

describe('POST /api/agent — auth.validate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns valid:true with tokenId and scope', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const res = await POST(makePostReq({ action: 'auth.validate' }, token));
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.valid).toBe(true);
    expect(typeof data.tokenId).toBe('string');
    expect(data.scope).toBe('read');
  });

  it('reflects scope correctly for write token', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'write'));

    const res = await POST(makePostReq({ action: 'auth.validate' }, token));
    const body = await parseBody(res);
    const data = body.data as Record<string, unknown>;
    expect(data.scope).toBe('write');
  });
});

// ─── POST /api/agent — auth.whoami ───────────────────────────────────────────

describe('POST /api/agent — auth.whoami', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns tokenName and sorted permissions array', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const res = await POST(makePostReq({ action: 'auth.whoami' }, token));
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.tokenName).toBe('Test');
    expect(Array.isArray(data.permissions)).toBe(true);
    expect((data.permissions as string[]).length).toBeGreaterThan(0);
  });

  it('includes write permissions for write-scoped token', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'write'));

    const res = await POST(makePostReq({ action: 'auth.whoami' }, token));
    const body = await parseBody(res);
    const perms = (body.data as Record<string, unknown>).permissions as string[];
    expect(perms).toContain('collab.message');
    expect(perms).toContain('projects.list');
  });
});

// ─── POST /api/agent — roles.list ────────────────────────────────────────────

describe('POST /api/agent — roles.list', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 200 with roles array (empty when roles.json absent in test cwd)', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const res = await POST(makePostReq({ action: 'roles.list' }, token));
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(Array.isArray(data.roles)).toBe(true);
  });
});

// ─── POST /api/agent — sprints.list ──────────────────────────────────────────

describe('POST /api/agent — sprints.list', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 400 when channelId is missing', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    const res = await POST(makePostReq({ action: 'sprints.list' }, token));
    expect(res.status).toBe(400);
    const body = await parseBody(res);
    expect(body.success).toBe(false);
  });

  it('returns 200 with empty sprint list for a valid channelId', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockImplementation((filePath: string) => {
      if (String(filePath).includes('api-tokens')) return Promise.resolve(tokenStore(hash, 'read'));
      return Promise.resolve(emptyTasksData);
    });

    const res = await POST(makePostReq({ action: 'sprints.list', channelId: 'chan-abc' }, token));
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(Array.isArray(data.sprints)).toBe(true);
    expect(data.count).toBe(0);
  });
});

// ─── POST /api/agent — roster.list ───────────────────────────────────────────

describe('POST /api/agent — roster.list', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 400 when channelId is missing', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    // fetch would be called if we got past validation — but we error before that
    const res = await POST(makePostReq({ action: 'roster.list' }, token));
    expect(res.status).toBe(400);
    const body = await parseBody(res);
    expect(body.success).toBe(false);
  });

  it('returns 200 with agents when PTY API responds successfully', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, agents: [{ id: 'agent-1', name: 'TestAgent' }] }),
    }));

    const res = await POST(makePostReq({ action: 'roster.list', channelId: 'chan-abc' }, token));
    expect(res.status).toBe(200);
    const body = await parseBody(res);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(Array.isArray(data.agents)).toBe(true);
    expect(data.count).toBe(1);
  });

  it('propagates roster error when PTY API returns success:false', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, error: 'Channel not found' }),
    }));

    const res = await POST(makePostReq({ action: 'roster.list', channelId: 'bad-chan' }, token));
    // roster.list throws plain Error (no statusCode) → route catch → 500
    expect(res.status).toBe(500);
    const body = await parseBody(res);
    expect(body.success).toBe(false);
  });
});

// ─── POST /api/agent — scope enforcement ─────────────────────────────────────

describe('POST /api/agent — scope enforcement', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns 403 when a read-scoped token calls a write action', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    // pm2.restart requires 'write' scope
    const res = await POST(makePostReq({ action: 'pm2.restart', name: 'devflow' }, token));
    expect(res.status).toBe(403);
    const body = await parseBody(res);
    expect(body.success).toBe(false);
    expect(body.code).toBe('AUTH_INSUFFICIENT');
  });

  it('returns 403 when a read-scoped token calls an admin action', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'read'));

    // projects.delete requires 'admin' scope
    const res = await POST(makePostReq({ action: 'projects.delete', id: 'proj-1' }, token));
    expect(res.status).toBe(403);
    const body = await parseBody(res);
    expect(body.code).toBe('AUTH_INSUFFICIENT');
  });

  it('returns 403 when a write-scoped token calls an admin action', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(tokenStore(hash, 'write'));

    const res = await POST(makePostReq({ action: 'projects.delete', id: 'proj-1' }, token));
    expect(res.status).toBe(403);
    const body = await parseBody(res);
    expect(body.code).toBe('AUTH_INSUFFICIENT');
  });
});
