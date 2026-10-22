import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let root: string;
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: async () => null }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_r: string, h: unknown) => h }));
vi.mock('@/lib/host-executor', () => ({ defaultHost: () => null, hostCall: vi.fn() }));
vi.mock('@/lib/data-io', () => ({
  readJsonFile: async () => ({ channels: [{ id: 'c1', name: 'Commander', projectPath: root, participants: [], messages: [], settings: {} }] }),
}));

const listRoute = await import('@/app/api/channel-tools/route');
const fileRoute = await import('@/app/api/channel-tools/file/[channelId]/[toolId]/[...path]/route');

const get = (url: string) => new NextRequest(`http://localhost:3000${url}`);
const fileCtx = (channelId: string, toolId: string, p: string[]) => ({ params: Promise.resolve({ channelId, toolId, path: p }) });

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-route-'));
  const app = path.join(root, 'channel-tools', 'app');
  await fs.mkdir(path.join(app, 'assets'), { recursive: true });
  await fs.writeFile(path.join(app, 'tool.json'), '{"name":"App","type":"html"}');
  await fs.writeFile(path.join(app, 'index.html'), '<h1>App</h1>');
  await fs.writeFile(path.join(app, 'assets', 'data.json'), '{"a":1}');
  await fs.writeFile(path.join(app, 'blob.bin'), 'x');
  await fs.writeFile(path.join(root, 'secret.txt'), 'secret');
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

describe('channel tools routes', () => {
  it('lists tools for a channel, and rejects a missing or unknown channel', async () => {
    const ok = await listRoute.GET(get('/api/channel-tools?channelId=c1'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, status: 'ok', tools: [{ id: 'app', launchPath: '/api/channel-tools/file/c1/app/index.html' }] });
    expect((await listRoute.GET(get('/api/channel-tools'))).status).toBe(400);
    expect((await listRoute.GET(get('/api/channel-tools?channelId=nope'))).status).toBe(404);
  });

  it('serves tool files with the right type and sandbox headers', async () => {
    const page = await fileRoute.GET(get('/x'), fileCtx('c1', 'app', ['index.html']));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<h1>App</h1>');
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(page.headers.get('content-security-policy')).not.toMatch(/allow-same-origin/);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const json = await fileRoute.GET(get('/x'), fileCtx('c1', 'app', ['assets', 'data.json']));
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const bin = await fileRoute.GET(get('/x'), fileCtx('c1', 'app', ['blob.bin']));
    expect(bin.headers.get('content-disposition')).toBe('attachment');
  });

  it('refuses traversal, dot-files, undeclared tools and unknown channels', async () => {
    for (const [tool, p] of [['app', ['..', '..', 'secret.txt']], ['app', ['%2e%2e', 'x']], ['app', ['.env']], ['app', ['tool.json', '..', '..', 'secret.txt']], ['ghost', ['index.html']], ['app', ['missing.html']]] as const) {
      const r = await fileRoute.GET(get('/x'), fileCtx('c1', tool, [...p]));
      expect(r.status, `${tool}/${p.join('/')}`).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect((await fileRoute.GET(get('/x'), fileCtx('nope', 'app', ['index.html']))).status).toBe(404);
  });
});

describe('effective CSP for served tool pages', () => {
  it('the config rule that wins over the global CSP sandboxes the page without allow-same-origin', async () => {
    const nextConfig = (await import('@/next.config')).default;
    const rules = await nextConfig.headers!();
    const csp = (r: { headers: { key: string; value: string }[] }) => r.headers.find(h => h.key === 'Content-Security-Policy')?.value;
    const globalIdx = rules.findIndex(r => r.source === '/(.*)' && csp(r));
    const toolIdx = rules.findIndex(r => r.source.startsWith('/api/channel-tools/file/'));
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(globalIdx); // later rule replaces the global CSP for this path
    const value = csp(rules[toolIdx])!;
    expect(value).toMatch(/(^|;\s*)sandbox\b/);
    expect(value).not.toContain('allow-same-origin');
  });
});
