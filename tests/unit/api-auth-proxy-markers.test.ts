import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get apiTokens() { return path.join(dir, 'api-tokens.json'); }, get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); }, get remoteAccess() { return path.join(dir, 'remote-access.json'); } } }));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxymark-'));
  for (const name of ['DEVFLOW_BIND_HOST', 'DEVFLOW_REQUIRE_TOKEN', 'DEVFLOW_TRUST_TAILNET', 'DEVFLOW_ORIGIN_CHECK']) vi.stubEnv(name, '');
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });

const req = (headers: Record<string, string> = {}) => new NextRequest('http://127.0.0.1:3000/api/x', { headers: { host: '127.0.0.1:3000', ...headers } });

describe('a proxy in front of the app is never "this machine"', () => {
  it('a plain direct request on this machine is local (control)', async () => {
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(req())).toBe(true);
    expect(isLocalRequest(req({ 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
  });
  it.each(['cf-connecting-ip', 'cf-ray', 'cf-access-jwt-assertion', 'tailscale-user-login'])('%s makes it not local, even with no X-Forwarded-For', async (header) => {
    const { isLocalRequest } = await import('@/lib/api-auth');
    expect(isLocalRequest(req({ [header]: 'x' }))).toBe(false);
    expect(isLocalRequest(req({ [header]: 'x', 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });
  it('hasProxyMarkers sees exactly those headers', async () => {
    const { hasProxyMarkers } = await import('@/lib/api-auth');
    const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });
    expect(hasProxyMarkers(h({}))).toBe(false);
    expect(hasProxyMarkers(h({ 'x-forwarded-for': '1.1.1.1' }))).toBe(false);
    expect(hasProxyMarkers(h({ 'cf-ray': '1' }))).toBe(true);
    expect(hasProxyMarkers(h({ 'cf-connecting-ip': '' }))).toBe(true);
  });
});
