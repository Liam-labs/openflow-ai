// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// The page gate asks this server's own /api/auth/gate. That call comes from the server itself, so the caller's real connection
// address (written by lib/peer-stamp.ts) has to travel along in the forwarded chain, or a spoofed header would read as local.
let gateHeaders: Headers | null;
beforeEach(() => {
  vi.resetModules();
  gateHeaders = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: HeadersInit }) => {
    if (String(url).endsWith('/api/setup/status')) return new Response(JSON.stringify({ setupComplete: true }), { status: 200 });
    gateHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ allow: true }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const page = (headers: Record<string, string>) => new NextRequest('http://localhost:3000/operations', { headers: { host: 'localhost:3000', ...headers } });
async function ask(headers: Record<string, string>) {
  const { middleware } = await import('@/middleware');
  await middleware(page(headers));
  return gateHeaders!;
}

describe('page gate forwards the real peer', () => {
  it('appends the connection address to what the caller wrote, so "127.0.0.1" from a LAN host is not local', async () => {
    const h = await ask({ 'x-forwarded-for': '127.0.0.1', 'x-openflow-peer': '192.168.50.7' });
    expect(h.get('x-forwarded-for')).toBe('127.0.0.1, 192.168.50.7');
  });
  it('uses the peer alone when the caller wrote no chain', async () => {
    const h = await ask({ 'x-openflow-peer': '203.0.113.9' });
    expect(h.get('x-forwarded-for')).toBe('203.0.113.9');
  });
  it('marks an HTTP/1.0 peer as a proxy', async () => {
    const h = await ask({ 'x-openflow-peer': '127.0.0.1', 'x-openflow-http-version': '1.0' });
    expect(h.get('via')).toBeTruthy();
    const plain = await ask({ 'x-openflow-peer': '127.0.0.1', 'x-openflow-http-version': '1.1' });
    expect(plain.get('via')).toBeNull();
  });
  it('still forwards the headers it forwarded before', async () => {
    const h = await ask({ cookie: 'a=b', origin: 'http://localhost:3000', 'x-openflow-peer': '127.0.0.1' });
    expect(h.get('cookie')).toBe('a=b');
    expect(h.get('origin')).toBe('http://localhost:3000');
  });
});
