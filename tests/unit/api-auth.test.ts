import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock file I/O to avoid disk access in unit tests
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

import { readJsonFile } from '@/lib/data-io';
import {
  hashToken,
  generateToken,
  hasPermission,
  isLocalRequest,
  getClientIp,
  validateApiToken,
  requireAuthOrLocal,
} from '@/lib/api-auth';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/', { headers });
}

const emptyStore = {
  tokens: [],
  config: {
    maxTokensPerUser: 10,
    defaultExpiration: 0,
    requireExpiration: false,
    rateLimitWindow: 60,
    rateLimitMax: 100,
  },
  rateLimits: {},
  failedAttempts: {},
  lastUpdated: new Date().toISOString(),
};

function storeWithToken(scope: 'read' | 'write' | 'admin', hash: string) {
  return {
    ...emptyStore,
    tokens: [{
      id: 'tok-test',
      name: 'Test Token',
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
  };
}

// ─── hashToken ───────────────────────────────────────────────────────────────

describe('hashToken', () => {
  it('returns a 64-char hex string', () => {
    expect(hashToken('dvf_live_abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const h1 = hashToken('dvf_live_same');
    const h2 = hashToken('dvf_live_same');
    expect(h1).toBe(h2);
  });

  it('produces different outputs for different inputs', () => {
    expect(hashToken('dvf_live_aaa')).not.toBe(hashToken('dvf_live_bbb'));
  });
});

// ─── generateToken ───────────────────────────────────────────────────────────

describe('generateToken', () => {
  it('uses dvf_live_ prefix in production mode', () => {
    const { token } = generateToken(true);
    expect(token).toMatch(/^dvf_live_/);
  });

  it('uses dvf_test_ prefix in non-production mode', () => {
    const { token } = generateToken(false);
    expect(token).toMatch(/^dvf_test_/);
  });

  it('defaults to production mode', () => {
    const { token } = generateToken();
    expect(token).toMatch(/^dvf_live_/);
  });

  it('hash field matches hashToken(token)', () => {
    const { token, hash } = generateToken();
    expect(hash).toBe(hashToken(token));
  });

  it('generates unique tokens on successive calls', () => {
    const tokens = Array.from({ length: 5 }, () => generateToken().token);
    const unique = new Set(tokens);
    expect(unique.size).toBe(5);
  });
});

// ─── hasPermission ────────────────────────────────────────────────────────────

describe('hasPermission', () => {
  // Positive cases
  it.each([
    ['read', 'read'],
    ['write', 'read'],
    ['write', 'write'],
    ['admin', 'read'],
    ['admin', 'write'],
    ['admin', 'admin'],
  ] as const)('%s satisfies %s', (have, need) => {
    expect(hasPermission(have, need)).toBe(true);
  });

  // Negative cases
  it.each([
    ['read', 'write'],
    ['read', 'admin'],
    ['write', 'admin'],
  ] as const)('%s does NOT satisfy %s', (have, need) => {
    expect(hasPermission(have, need)).toBe(false);
  });
});

// ─── getClientIp ─────────────────────────────────────────────────────────────

describe('getClientIp', () => {
  it('takes the last IP from x-forwarded-for: the one the nearest proxy added, not the one the sender wrote', () => {
    expect(getClientIp(makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('5.6.7.8');
    expect(getClientIp(makeRequest({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('trims whitespace from the forwarded IP', () => {
    expect(getClientIp(makeRequest({ 'x-forwarded-for': '  9.9.9.9  ' }))).toBe('9.9.9.9');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    expect(getClientIp(makeRequest({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
  });

  it('falls back to 127.0.0.1 when no headers present', () => {
    expect(getClientIp(makeRequest())).toBe('127.0.0.1');
  });
});

// ─── isLocalRequest ───────────────────────────────────────────────────────────

describe('isLocalRequest', () => {
  it('returns true for x-forwarded-for 127.0.0.1', () => {
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
  });

  it('returns true for x-forwarded-for ::1', () => {
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '::1' }))).toBe(true);
  });

  it('returns true for x-forwarded-for ::ffff:127.0.0.1', () => {
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '::ffff:127.0.0.1' }))).toBe(true);
  });

  it('returns false for an external IP in x-forwarded-for', () => {
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '203.0.113.1' }))).toBe(false);
  });

  it('returns true when no x-forwarded-for (direct connection assumed local)', () => {
    expect(isLocalRequest(makeRequest())).toBe(true);
  });
});

// ─── validateApiToken ────────────────────────────────────────────────────────

describe('validateApiToken', () => {
  beforeEach(() => {
    vi.mocked(readJsonFile).mockResolvedValue(emptyStore);
  });

  it('returns AUTH_MISSING when no Authorization header', async () => {
    const result = await validateApiToken(
      makeRequest({ 'x-forwarded-for': '203.0.113.1' })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('AUTH_MISSING');
  });

  it('returns AUTH_INVALID for token without dvf_ prefix', async () => {
    const result = await validateApiToken(
      makeRequest({
        Authorization: 'Bearer some_random_token',
        'x-forwarded-for': '203.0.113.1',
      })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('AUTH_INVALID');
  });

  it('returns AUTH_INVALID for a dvf_-prefixed token not in the store', async () => {
    const result = await validateApiToken(
      makeRequest({
        Authorization: 'Bearer dvf_live_notregistered',
        'x-forwarded-for': '203.0.113.1',
      })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('AUTH_INVALID');
  });

  it('returns valid:true when the token matches a stored record', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(storeWithToken('read', hash));

    const result = await validateApiToken(
      makeRequest({
        Authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.1',
      })
    );
    expect(result.valid).toBe(true);
    expect(result.token?.scope).toBe('read');
  });

  it('also accepts token via X-Api-Token header', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(storeWithToken('write', hash));

    const result = await validateApiToken(
      makeRequest({
        'X-Api-Token': token,
        'x-forwarded-for': '203.0.113.1',
      })
    );
    expect(result.valid).toBe(true);
  });

  it('returns AUTH_INVALID for a revoked token', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue({
      ...emptyStore,
      tokens: [{
        id: 'tok-revoked',
        name: 'Revoked',
        tokenHash: hash,
        tokenPrefix: 'dvf_live',
        scope: 'read',
        createdAt: new Date().toISOString(),
        createdBy: 'test',
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        revokedAt: new Date().toISOString(),
        revokedBy: 'test',
        usageCount: 0,
        metadata: {},
      }],
    });

    const result = await validateApiToken(
      makeRequest({
        Authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.1',
      })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('AUTH_INVALID');
  });
});

// ─── requireAuthOrLocal ──────────────────────────────────────────────────────

describe('requireAuthOrLocal', () => {
  beforeEach(() => {
    vi.mocked(readJsonFile).mockResolvedValue(emptyStore);
  });

  it('returns null (allowed) for a direct local request (no forwarded header)', async () => {
    const result = await requireAuthOrLocal(makeRequest(), 'read');
    expect(result).toBeNull();
  });

  it('returns null for x-forwarded-for 127.0.0.1', async () => {
    const result = await requireAuthOrLocal(
      makeRequest({ 'x-forwarded-for': '127.0.0.1' }),
      'write'
    );
    expect(result).toBeNull();
  });

  it('returns 401 for an external request with no token', async () => {
    const result = await requireAuthOrLocal(
      makeRequest({ 'x-forwarded-for': '203.0.113.1' }),
      'read'
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns null for an external request with a valid read token (scope satisfied)', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(storeWithToken('read', hash));

    const result = await requireAuthOrLocal(
      makeRequest({
        Authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.1',
      }),
      'read'
    );
    expect(result).toBeNull();
  });

  it('returns 403 when token scope is insufficient for required scope', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(storeWithToken('read', hash));

    const result = await requireAuthOrLocal(
      makeRequest({
        Authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.1',
      }),
      'admin'
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('returns null for an external write-scoped token satisfying write requirement', async () => {
    const { token, hash } = generateToken();
    vi.mocked(readJsonFile).mockResolvedValue(storeWithToken('write', hash));

    const result = await requireAuthOrLocal(
      makeRequest({
        Authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.1',
      }),
      'write'
    );
    expect(result).toBeNull();
  });
});

// ─── isLocalRequest: web pages are not the owner ──────────────────────────────

describe('isLocalRequest and browser requests', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    for (const k of ['DEVFLOW_ORIGIN_CHECK', 'DEVFLOW_REQUIRE_TOKEN', 'DEVFLOW_ALLOWED_HOSTS', 'DEVFLOW_BIND_HOST']) {
      if (OLD[k] === undefined) delete process.env[k]; else process.env[k] = OLD[k];
    }
  });

  it('refuses a cross-origin browser request even though it comes from this machine', () => {
    delete process.env.DEVFLOW_ORIGIN_CHECK;
    expect(isLocalRequest(makeRequest({ origin: 'https://evil.example' }))).toBe(false);
    expect(isLocalRequest(makeRequest({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('refuses a request sent to another name (rebinding), whatever the address', () => {
    delete process.env.DEVFLOW_ORIGIN_CHECK;
    expect(isLocalRequest(makeRequest({ host: 'attacker.example:3000', 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });

  it('still accepts the dashboard and command-line tools', () => {
    delete process.env.DEVFLOW_ORIGIN_CHECK;
    expect(isLocalRequest(makeRequest({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true);
    expect(isLocalRequest(makeRequest({ host: 'localhost:3000' }))).toBe(true);
  });

  it('report mode refuses nothing', () => {
    process.env.DEVFLOW_ORIGIN_CHECK = 'report';
    expect(isLocalRequest(makeRequest({ origin: 'https://evil.example' }))).toBe(true);
  });

  it('a spoofed local address at the front of a proxy chain does not make the request local', () => {
    delete process.env.DEVFLOW_ORIGIN_CHECK;
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }))).toBe(false);
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '203.0.113.9, 127.0.0.1' }))).toBe(false);
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '127.0.0.1, ::1' }))).toBe(true);
  });

  it('DEVFLOW_REQUIRE_TOKEN=1 never trusts the machine', () => {
    process.env.DEVFLOW_REQUIRE_TOKEN = '1';
    expect(isLocalRequest(makeRequest())).toBe(false);
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });

  it('a server set to listen on the network trusts no request for claiming to be local', () => {
    process.env.DEVFLOW_BIND_HOST = '0.0.0.0';
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isLocalRequest(makeRequest())).toBe(false);
    process.env.DEVFLOW_BIND_HOST = '127.0.0.1';
    expect(isLocalRequest(makeRequest({ 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
  });

  it('requireAuthOrLocal asks a cross-origin page for a token (401) and lets a valid token through', async () => {
    delete process.env.DEVFLOW_ORIGIN_CHECK;
    vi.mocked(readJsonFile).mockResolvedValue(emptyStore as never);
    const denied = await requireAuthOrLocal(makeRequest({ origin: 'https://evil.example' }));
    expect(denied?.status).toBe(401);
  });
});
