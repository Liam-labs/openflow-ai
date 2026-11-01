import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
let dir: string;
vi.mock('@/lib/data-paths', () => ({ DataPaths: { get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); } } }));
const code = 'a'.repeat(43);
const pw = 'four distinct words together';
const now = Date.now();
async function issue(expiresAt = now + 3600000) {
  await fs.writeFile(path.join(dir, 'setup-code.json'), JSON.stringify({ hash: createHash('sha256').update(code).digest('hex'), expiresAt }));
}
beforeEach(async () => { vi.resetModules(); dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-code-')); await issue(); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
describe('first login from an installer code', () => {
  it('sets a password and a usable session, storing neither code nor cookie', async () => {
    const auth = await import('@/lib/dashboard-auth');
    const result = await auth.claimSetupCode(code, pw, 'test', 'browser', now);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('claim failed');
    const raw = await fs.readFile(path.join(dir, 'dashboard-auth.json'), 'utf8');
    expect(raw).not.toContain(code); expect(raw).not.toContain(result.cookie); expect(raw).not.toContain(pw);
    const store = JSON.parse(raw);
    expect(auth.sessionUsable(store.sessions[auth.sessionKey(result.cookie)], now)).toBe(true);
    expect(await auth.verifyPasswordHash(pw, store.password.hash)).toBe(true);
    expect((await fs.stat(path.join(dir, 'dashboard-auth.json'))).mode & 0o777).toBe(0o600);
  });
  it('allows only one concurrent claim and cannot replace the password', async () => {
    const { claimSetupCode } = await import('@/lib/dashboard-auth');
    const results = await Promise.all([claimSetupCode(code, pw, 'a', '', now), claimSetupCode(code, pw + 'other', 'b', '', now)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, reason: 'already_configured' }]);
  });
  it('does not revive a consumed code after password reset', async () => {
    const auth = await import('@/lib/dashboard-auth');
    expect((await auth.claimSetupCode(code, pw, 'a', '', now)).ok).toBe(true);
    await auth.clearPassword();
    expect(await auth.claimSetupCode(code, pw, 'a', '', now)).toEqual({ ok: false, reason: 'invalid_code' });
  });
  it('rejects expiry and missing codes without setting a password', async () => {
    const auth = await import('@/lib/dashboard-auth');
    await issue(now);
    expect((await auth.claimSetupCode(code, pw, 'a', '', now)).ok).toBe(false);
    await fs.unlink(path.join(dir, 'setup-code.json'));
    expect((await auth.claimSetupCode(code, pw, 'b', '', now)).ok).toBe(false);
    expect(await auth.hasPassword()).toBe(false);
  });
  it('throttles guesses under the same lock and leaves a valid code unused', async () => {
    const auth = await import('@/lib/dashboard-auth');
    await Promise.all(Array.from({ length: 5 }, () => auth.claimSetupCode('wrong', pw, 'a', '', now)));
    expect(await auth.claimSetupCode(code, pw, 'a', '', now)).toMatchObject({ ok: false, reason: 'throttled' });
    expect((await auth.claimSetupCode(code, pw, 'a', '', now + auth.LOGIN_WINDOW_MS)).ok).toBe(true);
  });
  it('rejects a cross-site claim and returns a secure session cookie for a same-site claim', async () => {
    const { POST } = await import('@/app/api/auth/setup/route');
    const request = (origin: string) => new NextRequest('https://test.example/api/auth/setup', { method: 'POST', headers: { host: 'test.example', origin, 'content-type': 'application/json' }, body: JSON.stringify({ code, newPassword: pw }) });
    expect((await POST(request('https://evil.example'))).status).toBe(403);
    const response = await POST(request('https://test.example'));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/);
    expect(await response.json()).toEqual({ ok: true });
  });
});
