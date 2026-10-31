import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

/** Run the middleware with a fake server answering /api/setup/status and /api/auth/gate. */
async function run(opts: { setupComplete?: boolean; gate?: unknown; gateStatus?: number; gateThrows?: boolean; url?: string; headers?: Record<string, string> }) {
  vi.resetModules();
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: HeadersInit }) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.endsWith('/api/setup/status')) return new Response(JSON.stringify({ setupComplete: opts.setupComplete ?? true }), { status: 200 });
    if (opts.gateThrows) throw new Error('down');
    return new Response(JSON.stringify(opts.gate ?? { allow: true }), { status: opts.gateStatus ?? 200 });
  }));
  const { middleware } = await import('@/middleware');
  const request = new NextRequest(opts.url ?? 'http://localhost:3000/operations?tab=x', { headers: { host: 'localhost:3000', ...(opts.headers ?? {}) } });
  const response = await middleware(request);
  return { response, calls };
}

describe('middleware: who may see the pages', () => {
  it('lets a caller the gate allows through', async () => {
    const { response } = await run({ gate: { allow: true } });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('sends a caller the gate refuses to /login on the address it used, remembering the page', async () => {
    const { response } = await run({ gate: { allow: false }, headers: { host: 'my-box.example.ts.net' } });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://my-box.example.ts.net/login?next=%2Foperations%3Ftab%3Dx');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps https when the proxy says so, and does not add ?next for the home page', async () => {
    const { response } = await run({ gate: { allow: false }, url: 'http://localhost:3000/', headers: { host: 'x.example.net', 'x-forwarded-proto': 'https' } });
    expect(response.headers.get('location')).toBe('https://x.example.net/login');
  });

  it('does not trust a Host header that is not a host name', async () => {
    const { response } = await run({ gate: { allow: false }, headers: { host: 'evil.example/@x' } });
    expect(response.headers.get('location')).toMatch(/^http:\/\/localhost:3000\/login/);
  });

  it('hands the caller\'s own cookie, host and proxy address to the gate, nothing else', async () => {
    const { calls } = await run({ headers: { cookie: 'devflow_session=abc', 'x-forwarded-for': '203.0.113.9', origin: 'http://localhost:3000', authorization: 'Bearer dvf_secret', 'x-tunnel-auth': 't', 'tailscale-user-login': 'me@example.com' } });
    const gate = calls.find((c) => c.url.endsWith('/api/auth/gate'))!;
    expect(gate.headers.cookie).toBe('devflow_session=abc');
    expect(gate.headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(gate.headers['x-tunnel-auth']).toBe('t');
    expect(gate.headers['tailscale-user-login']).toBe('me@example.com');
    expect(gate.headers.authorization).toBeUndefined();
    expect(gate.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it.each([
    ['the gate is down', { gateThrows: true }],
    ['the gate answers something unexpected', { gate: {} }],
    ['the gate answers an error', { gateStatus: 500, gate: { error: 'x' } }],
  ])('lets the page load when %s (the API refuses on its own)', async (_name, opts) => {
    const { response } = await run(opts);
    expect(response.status).toBe(200);
  });

  it('before first-run setup everyone goes to /setup, as before', async () => {
    const { response } = await run({ setupComplete: false });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/setup');
  });

  it('before setup the redirect keeps the address and port the caller used, not the server\'s own idea of them', async () => {
    const { response } = await run({ setupComplete: false, url: 'http://localhost:3000/', headers: { host: 'localhost:39230' } });
    expect(response.headers.get('location')).toBe('http://localhost:39230/setup');
    const proxied = await run({ setupComplete: false, url: 'http://localhost:3000/ops', headers: { host: 'box.example.net', 'x-forwarded-proto': 'https' } });
    expect(proxied.response.headers.get('location')).toBe('https://box.example.net/setup');
  });

  it('before setup a Host header that does not look like a host falls back to the server\'s own address', async () => {
    const { response } = await run({ setupComplete: false, headers: { host: 'a b/evil' } });
    expect(new URL(response.headers.get('location')!).host).toBe('localhost:3000');
  });

  it('the matcher leaves /login, /setup, the API and static files alone', async () => {
    const { config } = await import('@/middleware');
    const re = new RegExp('^' + config.matcher[0] + '$');
    for (const p of ['/', '/operations', '/chat/x']) expect(re.test(p)).toBe(true);
    for (const p of ['/login', '/setup', '/api/auth/login', '/_next/static/x', '/favicon.ico', '/logo.png']) expect(re.test(p)).toBe(false);
  });
});
