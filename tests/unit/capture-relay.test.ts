import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); }, get apiTokens() { return path.join(dir, 'api-tokens.json'); }, get remoteAccess() { return path.join(dir, 'remote-access.json'); } } }));

const STAMP = Symbol.for('openflow.peerStampActive');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function req(url: string, init: { method?: string; body?: unknown; raw?: Buffer; token?: string; peer?: string } = {}) {
  const peer = init.peer ?? '127.0.0.1';
  const headers: Record<string, string> = { host: 'localhost:3000', 'content-type': init.raw ? 'image/jpeg' : 'application/json', 'x-openflow-peer': peer, 'x-openflow-http-version': '1.1' };
  if (peer !== '127.0.0.1') headers['x-forwarded-for'] = peer;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const body = init.raw ? new Uint8Array(init.raw) : init.body !== undefined ? JSON.stringify(init.body) : undefined;
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? 'GET', headers, ...(body ? { body } : {}) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function enrol(name = 'Surface Book') {
  const mint = await import('@/app/api/capture/enrol-code/route');
  const { code } = await (await mint.POST(req('/api/capture/enrol-code', { method: 'POST' }))).json();
  const ex = await import('@/app/api/capture/enroll/route');
  return (await (await ex.POST(req('/api/capture/enroll', { method: 'POST', body: { code, name } }))).json()) as { deviceId: string; token: string };
}
async function poll(token: string) {
  const { GET } = await import('@/app/api/capture/agent/poll/route');
  return GET(req('/api/capture/agent/poll', { token }));
}
async function capture(id: string, body: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/capture/devices/[id]/capture/route');
  return POST(req(`/api/capture/devices/${id}/capture`, { method: 'POST', body }), ctx(id));
}
async function answer(token: string, job: string, state: string, raw?: Buffer) {
  const { POST } = await import('@/app/api/capture/agent/result/route');
  return POST(req(`/api/capture/agent/result?job=${job}&state=${state}`, { method: 'POST', token, ...(raw ? { raw } : { body: {} }) }));
}
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  vi.resetModules();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-relay-'));
  for (const name of ['DEVFLOW_BIND_HOST', 'DEVFLOW_REQUIRE_TOKEN', 'DEVFLOW_ORIGIN_CHECK']) vi.stubEnv(name, '');
  (globalThis as Record<symbol, unknown>)[STAMP] = true;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('openflow.captureHub')];
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[STAMP];
  await fs.rm(dir, { recursive: true, force: true });
});

describe('taking a screenshot through the server', () => {
  it('hands the request to the polling device and returns its JPEG, logging who asked and the size but not the picture', async () => {
    const a = await enrol();
    const waiting = poll(a.token);
    await settle();
    const asked = capture(a.deviceId, { requester: 'Jack', scale: 0.4 });
    const p = await waiting;
    const { job } = await p.json();
    expect(job.params).toMatchObject({ scale: 0.4, quality: 75, monitor: 0 });
    expect((await answer(a.token, job.id, 'ok', JPEG)).status).toBe(200);
    const res = await asked;
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG)).toBe(true);
    const log = await fs.readFile(path.join(dir, 'capture-log.jsonl'), 'utf8');
    expect(log).toContain('"requester":"Jack"');
    expect(log).toContain(`"bytes":${JPEG.length}`);
    expect(log).not.toContain('/9j/');
  });
  it('says offline at once for a device that is not polling', async () => {
    const a = await enrol();
    const r = await capture(a.deviceId);
    expect(await r.json()).toMatchObject({ state: 'offline' });
  });
  it('says offline when the device was seen but does not pick the job up in time', async () => {
    const dev = await import('@/lib/capture/jobs');
    const device = { id: 'dev-x', name: 'Slow', platform: 'windows', tokenHash: 'h', createdAt: new Date().toISOString(), paused: false };
    await dev.nextJob(device.id, 1);                             // seen just now, not holding
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asked = dev.requestCapture(device, 'owner');
    await vi.advanceTimersByTimeAsync(dev.ACK_MS + 100);
    expect(await asked).toMatchObject({ state: 'offline' });
  });
  it('does not queue anything for a paused device', async () => {
    const a = await enrol();
    const { PATCH } = await import('@/app/api/capture/devices/[id]/route');
    await PATCH(req(`/api/capture/devices/${a.deviceId}`, { method: 'PATCH', body: { paused: true } }), ctx(a.deviceId));
    const waiting = poll(a.token);
    await settle();
    expect(await (await capture(a.deviceId)).json()).toMatchObject({ state: 'paused' });
    const dev = await import('@/lib/capture/jobs');
    await dev.nextJob(a.deviceId, 1);                            // free the held poll
    await waiting;
  });
  it('passes a locked screen through with no picture', async () => {
    const a = await enrol();
    const waiting = poll(a.token);
    await settle();
    const asked = capture(a.deviceId);
    const { job } = await (await waiting).json();
    await answer(a.token, job.id, 'locked');
    expect(await (await asked).json()).toMatchObject({ state: 'locked' });
  });
  it('refuses a second request while one is running', async () => {
    const a = await enrol();
    const waiting = poll(a.token);
    await settle();
    const first = capture(a.deviceId);
    const { job } = await (await waiting).json();
    expect(await (await capture(a.deviceId)).json()).toMatchObject({ state: 'busy' });
    await answer(a.token, job.id, 'ok', JPEG);
    await first;
  });
  it('revoking a device ends its waiting request at once and refuses its next poll', async () => {
    const a = await enrol();
    const waiting = poll(a.token);
    await settle();
    const asked = capture(a.deviceId);
    await waiting;
    const { DELETE } = await import('@/app/api/capture/devices/[id]/route');
    await DELETE(req(`/api/capture/devices/${a.deviceId}`, { method: 'DELETE' }), ctx(a.deviceId));
    const res = await asked;
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ state: 'revoked' });
    expect((await poll(a.token)).status).toBe(401);
  });
  it('a device cannot answer another device\'s request', async () => {
    const a = await enrol('A');
    const b = await enrol('B');
    const waitingA = poll(a.token);
    const waitingB = poll(b.token);
    await settle();
    const asked = capture(a.deviceId);
    const { job } = await (await waitingA).json();
    expect((await answer(b.token, job.id, 'ok', JPEG)).status).toBe(404);
    await answer(a.token, job.id, 'locked');
    await asked;
    const dev = await import('@/lib/capture/jobs');
    await dev.nextJob(b.deviceId, 1);
    await waitingB;
  });
  it('rejects an outside caller asking for a screenshot, and keeps the clamp on odd settings', async () => {
    const a = await enrol();
    const { POST } = await import('@/app/api/capture/devices/[id]/capture/route');
    expect((await POST(req(`/api/capture/devices/${a.deviceId}/capture`, { method: 'POST', body: {}, peer: '203.0.113.9' }), ctx(a.deviceId))).status).toBe(401);
    const jobs = await import('@/lib/capture/jobs');
    expect(jobs.cleanParams({ monitor: -4, scale: 99, quality: 'x' })).toEqual({ monitor: 0, scale: 1, quality: 75 });
  });
});
