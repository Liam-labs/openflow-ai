import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), run: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: mocks.auth }));
vi.mock('@/lib/api-tracking', () => ({ tracked: (_path: string, handler: unknown) => handler }));
vi.mock('@/lib/typesafe-release-watch-runtime', () => ({ runTypesafeReleaseWatch: mocks.run, WATCH_DIRECTORY: '/fixture' }));
vi.mock('@/lib/typesafe-release-watch', async original => ({ ...await original<typeof import('@/lib/typesafe-release-watch')>(), readWatchState: mocks.read }));
import { POST, GET } from '@/app/api/typesafe-release-watch/route';
const request = (body: unknown) => new NextRequest('http://localhost/api/typesafe-release-watch', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue(null); mocks.run.mockResolvedValue({ ok: true }); mocks.read.mockResolvedValue({ events: [] }); });
it('requires write authentication before fetching, delivering or parsing untrusted input', async () => {
  mocks.auth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
  expect((await POST(request({ action: 'check' }))).status).toBe(401); expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.auth.mock.calls[0][1]).toBe('write');
});
it.each([{ action: 'check', sources: ['http://internal'] }, { action: 'check', recipients: ['wrong'] }, { action: 'check', testKey: 'x' }, { action: 'test' }, { action: 'test', testKey: '../x' }, { action: 'unknown' }])('rejects caller overrides/malformed commands %j', async body => {
  expect((await POST(request(body))).status).toBe(400); expect(mocks.run).not.toHaveBeenCalled();
});
it('returns a failing HTTP status for fetch or delivery failure so curl and Scheduled Jobs fail', async () => {
  mocks.run.mockResolvedValue({ ok: false, pendingEvents: 1 });
  expect((await POST(request({ action: 'check' }))).status).toBe(503);
});
it('passes a bounded synthetic key and requires read authentication for evidence', async () => {
  expect((await POST(request({ action: 'test', testKey: 'one-test' }))).status).toBe(200); expect(mocks.run).toHaveBeenCalledWith('one-test');
  await GET(new NextRequest('http://localhost/api/typesafe-release-watch'));
  expect(mocks.auth.mock.calls.at(-1)?.[1]).toBe('read');
});
