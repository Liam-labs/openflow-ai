import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), emit: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/lib/wizards/events', () => ({ emitWizardChanged: mocks.emit }));
import { ISOLATED_TAILSCALE_SOCKET, isolatedTailscaleNode, tailscaleSocketArgs, loginIsolatedTailscale, loginUrlFromOutput } from '@/lib/wizards/tailscale-runtime';
function child() { return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() }); }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('OPENFLOW_TAILSCALE_SOCKET', ISOLATED_TAILSCALE_SOCKET); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('isolated Tailscale runtime', () => {
 it('never selects a host socket or signs in on the native host', async () => {
  vi.stubEnv('OPENFLOW_TAILSCALE_SOCKET', '/var/run/tailscale/tailscaled.sock');
  expect(isolatedTailscaleNode()).toBe(false); expect(tailscaleSocketArgs()).toEqual([]);
  expect((await loginIsolatedTailscale()).ok).toBe(false); expect(mocks.spawn).not.toHaveBeenCalled();
 });
 it('returns a provider approval link and emits completion without polling or duplicate login processes', async () => {
  const proc = child(); mocks.spawn.mockReturnValue(proc);
  const pending = loginIsolatedTailscale(); expect(loginIsolatedTailscale()).toBe(pending);
  proc.stdout.emit('data', Buffer.from('{"AuthURL":"https://login.tailscale.com/a/abc123"}'));
  expect(await pending).toEqual({ ok: true, loginUrl: 'https://login.tailscale.com/a/abc123' });
  expect(mocks.spawn.mock.calls[0][1]).toContain(`--socket=${ISOLATED_TAILSCALE_SOCKET}`);
  expect(mocks.spawn.mock.calls[0][1]).toContain('--accept-dns=false');
  expect(mocks.emit).not.toHaveBeenCalled();
  proc.emit('close', 0); expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('tailscale');
 });
 it('returns completion directly when the node already has a login', async () => {
  const proc = child(); mocks.spawn.mockReturnValue(proc); const pending = loginIsolatedTailscale();
  proc.emit('close', 0); expect(await pending).toEqual({ ok: true });
 });
 it('bounds the wait for a link and terminates only its child', async () => {
  vi.useFakeTimers(); const proc = child(); mocks.spawn.mockReturnValue(proc); const pending = loginIsolatedTailscale();
  await vi.advanceTimersByTimeAsync(15000); expect((await pending).ok).toBe(false); expect(proc.kill).toHaveBeenCalledWith('SIGTERM'); proc.emit('close', 1);
 });
 it('does not return arbitrary URLs from process output', () => {
  expect(loginUrlFromOutput('https://evil.test/a/123')).toBeUndefined();
  expect(loginUrlFromOutput('http://login.tailscale.com/a/123')).toBeUndefined();
 });
});
