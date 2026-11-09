import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); }, get apiTokens() { return path.join(dir, 'api-tokens.json'); }, get remoteAccess() { return path.join(dir, 'remote-access.json'); } } }));

const STAMP = Symbol.for('openflow.peerStampActive');

function req(url: string, init: { method?: string; body?: unknown; peer?: string; token?: string } = {}) {
  const peer = init.peer ?? '127.0.0.1';
  const headers: Record<string, string> = { host: 'localhost:3000', 'content-type': 'application/json', 'x-openflow-peer': peer, 'x-openflow-http-version': '1.1' };
  if (peer !== '127.0.0.1') headers['x-forwarded-for'] = peer;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function enrol(name = 'Surface Book', peer?: string) {
  const mint = await import('@/app/api/capture/enrol-code/route');
  const { code } = await (await mint.POST(req('/api/capture/enrol-code', { method: 'POST' }))).json();
  const ex = await import('@/app/api/capture/enroll/route');
  const res = await ex.POST(req('/api/capture/enroll', { method: 'POST', body: { code, name, platform: 'windows' }, peer }));
  return { code, status: res.status, json: await res.json() };
}

beforeEach(async () => {
  vi.resetModules();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-'));
  for (const name of ['DEVFLOW_BIND_HOST', 'DEVFLOW_REQUIRE_TOKEN', 'DEVFLOW_ORIGIN_CHECK']) vi.stubEnv(name, '');
  (globalThis as Record<symbol, unknown>)[STAMP] = true;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[STAMP];
  await fs.rm(dir, { recursive: true, force: true });
});

describe('enrolment', () => {
  it('trades a one-time code for a token, once, and keeps only hashes on disk', async () => {
    const a = await enrol();
    expect(a.status).toBe(200);
    expect(a.json.token).toMatch(/^ofcap_/);
    const file = await fs.readFile(path.join(dir, 'capture-devices.json'), 'utf8');
    expect(file).not.toContain(a.json.token);
    expect(file).not.toContain(a.code.replace(/-/g, ''));
    const ex = await import('@/app/api/capture/enroll/route');
    const again = await ex.POST(req('/api/capture/enroll', { method: 'POST', body: { code: a.code, name: 'Second' } }));
    expect(again.status).toBe(400);
  });
  it('refuses an expired code', async () => {
    const dev = await import('@/lib/capture/devices');
    const { code } = await dev.mintEnrolCode(45, Date.now() - 46 * 60_000, path.join(dir, 'capture-devices.json'));
    const r = await dev.exchangeCode(code, 'x', 'windows', Date.now(), path.join(dir, 'capture-devices.json'));
    expect(r).toEqual({ ok: false, reason: 'bad_code' });
  });
  it('caps a code at 60 minutes', async () => {
    const dev = await import('@/lib/capture/devices');
    const now = Date.now();
    const { expiresAt } = await dev.mintEnrolCode(600, now, path.join(dir, 'capture-devices.json'));
    expect(Date.parse(expiresAt) - now).toBe(60 * 60_000);
  });
  it('needs the owner to mint a code: an outside caller gets 401', async () => {
    const mint = await import('@/app/api/capture/enrol-code/route');
    expect((await mint.POST(req('/api/capture/enrol-code', { method: 'POST', peer: '203.0.113.9' }))).status).toBe(401);
  });
  it('blocks a caller after 10 wrong codes', async () => {
    const ex = await import('@/app/api/capture/enroll/route');
    let last = 0;
    for (let i = 0; i < 11; i += 1) last = (await ex.POST(req('/api/capture/enroll', { method: 'POST', body: { code: 'WRONG-WRONG-WRNG' } }))).status;
    expect(last).toBe(429);
  });
  it('a reinstall under the same name retires the old token', async () => {
    const first = await enrol('Desk');
    const second = await enrol('Desk');
    const dev = await import('@/lib/capture/devices');
    expect(await dev.authenticateDevice(first.json.token)).toBeNull();
    expect(await dev.authenticateDevice(second.json.token)).not.toBeNull();
  });
});

describe('devices, revoke and the agent', () => {
  it('lists devices without any token or hash, and needs the owner', async () => {
    await enrol();
    const { GET } = await import('@/app/api/capture/devices/route');
    const text = JSON.stringify(await (await GET(req('/api/capture/devices'))).json());
    expect(text).toContain('Surface Book');
    expect(text).not.toMatch(/tokenHash|ofcap_/);
    expect((await GET(req('/api/capture/devices', { peer: '203.0.113.9' }))).status).toBe(401);
  });
  it('revoke refuses the device token from the very next request', async () => {
    const a = await enrol();
    const state = await import('@/app/api/capture/agent/state/route');
    expect((await state.GET(req('/api/capture/agent/state', { token: a.json.token }))).status).toBe(200);
    const { DELETE } = await import('@/app/api/capture/devices/[id]/route');
    expect((await DELETE(req(`/api/capture/devices/${a.json.deviceId}`, { method: 'DELETE' }), ctx(a.json.deviceId))).status).toBe(200);
    const after = await state.GET(req('/api/capture/agent/state', { token: a.json.token }));
    expect(after.status).toBe(401);
    expect((await after.json()).code).toBe('REVOKED');
  });
  it('a device token cannot manage devices, and one device cannot revoke another', async () => {
    const a = await enrol('A');
    const b = await enrol('B');
    const { DELETE } = await import('@/app/api/capture/devices/[id]/route');
    expect((await DELETE(req(`/api/capture/devices/${b.json.deviceId}`, { method: 'DELETE', token: a.json.token, peer: '203.0.113.9' }), ctx(b.json.deviceId))).status).toBe(401);
    const selfRevoke = await import('@/app/api/capture/agent/self-revoke/route');
    expect((await selfRevoke.POST(req('/api/capture/agent/self-revoke', { method: 'POST', token: a.json.token }))).status).toBe(200);
    const dev = await import('@/lib/capture/devices');
    expect(await dev.authenticateDevice(a.json.token)).toBeNull();
    expect(await dev.authenticateDevice(b.json.token)).not.toBeNull();
  });
  it('renames and pauses a device, and logs who did it without any token', async () => {
    const a = await enrol();
    const { PATCH } = await import('@/app/api/capture/devices/[id]/route');
    const r = await PATCH(req(`/api/capture/devices/${a.json.deviceId}`, { method: 'PATCH', body: { name: 'Kitchen laptop', paused: true } }), ctx(a.json.deviceId));
    expect((await r.json()).device).toMatchObject({ name: 'Kitchen laptop', paused: true });
    const state = await import('@/app/api/capture/agent/state/route');
    expect((await (await state.GET(req('/api/capture/agent/state', { token: a.json.token }))).json()).paused).toBe(true);
    const log = await import('@/app/api/capture/log/route');
    const body = await (await log.GET(req('/api/capture/log'))).json();
    expect(body.entries.map((e: { op: string }) => e.op)).toEqual(expect.arrayContaining(['enrol', 'rename', 'pause']));
    expect(JSON.stringify(body)).not.toContain(a.json.token);
  });
  it('refuses a malformed or unknown token', async () => {
    const dev = await import('@/lib/capture/devices');
    for (const t of [null, '', 'abc', 'ofcap_nope', 'x'.repeat(500)]) expect(await dev.authenticateDevice(t)).toBeNull();
  });
  it('keeps the log under its size cap by dropping the oldest half', async () => {
    const dev = await import('@/lib/capture/devices');
    const f = path.join(dir, 'l.jsonl');
    for (let i = 0; i < 60; i += 1) dev.appendLog({ op: 'capture', requester: `r${i}` }, Date.now(), f, 1500);
    expect((await fs.stat(f)).size).toBeLessThan(3000);
    expect(dev.readLog(1, f)[0].requester).toBe('r59');
  });
});
