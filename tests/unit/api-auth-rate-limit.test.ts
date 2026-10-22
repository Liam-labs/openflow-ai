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

import { hashToken, requireAuthOrLocal, requireTokenOrLocal, validateApiToken } from '@/lib/api-auth';

const TOKEN = 'dvf_test_token_for_the_rate_limit_suite';
const EXTERNAL = '203.0.113.9';      // not this machine, not a tailnet peer: so no localhost pass-through
const request = (headers: Record<string, string> = {}) =>
  new NextRequest('http://devflow.test/api/anything', { headers: { 'x-forwarded-for': EXTERNAL, ...headers } });
const withToken = (token = TOKEN) => request({ authorization: `Bearer ${token}` });

function seed(opts: { windowStartMsAgo?: number; requestCount?: number; max?: number; failedFromIp?: { count: number; lastMsAgo: number } } = {}) {
  const now = Date.now();
  store.data = {
    tokens: [{ id: 't1', name: 'Agent token', tokenHash: hashToken(TOKEN), scope: 'admin', createdAt: new Date().toISOString(), usageCount: 0 }],
    config: { maxTokensPerUser: 10, defaultExpiration: 0, requireExpiration: false, rateLimitWindow: 60, rateLimitMax: opts.max ?? 100 },
    rateLimits: opts.requestCount === undefined ? {} : { [hashToken(TOKEN)]: { windowStart: now - (opts.windowStartMsAgo ?? 10_000), requestCount: opts.requestCount } },
    failedAttempts: opts.failedFromIp ? { [EXTERNAL]: { count: opts.failedFromIp.count, firstAttempt: now - opts.failedFromIp.lastMsAgo, lastAttempt: now - opts.failedFromIp.lastMsAgo } } : {},
    lastUpdated: new Date().toISOString(),
  };
}

describe('a token that is over its rate limit is told so, not told it is invalid', () => {
  beforeEach(() => seed());

  it('answers 429 with Retry-After and the RATE_LIMITED code (this was a plain 401 until 18 Oct 2026)', async () => {
    seed({ requestCount: 100, windowStartMsAgo: 20_000 });
    for (const gate of [requireAuthOrLocal, requireTokenOrLocal]) {
      const response = await gate(withToken(), 'read');
      expect(response?.status).toBe(429);
      expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThanOrEqual(39);
      expect(Number(response?.headers.get('Retry-After'))).toBeLessThanOrEqual(41);
      expect(await response?.json()).toMatchObject({ success: false, code: 'RATE_LIMITED', data: { retryAfter: expect.any(Number) } });
    }
  });

  it('lets the token through again once its window has passed', async () => {
    seed({ requestCount: 100, windowStartMsAgo: 61_000 });
    expect(await requireAuthOrLocal(withToken(), 'read')).toBeNull();
  });

  it('lets it through while under the limit, and the limit is whatever the config says', async () => {
    seed({ requestCount: 99 });
    expect(await requireAuthOrLocal(withToken(), 'read')).toBeNull();
    seed({ requestCount: 500, max: 3000 });
    expect(await requireAuthOrLocal(withToken(), 'read')).toBeNull();
  });

  it('tells an address blocked for repeated failures to wait, and says for how long', async () => {
    seed({ failedFromIp: { count: 5, lastMsAgo: 60_000 } });
    const response = await requireAuthOrLocal(withToken(), 'read');
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThan(800);   // 15 minutes less the minute already served
  });

  it('still answers 401 for a missing, malformed or revoked token', async () => {
    seed({ requestCount: 100 });
    expect((await requireAuthOrLocal(request(), 'read'))?.status).toBe(401);
    expect((await requireAuthOrLocal(withToken('not-a-dvf-token'), 'read'))?.status).toBe(401);
    expect((await requireAuthOrLocal(withToken('dvf_some_other_token'), 'read'))?.status).toBe(401);
  });

  it('keeps the localhost pass-through: a rate-limited token on this machine is still allowed', async () => {
    seed({ requestCount: 100 });
    const local = new NextRequest('http://localhost/api/anything', { headers: { authorization: `Bearer ${TOKEN}` } });   // no proxy header
    expect(await requireAuthOrLocal(local, 'read')).toBeNull();
  });
});

// 19 Oct 2026, 09:37:14Z: five unknown tokens reached DevFlow from the desktop in one second. The whole desktop fleet arrives from that one
// tailnet address, so DevFlow's lock refused every token-checked request from it for 15 minutes: every agent's gate hook (shell and file
// edits), and Riley's posts. Addresses the server trusts must never be locked out by bad tokens; outside addresses still are.
// Every test uses its own addresses: the rejected-token log is throttled per address for the whole process, so a shared address would make
// the tests depend on their order.
describe('an address this server trusts is not locked out by unknown tokens', () => {
  const request = (ip: string | null, token: string, extra: Record<string, string> = {}) =>
    new NextRequest('http://devflow.test/api/anything', { headers: { ...(ip ? { 'x-forwarded-for': ip } : {}), authorization: `Bearer ${token}`, ...extra } });
  const failed = () => (store.data as { failedAttempts: Record<string, { count: number }> }).failedAttempts;
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  const linesAbout = (warn: ReturnType<typeof quiet>, needle: string) => warn.mock.calls.map(call => String(call[0])).filter(line => line.includes(needle));
  let before: string | undefined;
  beforeEach(() => { before = process.env.DEVFLOW_TRUST_TAILNET; process.env.DEVFLOW_TRUST_TAILNET = '1'; seed(); });
  afterEach(() => {
    if (before === undefined) delete process.env.DEVFLOW_TRUST_TAILNET; else process.env.DEVFLOW_TRUST_TAILNET = before;
    vi.useRealTimers(); vi.restoreAllMocks();
  });

  it('answers invalid, never rate-limited, for any number of unknown tokens from a tailnet peer, and counts none of them', async () => {
    quiet();
    for (let i = 0; i < 8; i++) {
      expect(await validateApiToken(request('100.64.20.1', `dvf_live_peer_unknown_${i}`))).toMatchObject({ valid: false, code: 'AUTH_INVALID' });
    }
    expect(failed()).toEqual({});
    expect((await validateApiToken(request('100.64.20.1', TOKEN))).valid).toBe(true);
  });

  it('does not refuse a good token because a lock was already recorded against the peer (the state found on 19 Oct)', async () => {
    const now = Date.now();
    failed()['100.64.20.2'] = { count: 5, firstAttempt: now - 1000, lastAttempt: now - 1000 } as never;
    expect((await validateApiToken(request('100.64.20.2', TOKEN))).valid).toBe(true);
  });

  it('treats a direct localhost connection (no proxy header) the same way', async () => {
    quiet();
    for (let i = 0; i < 6; i++) await validateApiToken(request(null, `dvf_live_local_unknown_${i}`));
    expect(failed()).toEqual({});
    expect((await validateApiToken(request(null, TOKEN))).valid).toBe(true);
  });

  it('still locks an outside address after five unknown tokens, and then refuses even its good token', async () => {
    quiet();
    for (let i = 0; i < 5; i++) await validateApiToken(request('203.0.113.21', `dvf_live_outside_unknown_${i}`));
    expect(failed()['203.0.113.21'].count).toBe(5);
    expect(await validateApiToken(request('203.0.113.21', TOKEN))).toMatchObject({ valid: false, code: 'RATE_LIMITED' });
  });

  it('trusts a tailnet peer only while DEVFLOW_TRUST_TAILNET=1', async () => {
    quiet();
    delete process.env.DEVFLOW_TRUST_TAILNET;
    for (let i = 0; i < 5; i++) await validateApiToken(request('100.64.20.3', `dvf_live_untrusted_peer_${i}`));
    expect(failed()['100.64.20.3'].count).toBe(5);
    expect(await validateApiToken(request('100.64.20.3', TOKEN))).toMatchObject({ valid: false, code: 'RATE_LIMITED' });
  });

  it('decides trust from the address it counts: an X-Real-IP naming an outside address, with no X-Forwarded-For, is counted and locked', async () => {
    quiet();
    const viaRealIp = (token: string) => request(null, token, { 'x-real-ip': '203.0.113.22' });   // isLocalRequest alone called this "local"
    for (let i = 0; i < 5; i++) await validateApiToken(viaRealIp(`dvf_live_real_ip_${i}`));
    expect(failed()['203.0.113.22'].count).toBe(5);
    expect(await validateApiToken(viaRealIp(TOKEN))).toMatchObject({ valid: false, code: 'RATE_LIMITED' });
  });

  it('trusts an IPv4-mapped tailnet address, and takes the LAST X-Forwarded-For value (added by the nearest proxy) as the caller', async () => {
    quiet();
    for (let i = 0; i < 6; i++) await validateApiToken(request('::ffff:100.64.20.4', `dvf_live_mapped_${i}`));
    expect(failed()).toEqual({});
    for (let i = 0; i < 5; i++) await validateApiToken(request('100.64.20.5, 203.0.113.23', `dvf_live_chain_${i}`));
    expect(failed()['203.0.113.23'].count).toBe(5);
    expect(failed()['100.64.20.5']).toBeUndefined();
  });

  it('logs each unknown token once per sender with address, route, fingerprint and user agent, never the token', async () => {
    const warn = quiet();
    const same = 'dvf_live_logged_sender_one', other = 'dvf_live_logged_sender_two';
    const agent = { 'user-agent': 'probe-client/1.0' };
    await validateApiToken(request('100.64.20.6', same, agent));
    await validateApiToken(request('100.64.20.6', same, agent));          // the same sender again within 30 s: not logged again
    await validateApiToken(request('100.64.20.6', other, agent));
    const lines = linesAbout(warn, 'from 100.64.20.6 ');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('GET /api/anything');
    expect(lines[0]).toContain(hashToken(same).slice(0, 8));
    expect(lines[0]).toContain('trusted address, not counted');
    expect(lines[0]).toContain('user-agent "probe-client/1.0"');
    expect(lines.join('\n')).not.toContain(same);
    expect(lines.join('\n')).not.toContain(hashToken(same));     // the fingerprint is a short prefix, never the stored hash
  });

  it('logs the same sender again after 30 seconds, not before', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    const warn = quiet();
    const send = () => validateApiToken(request('100.64.20.7', 'dvf_live_thirty_seconds'));
    await send();
    vi.setSystemTime(new Date('2026-10-19T12:00:29Z')); await send();
    expect(linesAbout(warn, 'from 100.64.20.7 ')).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-19T12:00:31Z')); await send();
    expect(linesAbout(warn, 'from 100.64.20.7 ')).toHaveLength(2);
  });

  it('writes at most 20 lines a minute for one address, says so once, and resumes in the next minute', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T13:00:00Z'));
    const warn = quiet();
    for (let i = 0; i < 25; i++) await validateApiToken(request('100.64.20.8', `dvf_live_flood_${i}`));
    expect(linesAbout(warn, 'rejected tokens a minute from 100.64.20.8')).toHaveLength(1);
    expect(linesAbout(warn, 'unknown or revoked token from 100.64.20.8 ')).toHaveLength(20);
    vi.setSystemTime(new Date('2026-10-19T13:01:01Z'));
    await validateApiToken(request('100.64.20.8', 'dvf_live_flood_next_minute'));
    expect(linesAbout(warn, 'unknown or revoked token from 100.64.20.8 ')).toHaveLength(21);
  });

  it('forgets the oldest senders when it is full, not everyone at once', async () => {
    const warn = quiet();
    const sender = (i: number) => request(`100.64.${40 + (i >> 8)}.${i & 255}`, `dvf_live_cap_${i}`);
    for (let i = 0; i < 502; i++) await validateApiToken(sender(i));
    const logged = () => warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('fingerprint')).length;
    const afterFill = logged();
    await validateApiToken(sender(501));            // newest: still remembered, inside its 30 s
    await validateApiToken(sender(300));            // one in the middle: still remembered too (only the oldest are dropped, not everyone)
    expect(logged()).toBe(afterFill);
    await validateApiToken(sender(0));              // oldest: dropped to make room, so it is logged again
    expect(logged()).toBe(afterFill + 1);
  });

  it('bounds the per-address budgets as well: the oldest address is forgotten once 500 others have been logged', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T14:00:00Z'));
    const warn = quiet();
    for (let i = 0; i < 22; i++) await validateApiToken(request('100.64.60.1', `dvf_live_budget_${i}`));      // 20 lines, then it is cut off
    expect(linesAbout(warn, 'from 100.64.60.1 ')).toHaveLength(20);
    for (let i = 0; i < 501; i++) await validateApiToken(request(`100.64.${61 + (i >> 8)}.${i & 255}`, `dvf_live_crowd_${i}`));
    await validateApiToken(request('100.64.60.1', 'dvf_live_budget_again'));
    expect(linesAbout(warn, 'from 100.64.60.1 ')).toHaveLength(21);   // its used-up budget went with the oldest entries, so memory stays bounded
  });

  it('writes caller-controlled header text as one capped, printable line', async () => {
    const warn = quiet();
    const agent = 'café\tclient/' + 'x'.repeat(200);
    await validateApiToken(request('100.64.20.9', 'dvf_live_header_text', { 'user-agent': agent }));
    const line = linesAbout(warn, 'from 100.64.20.9 ')[0];
    expect(line).toContain('user-agent "caf??client/xxx');     // the accent and the tab are not printable ASCII
    expect(line).not.toContain('x'.repeat(60));
    expect(line).not.toMatch(/[^\x20-\x7e]/);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('logs a malformed token (no dvf_ prefix) but never counts it', async () => {
    const warn = quiet();
    for (let i = 0; i < 8; i++) expect(await validateApiToken(request('203.0.113.24', `not_a_dvf_token_${i}`))).toMatchObject({ valid: false, code: 'AUTH_INVALID' });
    expect(failed()).toEqual({});
    const lines = linesAbout(warn, 'from 203.0.113.24 ');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('malformed token (no dvf_ prefix)');
    expect(lines[0]).toContain('length 17,');
    expect(lines.join('\n')).not.toContain('not_a_dvf_token_');
  });

  it('writes no fingerprint for a malformed token: a password sent by mistake must not be checkable against the log', async () => {
    const warn = quiet();
    const password = 'Summer2026!';
    await validateApiToken(request('203.0.113.27', password));
    const line = linesAbout(warn, 'from 203.0.113.27 ')[0];
    expect(line).toContain('length 11,');
    expect(line).not.toContain('fingerprint');
    for (const length of [4, 6, 8]) expect(line).not.toContain(hashToken(password).slice(0, length));
    expect(line).not.toContain(password);
  });

  it('caps the path it writes, so a long URL cannot fill the log', async () => {
    const warn = quiet();
    const long = new NextRequest(`http://devflow.test/api/${'p'.repeat(400)}`, { headers: { 'x-forwarded-for': '100.64.20.10', authorization: 'Bearer dvf_live_long_path' } });
    await validateApiToken(long);
    const line = linesAbout(warn, 'from 100.64.20.10 ')[0];
    expect(line).toContain(`GET /api/${'p'.repeat(100)}`);
    expect(line).not.toContain('p'.repeat(116));        // 120 characters of path in all: "/api/" and 115 p
  });

  it('counts a revoked token against an outside address and not against a trusted one', async () => {
    quiet();
    (store.data as { tokens: Array<{ revokedAt?: string }> }).tokens[0].revokedAt = new Date().toISOString();
    for (let i = 0; i < 3; i++) expect(await validateApiToken(request('203.0.113.28', TOKEN))).toMatchObject({ valid: false, code: 'AUTH_INVALID' });
    expect(failed()['203.0.113.28'].count).toBe(3);
    for (let i = 0; i < 6; i++) expect(await validateApiToken(request('100.64.20.11', TOKEN))).toMatchObject({ valid: false, code: 'AUTH_INVALID' });
    expect(failed()['100.64.20.11']).toBeUndefined();
  });

  it('keeps logging what a locked outside address keeps sending', async () => {
    const warn = quiet();
    for (let i = 0; i < 5; i++) await validateApiToken(request('203.0.113.25', `dvf_live_before_lock_${i}`));
    await validateApiToken(request('203.0.113.25', 'dvf_live_while_locked'));
    expect(linesAbout(warn, 'token from a locked address from 203.0.113.25')).toHaveLength(1);
  });

  it('says so once when an outside address becomes locked', async () => {
    const warn = quiet();
    for (let i = 0; i < 6; i++) await validateApiToken(request('203.0.113.26', `dvf_live_lock_announce_${i}`));
    const locks = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('203.0.113.26 is locked out for 15 minutes'));
    expect(locks).toHaveLength(1);
  });

  // The lock is "five unknown tokens IN A ROW". Failures that merely add up (a stale token every ten minutes, between any number of good
  // requests) used to lock an address after about 40 minutes (found by an independent review, 19 Oct 2026).
  it('ends the run of failures when the address sends a good token, and only that address\'s run', async () => {
    quiet();
    for (let i = 0; i < 4; i++) await validateApiToken(request('203.0.113.29', `dvf_live_before_good_${i}`));
    for (let i = 0; i < 3; i++) await validateApiToken(request('203.0.113.31', `dvf_live_neighbour_${i}`));
    expect(failed()['203.0.113.29'].count).toBe(4);
    expect((await validateApiToken(request('203.0.113.29', TOKEN))).valid).toBe(true);
    expect(failed()['203.0.113.29']).toBeUndefined();
    expect(failed()['203.0.113.31'].count).toBe(3);                 // another address's failures are not touched
    for (let i = 0; i < 4; i++) await validateApiToken(request('203.0.113.29', `dvf_live_after_good_${i}`));
    expect((await validateApiToken(request('203.0.113.29', TOKEN))).valid).toBe(true);        // eight failures in all, never five in a row
  });

  it('still locks at five in a row after a good token', async () => {
    quiet();
    await validateApiToken(request('203.0.113.30', 'dvf_live_run_one'));
    expect((await validateApiToken(request('203.0.113.30', TOKEN))).valid).toBe(true);
    for (let i = 0; i < 5; i++) await validateApiToken(request('203.0.113.30', `dvf_live_run_two_${i}`));
    expect(await validateApiToken(request('203.0.113.30', TOKEN))).toMatchObject({ valid: false, code: 'RATE_LIMITED' });
  });

  it('clears a stale record kept against a trusted address when it next sends a good token', async () => {
    const now = Date.now();
    failed()['100.64.20.12'] = { count: 5, firstAttempt: now - 1000, lastAttempt: now - 1000 } as never;
    expect((await validateApiToken(request('100.64.20.12', TOKEN))).valid).toBe(true);
    expect(failed()['100.64.20.12']).toBeUndefined();
  });
});
