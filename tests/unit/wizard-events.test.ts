import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ emit: vi.fn(), denied: false, enable: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: mocks.emit } }));
vi.mock('@/lib/api-auth', () => ({ requireTokenOrLocal: async () => mocks.denied ? Response.json({ error: 'Authentication required' }, { status: 401 }) : null }));
vi.mock('@/lib/dashboard-auth', () => ({ hasPassword: async () => true }));
vi.mock('@/lib/wizards/tailscale', () => ({
 gatherFacts: async () => ({ ips: [], serve: [], inContainer: false }), readRecord: async () => ({}),
 planServe: () => ({ ok: false }), recordMatches: () => false, judgeSecondDevice: () => null,
 enableTailscale: mocks.enable, disableTailscale: async () => ({ ok: true }), proveReachable: vi.fn(),
}));
vi.mock('@/lib/wizards/cloudflare-api', () => ({ CloudflareApi: vi.fn() }));
vi.mock('@/lib/wizards/cloudflare', () => ({ realIo: () => ({}), enableWebgate: vi.fn(), disableWebgate: vi.fn(), proveWebgate: vi.fn() }));
vi.mock('@/lib/wizards/cloudflare-service', () => ({ wizardState: async () => ({ stage: 'off' }), saveToken: mocks.save, readApiToken: async () => null, forgetToken: async () => ({ ok: true }) }));
vi.mock('@/lib/wizards/cloudflared-runner', () => ({ realRunner: {} }));
import { clearVisitsForTests, noteTailnetVisit, recentOtherDeviceVisits } from '../../lib/wizards/tailscale-visits';
import * as tailscale from '../../app/api/wizards/tailscale/route';
import * as cloudflare from '../../app/api/wizards/cloudflare/route';
const request = (wizard: string, action?: string) => new NextRequest(`http://localhost/api/wizards/${wizard}`, action ? { method: 'POST', body: JSON.stringify({ action, token: 'private-test-token' }) } : undefined);
beforeEach(() => { vi.clearAllMocks(); clearVisitsForTests(); mocks.denied = false; mocks.enable.mockResolvedValue({ ok: true }); mocks.save.mockResolvedValue({ ok: true }); });
describe('wizard state invalidation', () => {
 it('pushes second-device visits without exposing user, device or gate outcome', () => {
  noteTailnetVisit(new Headers({ 'x-forwarded-for': '100.64.1.7', 'tailscale-user-login': 'private@example.test' }), false);
  expect(recentOtherDeviceVisits([])).toHaveLength(1);
  expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('wizard:changed', { wizard: 'tailscale' });
 });
 it('ignores non-tailnet traffic', () => {
  noteTailnetVisit(new Headers({ 'x-forwarded-for': '203.0.113.3' }), true);
  expect(mocks.emit).not.toHaveBeenCalled();
 });
 it('does not emit on state reads, avoiding a refresh loop', async () => {
  await tailscale.GET(request('tailscale')); await cloudflare.GET(request('cloudflare'));
  expect(mocks.emit).not.toHaveBeenCalled();
 });
 it('notifies other screens after enabling or disabling Serve', async () => {
  await tailscale.POST(request('tailscale', 'enable')); await tailscale.POST(request('tailscale', 'disable'));
  expect(mocks.emit.mock.calls).toEqual([['wizard:changed', { wizard: 'tailscale' }], ['wizard:changed', { wizard: 'tailscale' }]]);
 });
 it('notifies after a partial failure so other screens reread actual state', async () => {
  mocks.enable.mockResolvedValue({ ok: false, error: 'failed' });
  expect((await tailscale.POST(request('tailscale', 'enable'))).status).toBe(409);
  expect(mocks.emit).toHaveBeenCalledWith('wizard:changed', { wizard: 'tailscale' });
 });
 it('notifies after token changes without broadcasting the token', async () => {
  await cloudflare.POST(request('cloudflare', 'save-token'));
  expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('wizard:changed', { wizard: 'cloudflare' });
 });
 it('refuses unauthorized requests before mutation or broadcast', async () => {
  mocks.denied = true;
  expect((await tailscale.POST(request('tailscale', 'enable'))).status).toBe(401);
  expect((await cloudflare.POST(request('cloudflare', 'save-token'))).status).toBe(401);
  expect(mocks.enable).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
 });
});
