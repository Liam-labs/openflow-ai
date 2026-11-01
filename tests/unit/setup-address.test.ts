import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

let dir: string;
const guard = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: guard }));
vi.mock('@/lib/data-paths', () => ({ DataPaths: { get appData() { return dir; } } }));
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'address-'));
  guard.mockResolvedValue(null);
  vi.stubEnv('DEVFLOW_SERVER_MODE', '1');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const request = () => new NextRequest('https://test.example/api/setup/address');

it('requires authentication before returning installer state', async () => {
  guard.mockResolvedValue(NextResponse.json({ error: 'Authentication required' }, { status: 401 }));
  const { GET } = await import('@/app/api/setup/address/route');
  expect((await GET(request())).status).toBe(401);
});

it('returns only the persisted public result and does not mutate it on reload', async () => {
  const saved = { url: 'https://calm-otter-4821.my.openflow-ai.com', state: 'ready', source: 'managed', privateKey: 'must-not-leak' };
  const file = path.join(dir, 'install-address.json');
  await fs.writeFile(file, JSON.stringify(saved));
  const before = await fs.stat(file);
  const { GET } = await import('@/app/api/setup/address/route');
  for (let i = 0; i < 2; i++) {
    const response = await GET(request());
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ serverMode: true, address: { url: saved.url, state: 'ready', source: 'managed' } });
  }
  expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
});

it('does not invent a ready address when installer state is missing or invalid', async () => {
  const { GET } = await import('@/app/api/setup/address/route');
  expect(await (await GET(request())).json()).toEqual({ serverMode: true, address: null });
  await fs.writeFile(path.join(dir, 'install-address.json'), JSON.stringify({ url: 'javascript:alert(1)', source: 'managed', state: 'ready' }));
  expect(await (await GET(request())).json()).toEqual({ serverMode: true, address: null });
});
