import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { store } = vi.hoisted(() => ({ store: { data: null as unknown } }));
vi.mock('@/lib/data-io', () => ({
  readJsonFile: async () => JSON.parse(JSON.stringify(store.data)),
  readJsonFileStrict: async () => JSON.parse(JSON.stringify(store.data)),
  JsonFileCorruptError: class JsonFileCorruptError extends Error {},
  writeJsonFile: async (_path: string, data: unknown) => { store.data = JSON.parse(JSON.stringify(data)); },
  withFileLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/design-references/store', () => ({
  findActiveDesignReferenceGate: vi.fn(async () => ({ status: 'none' })),
}));

import { hashToken } from '@/lib/api-auth';
import { GET } from '@/app/api/design-references/active/route';

// Every agent's gate hook calls this route before each shell command and file edit and treats ANY HTTP error as "locked".
// On 19 Oct 2026 the desktop's address was locked for 15 minutes after five unknown tokens and the route answered a bare 401 for it.
const TOKEN = 'dvf_test_token_for_the_active_gate_route';
const EXTERNAL = '203.0.113.9';
const PEER = '100.64.20.20';
const url = 'http://devflow.test/api/design-references/active?workspacePath=/home/user/SG-1/Team/Probe';
const call = (ip: string, token = TOKEN) => GET(new NextRequest(url, { headers: { 'x-forwarded-for': ip, authorization: `Bearer ${token}` } }));

function seed(opts: { scope?: 'read' | 'write' | 'admin'; lockedIp?: string; requestCount?: number } = {}) {
  const now = Date.now();
  store.data = {
    tokens: [{ id: 't1', name: 'Gate token', tokenHash: hashToken(TOKEN), scope: opts.scope ?? 'read', createdAt: new Date().toISOString(), usageCount: 0 }],
    config: { maxTokensPerUser: 10, defaultExpiration: 0, requireExpiration: false, rateLimitWindow: 60, rateLimitMax: 100 },
    rateLimits: opts.requestCount === undefined ? {} : { [hashToken(TOKEN)]: { windowStart: now - 10_000, requestCount: opts.requestCount } },
    failedAttempts: opts.lockedIp ? { [opts.lockedIp]: { count: 5, firstAttempt: now - 60_000, lastAttempt: now - 60_000 } } : {},
    lastUpdated: new Date().toISOString(),
  };
}

describe('GET /api/design-references/active tells a locked or throttled caller so', () => {
  let before: string | undefined;
  beforeEach(() => { before = process.env.DEVFLOW_TRUST_TAILNET; process.env.DEVFLOW_TRUST_TAILNET = '1'; seed(); });
  afterEach(() => { if (before === undefined) delete process.env.DEVFLOW_TRUST_TAILNET; else process.env.DEVFLOW_TRUST_TAILNET = before; });

  it('answers a good token 200 with the gate state', async () => {
    const response = await call(EXTERNAL);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'none' });
  });

  it('answers a locked outside address 429 with Retry-After, not 401', async () => {
    seed({ lockedIp: EXTERNAL });
    const response = await call(EXTERNAL);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(800);
    expect(await response.json()).toMatchObject({ success: false, code: 'RATE_LIMITED' });
  });

  it('answers a token over its rate limit 429 with Retry-After, not 401', async () => {
    seed({ requestCount: 100 });
    const response = await call(EXTERNAL);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('still answers an unknown token, or none at all, 401', async () => {
    expect((await call(EXTERNAL, 'dvf_test_not_a_real_token')).status).toBe(401);
    expect((await GET(new NextRequest(url, { headers: { 'x-forwarded-for': EXTERNAL } }))).status).toBe(401);
  });

  it('never gives the gate state to a token record whose scope is not a known one', async () => {
    seed({ scope: 'none' as never });                       // every real scope satisfies "read"; only a damaged record can fail it
    expect((await call(EXTERNAL)).status).toBe(401);
  });

  it('answers a trusted peer\'s unknown token 401 and never locks it, however many it sends', async () => {
    for (let i = 0; i < 8; i++) expect((await call(PEER, `dvf_test_unknown_from_the_peer_${i}`)).status).toBe(401);
    expect((await call(PEER)).status).toBe(200);
  });

  it('answers 200 for the desktop even with the lock that was recorded against it on 19 Oct', async () => {
    seed({ lockedIp: PEER });
    expect((await call(PEER)).status).toBe(200);
  });
});
