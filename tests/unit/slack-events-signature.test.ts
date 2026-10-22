import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

vi.mock('@/slack-integration/lib/slack-auth', () => ({ getSigningSecret: () => 'test-signing-secret', isSlackConfigured: () => true }));
vi.mock('@/slack-integration/lib/slack-bridge', () => ({ handleSlackEvent: vi.fn() }));
vi.mock('@/slack-integration/lib/slack-bridge-data', () => ({ readBridgeData: vi.fn() }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_route: string, handler: unknown) => handler }));

const BODY = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
const sign = (ts: string, body = BODY, secret = 'test-signing-secret') => 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
const now = () => String(Math.floor(Date.now() / 1000));

async function post(ts: string, signature: string, body = BODY) {
  const { POST } = await import('@/app/api/slack/events/route');
  return POST(new NextRequest('http://localhost:3000/api/slack/events', { method: 'POST', body, headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': signature } }));
}

describe('POST /api/slack/events signature check', () => {
  beforeEach(() => vi.resetModules());

  it('answers the challenge for a correctly signed, fresh request', async () => {
    const ts = now();
    const res = await post(ts, sign(ts));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });
  it('refuses a wrong signature, a wrong secret and a tampered body', async () => {
    const ts = now();
    expect((await post(ts, 'v0=' + '0'.repeat(64))).status).toBe(401);
    expect((await post(ts, sign(ts, BODY, 'another-secret'))).status).toBe(401);
    expect((await post(ts, sign(ts), BODY.replace('abc123', 'evil'))).status).toBe(401);
  });
  it('refuses an old timestamp and a future one, even when correctly signed', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 301);
    const future = String(Math.floor(Date.now() / 1000) + 301);
    expect((await post(old, sign(old))).status).toBe(401);
    expect((await post(future, sign(future))).status).toBe(401);
  });
  it.each(['abc', 'NaN', '1e9', '12.5', '-5', ' 123', '99999999999999999999', '0x10'])('refuses a timestamp that is not a whole number (%s), even when correctly signed', async (ts) => {
    expect((await post(ts, sign(ts))).status).toBe(401);
  });
  it('refuses missing headers', async () => {
    const { POST } = await import('@/app/api/slack/events/route');
    const res = await POST(new NextRequest('http://localhost:3000/api/slack/events', { method: 'POST', body: BODY }));
    expect(res.status).toBe(401);
  });
});
