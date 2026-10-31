import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { promises as fs, statSync } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
let file: string;

vi.mock('@/lib/data-paths', async () => ({ DataPaths: { get dashboardAuth() { return file; }, get apiTokens() { return path.join(dir, 'api-tokens.json'); } } }));

async function load() {
  vi.resetModules();
  return import('@/lib/dashboard-auth');
}

const PW = 'correct horse battery';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashauth-'));
  file = path.join(dir, 'dashboard-auth.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('passwordProblem', () => {
  it.each([
    ['short', /at least 12/],
    ['aaaaaaaaaaaa', /too easy/],
    ['password1234', /too easy/],
    ['abababababab', /too easy/],
    ['x'.repeat(300), /at most/],
  ])('refuses %j', async (pw, why) => {
    const { passwordProblem } = await load();
    expect(passwordProblem(pw)).toMatch(why);
  });
  it('the shortest allowed password is exactly 12 characters', async () => {
    const { passwordProblem } = await load();
    expect(passwordProblem('abcdefghijk')).toMatch(/at least 12/);
    expect(passwordProblem('abcdefghijkl')).toBeNull();
    expect(passwordProblem('abcdefghijkl'.padEnd(256, 'q'))).toBeNull();
    expect(passwordProblem('abcdefghijkl'.padEnd(257, 'q'))).toMatch(/at most/);
  });
  it('refuses a non-string and accepts a plain passphrase', async () => {
    const { passwordProblem } = await load();
    expect(passwordProblem(undefined)).toMatch(/Enter/);
    expect(passwordProblem(PW)).toBeNull();
  });
});

describe('password hashing', () => {
  it('verifies the right password, refuses the wrong one, and salts each hash', async () => {
    const { hashPassword, verifyPasswordHash } = await load();
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a).not.toBe(b);
    expect(await verifyPasswordHash(PW, a)).toBe(true);
    expect(await verifyPasswordHash(PW + 'x', a)).toBe(false);
    expect(await verifyPasswordHash('', a)).toBe(false);
  });
  it.each(['', 'scrypt$1$2', 'bcrypt$16384$8$1$aa$bb', 'scrypt$16384$8$1$zz$zz', 'scrypt$0$8$1$aa$bb', 'scrypt$99999999$8$1$aa$bb'])('treats a malformed stored hash %j as no match', async (stored) => {
    const { verifyPasswordHash } = await load();
    expect(await verifyPasswordHash(PW, stored)).toBe(false);
  });
  it('a password set by scripts/devflow-password signs in here (same hash format)', async () => {
    execFileSync(path.join(process.cwd(), 'scripts/devflow-password'), ['set', '--stdin'], { input: PW + '\n', env: { ...process.env, DEVFLOW_APP_DATA_DIR: dir } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { login } = await load();
    expect((await login(PW, '10.0.0.1', 'ua')).ok).toBe(true);
    expect((await login('wrong password here', '10.0.0.1', 'ua')).ok).toBe(false);
  });
});

describe('sessionUsable', () => {
  it('is good until it expires or sits idle for a week, and not after', async () => {
    const { sessionUsable, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } = await load();
    const rec = { createdAt: 0, lastSeenAt: 0, expiresAt: SESSION_ABSOLUTE_MS, ip: 'x', userAgent: '' };
    expect(sessionUsable(rec, SESSION_IDLE_MS - 1)).toBe(true);
    expect(sessionUsable(rec, SESSION_IDLE_MS)).toBe(false);
    expect(sessionUsable({ ...rec, lastSeenAt: SESSION_ABSOLUTE_MS - 1 }, SESSION_ABSOLUTE_MS - 1)).toBe(true);
    expect(sessionUsable({ ...rec, lastSeenAt: SESSION_ABSOLUTE_MS - 1 }, SESSION_ABSOLUTE_MS)).toBe(false);
    expect(sessionUsable(undefined, 0)).toBe(false);
  });
});

describe('loginThrottle', () => {
  const empty = { attempts: {}, globalAttempts: { count: 0, firstAt: 0 } };
  it('lets an address try five times in 15 minutes, then waits until the window ends', async () => {
    const { loginThrottle, LOGIN_FAILURE_LIMIT, LOGIN_WINDOW_MS } = await load();
    const store = { ...empty, attempts: { a: { count: LOGIN_FAILURE_LIMIT - 1, firstAt: 1000 } } };
    expect(loginThrottle(store, 'a', 2000).allowed).toBe(true);
    store.attempts.a.count = LOGIN_FAILURE_LIMIT;
    const blocked = loginThrottle(store, 'a', 2000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(Math.ceil((1000 + LOGIN_WINDOW_MS - 2000) / 1000));
    expect(loginThrottle(store, 'a', 1000 + LOGIN_WINDOW_MS).allowed).toBe(true);
    expect(loginThrottle(store, 'b', 2000).allowed).toBe(true);
  });
  it('also stops a guesser who spreads attempts over many addresses', async () => {
    const { loginThrottle, LOGIN_GLOBAL_LIMIT, LOGIN_GLOBAL_WINDOW_MS } = await load();
    const store = { attempts: {}, globalAttempts: { count: LOGIN_GLOBAL_LIMIT, firstAt: 1000 } };
    expect(loginThrottle(store, 'fresh', 2000).allowed).toBe(false);
    expect(loginThrottle(store, 'fresh', 1000 + LOGIN_GLOBAL_WINDOW_MS).allowed).toBe(true);
  });
});

describe('sameOriginForWrites', () => {
  const f = (over: Partial<{ host: string | null; origin: string | null; secFetchSite: string | null }> = {}) => ({ host: 'app.example:3000', origin: null, secFetchSite: null, ...over });
  it('lets reads through whatever they say', async () => {
    const { sameOriginForWrites } = await load();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(sameOriginForWrites(method, f({ origin: 'https://evil.example', secFetchSite: 'cross-site' }))).toBe(true);
  });
  it('lets a write from our own page through and refuses one from another site', async () => {
    const { sameOriginForWrites } = await load();
    expect(sameOriginForWrites('POST', f({ origin: 'http://app.example:3000', secFetchSite: 'same-origin' }))).toBe(true);
    expect(sameOriginForWrites('POST', f({ origin: 'https://evil.example', secFetchSite: 'cross-site' }))).toBe(false);
    expect(sameOriginForWrites('POST', f({ origin: 'https://evil.example' }))).toBe(false);
    expect(sameOriginForWrites('POST', f({ origin: 'http://app.example:9999' }))).toBe(false);          // same name, other port
    expect(sameOriginForWrites('POST', f({ origin: 'http://evil.example:3000' }))).toBe(false);         // other name, same port
    expect(sameOriginForWrites('POST', f({ secFetchSite: 'same-site' }))).toBe(false);                  // a sibling subdomain
    expect(sameOriginForWrites('DELETE', f({ origin: 'not a url' }))).toBe(false);
    expect(sameOriginForWrites('POST', f({ secFetchSite: 'none' }))).toBe(true);                       // typed into the address bar / a bookmark
    expect(sameOriginForWrites('POST', f())).toBe(true);                                               // not a browser: no cookie to abuse
    expect(sameOriginForWrites('post', f({ origin: 'https://evil.example' }))).toBe(false);            // method case does not matter
    expect(sameOriginForWrites('POST', f({ origin: 'http://app.example:3000', host: null }))).toBe(false);
  });
});

describe('cookies', () => {
  it('reads our cookie among others and ignores a malformed value', async () => {
    const { parseCookie, SESSION_COOKIE } = await load();
    const v = 'A'.repeat(43);
    expect(parseCookie(`a=1; ${SESSION_COOKIE}=${v}; b=2`, SESSION_COOKIE)).toBe(v);
    expect(parseCookie(`${SESSION_COOKIE}=short`, SESSION_COOKIE)).toBeNull();
    expect(parseCookie(`${SESSION_COOKIE}=${v}%00x`, SESSION_COOKIE)).toBeNull();
    expect(parseCookie(null, SESSION_COOKIE)).toBeNull();
    expect(parseCookie(`x${SESSION_COOKIE}=${v}`, SESSION_COOKIE)).toBeNull();
  });
  it('is HttpOnly, SameSite=Strict, and Secure only over https', async () => {
    const { cookieHeader, clearedCookieHeader } = await load();
    expect(cookieHeader('v', { secure: false, maxAgeSeconds: 5 })).toBe('devflow_session=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=5');
    expect(cookieHeader('v', { secure: true, maxAgeSeconds: 5 })).toMatch(/; Secure$/);
    expect(clearedCookieHeader(true)).toMatch(/Max-Age=0/);
  });
  it('requestIsHttps follows the proxy header first', async () => {
    const { requestIsHttps } = await load();
    const h = (v: string | null) => ({ get: () => v });
    expect(requestIsHttps(h('https'), 'http://x')).toBe(true);
    expect(requestIsHttps(h('http'), 'https://x')).toBe(false);
    expect(requestIsHttps(h('http, https'), 'http://x')).toBe(true);
    expect(requestIsHttps(h(null), 'https://x')).toBe(true);
    expect(requestIsHttps(h(null), 'http://x')).toBe(false);
  });
});

describe('sign in, sessions and recovery', () => {
  it('with no password nobody can sign in', async () => {
    const { login, hasPassword } = await load();
    expect(await hasPassword()).toBe(false);
    expect(await login(PW, '1.1.1.1', 'ua')).toEqual({ ok: false, reason: 'no_password' });
  });

  it('a good password gives a cookie that works, the store keeps only its hash, and logout ends it', async () => {
    const { setPassword, login, validateSessionCookie, logout } = await load();
    expect((await setPassword(PW)).ok).toBe(true);
    const r = await login(PW, '1.1.1.1', 'ua');
    if (!r.ok) throw new Error('login failed');
    expect(await validateSessionCookie(r.cookie)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).not.toContain(r.cookie);
    expect(await validateSessionCookie(r.cookie + 'x')).toBe(false);
    expect(await validateSessionCookie(null)).toBe(false);
    await logout(r.cookie);
    expect(await validateSessionCookie(r.cookie)).toBe(false);
  });

  it('five wrong passwords lock that address out even for the right password; another address is unaffected', async () => {
    const { setPassword, login } = await load();
    await setPassword(PW);
    for (let i = 0; i < 5; i++) expect((await login('wrong wrong wrong', '2.2.2.2', 'ua')).ok).toBe(false);
    const blocked = await login(PW, '2.2.2.2', 'ua');
    expect(blocked).toMatchObject({ ok: false, reason: 'throttled' });
    expect((await login(PW, '3.3.3.3', 'ua')).ok).toBe(true);
  });

  it('a good password clears that address\'s failures', async () => {
    const { setPassword, login } = await load();
    await setPassword(PW);
    for (let i = 0; i < 4; i++) await login('wrong wrong wrong', '4.4.4.4', 'ua');
    expect((await login(PW, '4.4.4.4', 'ua')).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect((await login('wrong wrong wrong', '4.4.4.4', 'ua')).ok).toBe(false);
    expect((await login(PW, '4.4.4.4', 'ua')).ok).toBe(true);          // would be throttled if the count had not been cleared
  });

  it('a session expires after its lifetime and after a week unused', async () => {
    const { setPassword, login, validateSessionCookie, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } = await load();
    await setPassword(PW);
    const t0 = 1_000_000;
    const r = await login(PW, '5.5.5.5', 'ua', t0);
    if (!r.ok) throw new Error('login failed');
    const r1 = await login(PW, '5.5.5.5', 'ua', t0);
    if (!r1.ok) throw new Error('login failed');
    expect(await validateSessionCookie(r.cookie, t0 + SESSION_IDLE_MS - 1)).toBe(true);     // a use slides the idle clock...
    expect(await validateSessionCookie(r1.cookie, t0 + SESSION_IDLE_MS + 1)).toBe(false);   // ...an unused one is dead a week on
    expect(await validateSessionCookie(r.cookie, t0 + SESSION_IDLE_MS + 1)).toBe(true);
    const r2 = await login(PW, '5.5.5.5', 'ua', t0);
    if (!r2.ok) throw new Error('login failed');
    expect(await validateSessionCookie(r2.cookie, t0 + SESSION_ABSOLUTE_MS + 1)).toBe(false);
  });

  it('changing the password ends every session; reset forgets the password and sessions', async () => {
    const { setPassword, login, validateSessionCookie, clearPassword, hasPassword } = await load();
    await setPassword(PW);
    const r = await login(PW, '6.6.6.6', 'ua');
    if (!r.ok) throw new Error('login failed');
    await setPassword('another long passphrase');
    expect(await validateSessionCookie(r.cookie)).toBe(false);
    expect((await login(PW, '6.6.6.6', 'ua')).ok).toBe(false);
    const r2 = await login('another long passphrase', '6.6.6.6', 'ua');
    if (!r2.ok) throw new Error('login failed');
    await clearPassword();
    expect(await hasPassword()).toBe(false);
    expect(await validateSessionCookie(r2.cookie)).toBe(false);
  });

  it('a login attempt drops sessions that are already dead', async () => {
    const { setPassword, login, SESSION_ABSOLUTE_MS } = await load();
    await setPassword(PW);
    const old = await login(PW, '1.2.3.4', 'ua', 1000);
    if (!old.ok) throw new Error('x');
    await login(PW, '1.2.3.4', 'ua', 1000 + SESSION_ABSOLUTE_MS + 1);
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).sessions)).toHaveLength(1);
  });

  it('a password longer than the limit is refused without being hashed, even if it is the stored one', async () => {
    const { hashPassword, login } = await load();
    const long = 'abcdefghij'.repeat(30);
    await fs.writeFile(file, JSON.stringify({ version: 1, password: { hash: await hashPassword(long), setAt: 'x' }, sessions: {}, attempts: {}, globalAttempts: { count: 0, firstAt: 0 } }));
    expect(await login(long, '1.2.3.5', 'ua')).toMatchObject({ ok: false, reason: 'wrong' });
  });

  it('setPassword refuses a weak password and changes nothing', async () => {
    const { setPassword, hasPassword } = await load();
    expect(await setPassword('short')).toMatchObject({ ok: false });
    expect(await hasPassword()).toBe(false);
  });

  it('an unreadable store counts as "a password is set" and never lets anyone in', async () => {
    const { hasPassword, login, validateSessionCookie } = await load();
    await fs.writeFile(file, '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await hasPassword()).toBe(true);
    await expect(login(PW, '7.7.7.7', 'ua')).rejects.toThrow();
    expect(await validateSessionCookie('A'.repeat(43))).toBe(false);
  });

  it('keeps no more than 50 sessions, dropping the oldest', async () => {
    const { setPassword, login, validateSessionCookie } = await load();
    await setPassword(PW);
    const first = await login(PW, '8.8.8.8', 'ua', 1000);
    if (!first.ok) throw new Error('x');
    for (let i = 0; i < 50; i++) await login(PW, '8.8.8.8', 'ua', 2000 + i);
    expect(await validateSessionCookie(first.cookie, 3000)).toBe(false);
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).sessions).length).toBeLessThanOrEqual(50);
    // 51 real scrypt sign-ins: about 3 s on an idle machine, so the 5 s default timed out under a loaded full run.
  }, 30_000);
});

describe('requestHasSession and the guards', () => {
  const req = (cookie: string | null, over: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest('http://app.example:3000/api/x', { method: over.method || 'GET', headers: { host: 'app.example:3000', 'x-forwarded-for': '203.0.113.9', ...(cookie ? { cookie: `devflow_session=${cookie}` } : {}), ...over.headers } });

  it('accepts a live session on a read and on a same-origin write, refuses a cross-site write', async () => {
    const { setPassword, login, requestHasSession } = await load();
    await setPassword(PW);
    const r = await login(PW, '9.9.9.9', 'ua');
    if (!r.ok) throw new Error('x');
    expect(await requestHasSession(req(r.cookie))).toBe(true);
    expect(await requestHasSession(req(r.cookie, { method: 'POST', headers: { origin: 'http://app.example:3000', 'sec-fetch-site': 'same-origin' } }))).toBe(true);
    expect(await requestHasSession(req(r.cookie, { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }))).toBe(false);
    expect(await requestHasSession(req(null))).toBe(false);
  });

  it('requireAuthOrLocal lets a signed-in browser from outside in; requireTokenOrLocal does not', async () => {
    vi.resetModules();
    const auth = await import('@/lib/api-auth');
    const { setPassword, login } = await import('@/lib/dashboard-auth');
    await setPassword(PW);
    const r = await login(PW, '9.9.9.9', 'ua');
    if (!r.ok) throw new Error('x');
    expect(await auth.requireAuthOrLocal(req(r.cookie))).toBeNull();
    expect((await auth.requireAuthOrLocal(req(null)))?.status).toBe(401);
    expect((await auth.requireTokenOrLocal(req(r.cookie)))?.status).toBe(401);
  });
});
