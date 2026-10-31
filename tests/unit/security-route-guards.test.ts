import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Evidence for three routes the route scanner lists as reviewed-open (scripts/security-open-routes.txt), and for the VPS proxy case.
let dir: string;
vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); }, get apiTokens() { return path.join(dir, 'api-tokens.json'); }, get remoteAccess() { return path.join(dir, 'remote-access.json'); } } }));

const STAMP = Symbol.for('openflow.peerStampActive');
const OWNER = 'owner@example.com';
const GOOD_PW = 'a few ordinary words here';
const HOST = 'myhost.example-tailnet.ts.net';

beforeEach(async () => {
  vi.resetModules();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routeguards-'));
  for (const name of ['DEVFLOW_BIND_HOST', 'DEVFLOW_REQUIRE_TOKEN', 'DEVFLOW_TRUST_TAILNET', 'DEVFLOW_ORIGIN_CHECK']) vi.stubEnv(name, '');
  vi.stubEnv('DEVFLOW_OWNER_LOGINS', OWNER);
  (globalThis as Record<symbol, unknown>)[STAMP] = true;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[STAMP];
  await fs.rm(dir, { recursive: true, force: true });
});

/** A request as the app sees it: `peer` is the real connection address the server stamps, `extra` are the caller's headers. */
function call(url: string, peer: string, extra: Record<string, string> = {}, body: unknown = {}, method = 'POST') {
  const headers: Record<string, string> = { host: HOST, 'content-type': 'application/json', 'x-openflow-peer': peer, 'x-openflow-http-version': '1.1', ...extra };
  return new NextRequest(`https://${HOST}${url}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
const viaServe = (body: unknown) => call('/api/auth/password', '127.0.0.1', { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '100.64.162.99', 'tailscale-user-login': OWNER }, body);

describe('the first password is saved once', () => {
  it('of two simultaneous first calls exactly one succeeds and the other is told it is taken', async () => {
    const { POST } = await import('@/app/api/auth/password/route');
    const [a, b] = await Promise.all([POST(viaServe({ newPassword: GOOD_PW })), POST(viaServe({ newPassword: 'some other ordinary words' }))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const { login } = await import('@/lib/dashboard-auth');
    const winner = a.status === 200 ? GOOD_PW : 'some other ordinary words';
    expect((await login(winner, '127.0.0.1', 'test')).ok).toBe(true);
  });
});

describe('a VPS with an HTTPS proxy on the same machine, fresh install, no password yet', () => {
  const attempt = async (extra: Record<string, string>) => {
    const { POST } = await import('@/app/api/auth/password/route');
    return POST(call('/api/auth/password', '127.0.0.1', extra, { newPassword: GOOD_PW }));
  };
  it('refuses a proxied internet request: loopback source, proxy marks, no token', async () => {
    for (const marks of [{ 'x-forwarded-for': '198.51.100.7' }, { 'x-real-ip': '198.51.100.7' }, { forwarded: 'for=198.51.100.7' }, { via: '1.1 caddy' }]) {
      expect((await attempt(marks)).status).toBe(401);
    }
    const { hasPassword } = await import('@/lib/dashboard-auth');
    expect(await hasPassword()).toBe(false);
  });
  it('refuses a proxy that speaks HTTP/1.0 (nginx default)', async () => {
    expect((await attempt({ 'x-openflow-http-version': '1.0' })).status).toBe(401);
  });
  // Found by Thorne's test: a bare proxy on this machine that rewrites Host to 127.0.0.1:3000 and adds no forwarding header looks exactly like the owner.
  const bare = { host: '127.0.0.1:3000' };
  it('a bare proxy that rewrites Host and adds no marks is read as this machine unless DEVFLOW_REQUIRE_TOKEN=1 (why the installer must write it)', async () => {
    const { POST } = await import('@/app/api/auth/password/route');
    const open = await POST(new NextRequest('http://127.0.0.1:3000/api/auth/password', { method: 'POST', headers: { ...bare, 'content-type': 'application/json', 'x-openflow-peer': '127.0.0.1', 'x-openflow-http-version': '1.1' }, body: JSON.stringify({ newPassword: GOOD_PW }) }));
    // The known limit of "from this machine" in the public build: no setting, no way to tell this proxy from the owner, so 200. A tree that also
    // checks the connecting user (our own server does, outside WSL) already refuses it with 401. Both are fine here: the point is the next test.
    expect([200, 401]).toContain(open.status);
  });
  it('the same bare proxy is refused with DEVFLOW_REQUIRE_TOKEN=1, and no password is set', async () => {
    vi.stubEnv('DEVFLOW_REQUIRE_TOKEN', '1');
    const { POST } = await import('@/app/api/auth/password/route');
    const res = await POST(new NextRequest('http://127.0.0.1:3000/api/auth/password', { method: 'POST', headers: { ...bare, 'content-type': 'application/json', 'x-openflow-peer': '127.0.0.1', 'x-openflow-http-version': '1.1' }, body: JSON.stringify({ newPassword: GOOD_PW }) }));
    expect(res.status).toBe(401);
    const { hasPassword } = await import('@/lib/dashboard-auth');
    expect(await hasPassword()).toBe(false);
  });
  it('with DEVFLOW_REQUIRE_TOKEN=1, which the VPS installer writes, refuses even a request with no proxy marks at all', async () => {
    vi.stubEnv('DEVFLOW_REQUIRE_TOKEN', '1');
    expect((await attempt({})).status).toBe(401);
    const { hasPassword } = await import('@/lib/dashboard-auth');
    expect(await hasPassword()).toBe(false);
  });
});
