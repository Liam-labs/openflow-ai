// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import https from 'https';
import net from 'net';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import { createRequire } from 'module';
import path from 'path';
import { HTTP_VERSION_HEADER, PEER_HEADER, installPeerStamp, peerStampActive, resetPeerStampForTests, stampRequest } from '@/lib/peer-stamp';

let dir: string;
vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get apiTokens() { return path.join(dir, 'api-tokens.json'); }, get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); }, get remoteAccess() { return path.join(dir, 'remote-access.json'); } } }));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peerstamp-'));
  for (const name of ['DEVFLOW_BIND_HOST', 'DEVFLOW_REQUIRE_TOKEN', 'DEVFLOW_TRUST_TAILNET', 'DEVFLOW_ORIGIN_CHECK']) vi.stubEnv(name, '');
  resetPeerStampForTests();
});
afterEach(async () => { resetPeerStampForTests(); vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });

describe('stampRequest', () => {
  it('writes the connection address and replaces whatever the caller sent', () => {
    const req = { headers: { [PEER_HEADER]: '127.0.0.1', [HTTP_VERSION_HEADER]: '1.1' } as Record<string, string>, socket: { remoteAddress: '203.0.113.9' }, httpVersion: '1.0' };
    stampRequest(req);
    expect(req.headers[PEER_HEADER]).toBe('203.0.113.9');
    expect(req.headers[HTTP_VERSION_HEADER]).toBe('1.0');
  });
  it('stamps an empty value, never leaves the caller\'s, when the socket has no address', () => {
    const req = { headers: { [PEER_HEADER]: '127.0.0.1' } as Record<string, string>, socket: {}, httpVersion: '1.1' };
    stampRequest(req);
    expect(req.headers[PEER_HEADER]).toBe('');
  });
});

describe('installPeerStamp on a real server', () => {
  it('ignores a request object that has no headers instead of throwing', () => {
    expect(() => stampRequest({} as never)).not.toThrow();
    expect(() => stampRequest(undefined as never)).not.toThrow();
  });
  it('stamps https servers and upgrade requests too', () => {
    installPeerStamp();
    for (const [server, event] of [[new https.Server(), 'request'], [new http.Server(), 'upgrade'], [new http.Server(), 'request']] as const) {
      const req = { headers: { [PEER_HEADER]: 'spoofed' } as Record<string, string>, socket: { remoteAddress: '203.0.113.5' }, httpVersion: '1.1' };
      server.on(event, () => {});
      server.emit(event, req, {});
      expect(req.headers[PEER_HEADER]).toBe('203.0.113.5');
    }
  });
  it('wraps emit once however often it is installed', () => {
    installPeerStamp();
    const wrapped = http.Server.prototype.emit;
    installPeerStamp();
    expect(http.Server.prototype.emit).toBe(wrapped);
  });
  it('sets the real peer on every request and drops a spoofed header, for HTTP/1.1 and HTTP/1.0', async () => {
    installPeerStamp();
    expect(peerStampActive()).toBe(true);
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = http.createServer((req, res) => { seen.push({ ...req.headers }); res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await new Promise<void>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, headers: { [PEER_HEADER]: '10.9.9.9', [HTTP_VERSION_HEADER]: '9.9' } }, (r) => { r.resume(); r.on('end', resolve); }).on('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write('GET / HTTP/1.0\r\nHost: x\r\n\r\n'));
        s.on('data', () => {}); s.on('end', resolve); s.on('error', reject);
      });
    } finally { server.close(); }
    expect(seen).toHaveLength(2);
    expect(seen[0][PEER_HEADER]).toBe('127.0.0.1');
    expect(seen[0][HTTP_VERSION_HEADER]).toBe('1.1');
    expect(seen[1][PEER_HEADER]).toBe('127.0.0.1');
    expect(seen[1][HTTP_VERSION_HEADER]).toBe('1.0');
  });
  it('is safe to install twice (one stamp per request)', async () => {
    installPeerStamp();
    installPeerStamp();
    let count = 0;
    const server = http.createServer((req, res) => { count += Array.isArray(req.headers[PEER_HEADER]) ? 2 : 1; res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await new Promise<void>((resolve) => http.get({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }, (r) => { r.resume(); r.on('end', resolve); }));
    } finally { server.close(); }
    expect(count).toBe(1);
  });
});

const req = (headers: Record<string, string> = {}) => new NextRequest('http://127.0.0.1:3000/api/x', { headers: { host: '127.0.0.1:3000', ...headers } });
const stamped = (peer: string, headers: Record<string, string> = {}, version = '1.1') => req({ [PEER_HEADER]: peer, [HTTP_VERSION_HEADER]: version, 'x-forwarded-for': peer, ...headers });

describe('isLocalRequest once the server stamps the real peer', () => {
  it('trusts a loopback peer, in every spelling', async () => {
    installPeerStamp();
    const { isLocalRequest } = await import('@/lib/api-auth');
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLocalRequest(stamped(peer))).toBe(true);
  });
  it('refuses a LAN caller who writes X-Forwarded-For: 127.0.0.1 (the header lies, the connection does not)', async () => {
    installPeerStamp();
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(stamped('192.168.50.7', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isLocalRequest(stamped('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isLocalRequest(stamped('203.0.113.9', { 'x-forwarded-for': '::1' }))).toBe(false);
  });
  it('refuses a request with no stamp or an empty one once stamping is on', async () => {
    installPeerStamp();
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(req({ 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isLocalRequest(stamped(''))).toBe(false);
  });
  it('refuses a loopback peer speaking HTTP/1.0: a plain proxy such as nginx in front of the app', async () => {
    installPeerStamp();
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(stamped('127.0.0.1', {}, '1.0'))).toBe(false);
    expect(isLocalRequest(stamped('127.0.0.1', {}, '1.1'))).toBe(true);
  });
  it.each(['x-real-ip', 'forwarded', 'via', 'x-forwarded-server', 'x-original-forwarded-for', 'true-client-ip', 'x-client-ip', 'tailscale-funnel-request'])('%s marks a proxy even from a loopback peer', async (header) => {
    installPeerStamp();
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(stamped('127.0.0.1', { [header]: 'x' }))).toBe(false);
  });
  it('trusts a tailnet peer only while DEVFLOW_TRUST_TAILNET=1', async () => {
    installPeerStamp();
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(stamped('100.64.1.2'))).toBe(false);
    vi.stubEnv('DEVFLOW_TRUST_TAILNET', '1');
    expect(isLocalRequest(stamped('100.64.1.2'))).toBe(true);
    expect(isLocalRequest(stamped('::ffff:100.100.1.1'))).toBe(true);
    expect(isLocalRequest(stamped('100.128.0.1'))).toBe(false);
    expect(isLocalRequest(stamped('100.64.1.2', { 'x-forwarded-for': '8.8.8.8, 100.64.1.2' }))).toBe(false);
  });
  it('a tailnet peer cannot vouch for an outside address in the chain, and an outside peer cannot vouch for a tailnet one', async () => {
    installPeerStamp();
    vi.stubEnv('DEVFLOW_TRUST_TAILNET', '1');
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(stamped('8.8.8.8', { 'x-forwarded-for': '100.64.1.2' }))).toBe(false);
  });
  it('still needs the token switch off, the loopback bind and a browser-safe Host', async () => {
    installPeerStamp();
    const { isLocalRequest } = await import('@/lib/api-auth');
    vi.stubEnv('DEVFLOW_REQUIRE_TOKEN', '1');
    expect(isLocalRequest(stamped('127.0.0.1'))).toBe(false);
    vi.stubEnv('DEVFLOW_REQUIRE_TOKEN', '');
    vi.stubEnv('DEVFLOW_BIND_HOST', '0.0.0.0');
    expect(isLocalRequest(stamped('127.0.0.1'))).toBe(false);
    vi.stubEnv('DEVFLOW_BIND_HOST', '');
    expect(isLocalRequest(stamped('127.0.0.1', { host: 'attacker.example' }))).toBe(false);
  });
});

describe('without stamping (tests and unusual runtimes) the old header rules still apply', () => {
  it('a direct request with no headers is local', async () => {
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(peerStampActive()).toBe(false);
    expect(isLocalRequest(req())).toBe(true);
  });
});

describe('the default gateway counts as this machine only on WSL', () => {
  async function loadWith(procVersion: string) {
    const nodeRequire = createRequire(import.meta.url);        // the CommonJS module objects api-auth.ts itself reads, which a spy can replace
    const cp = nodeRequire('child_process') as typeof import('child_process');
    const fsMod = nodeRequire('fs') as typeof import('fs');
    const realExec = cp.execSync;
    const realRead = fsMod.readFileSync;
    vi.spyOn(cp, 'execSync').mockImplementation(((cmd: string, ...rest: unknown[]) => (String(cmd).includes('ip route') ? '192.168.77.1\n' : (realExec as (...a: unknown[]) => unknown)(cmd, ...rest))) as never);
    vi.spyOn(fsMod, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => (file === '/proc/version' ? procVersion : (realRead as (...a: unknown[]) => unknown)(file, ...rest))) as never);
    vi.resetModules();
    installPeerStamp();
    return (await import('@/lib/api-auth')).isLocalRequest;
  }
  afterEach(() => { vi.restoreAllMocks(); });

  it('does not trust the router address on an ordinary Linux machine', async () => {
    const isLocalRequest = await loadWith('Linux version 6.8.0-generic (buildd@lcy02) #1 SMP');
    expect(isLocalRequest(stamped('192.168.77.1'))).toBe(false);
    expect(isLocalRequest(stamped('127.0.0.1'))).toBe(true);
  });
  it('trusts it on WSL, where the Windows browser arrives from the gateway', async () => {
    const isLocalRequest = await loadWith('Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x)');
    expect(isLocalRequest(stamped('192.168.77.1'))).toBe(true);
  });
});
