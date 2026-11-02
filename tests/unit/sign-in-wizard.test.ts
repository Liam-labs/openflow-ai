import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;

vi.mock('@/lib/data-paths', async () => ({
  DataPaths: {
    get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); },
    get remoteAccess() { return path.join(dir, 'remote-access.json'); },
    get apiTokens() { return path.join(dir, 'api-tokens.json'); },
  },
}));

const ORIGIN = 'http://127.0.0.1:3000';
const PW = 'correct horse battery';

async function mods() {
  vi.resetModules();
  const wizard = await import('@/lib/wizards/sign-in');
  const auth = await import('@/lib/dashboard-auth');
  const login = await import('@/app/api/auth/login/route');
  const logout = await import('@/app/api/auth/logout/route');
  const session = await import('@/app/api/auth/session/route');
  const route = await import('@/app/api/wizards/sign-in/route');
  return { wizard, auth, login, logout, session, route };
}

/** The real routes, called the way the wizard's HTTP client would call them. */
function realHttp(m: Awaited<ReturnType<typeof mods>>): import('@/lib/wizards/sign-in').ProofHttp {
  return async (p, init) => {
    const req = new NextRequest(`${ORIGIN}${p}`, { method: init.method, headers: { host: '127.0.0.1:3000', ...init.headers }, body: init.body });
    const res =
      p === '/api/auth/login' ? await m.login.POST(req)
      : p === '/api/auth/logout' ? await m.logout.POST(req)
      : p === '/api/auth/session' ? await m.session.GET(req)
      : (() => { throw new Error(`unexpected path ${p}`); })();
    return { status: res.status, headers: res.headers, json: () => res.json() };
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signinwiz-'));
  // The routes read the real environment: keep this machine's own bind / tunnel settings out of the checks.
  for (const name of ['DEVFLOW_BIND_HOST', 'WEBGATE_TUNNEL_SECRET', 'DEVFLOW_ALLOW_OPEN_REMOTE']) vi.stubEnv(name, '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('mayRemovePassword', () => {
  it('allows removal only when nothing reaches the dashboard, or the owner opted out of the guard', async () => {
    const { wizard } = await mods();
    expect(wizard.mayRemovePassword([], false)).toEqual({ ok: true });
    expect(wizard.mayRemovePassword(['remote access is switched on'], true)).toEqual({ ok: true });
    const refused = wizard.mayRemovePassword(['remote access is switched on'], false);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toMatch(/remote access is switched on/);
  });
});

describe('check and undo', () => {
  it('reports the password and the ways in from other computers', async () => {
    const { wizard, auth } = await mods();
    expect(await wizard.signInCheck({})).toMatchObject({ passwordSet: false, setAt: null, signedInBrowsers: 0, exposures: [] });
    await auth.setPassword(PW);
    await fs.writeFile(path.join(dir, 'remote-access.json'), JSON.stringify({ enabled: true }));
    const check = await wizard.signInCheck({ DEVFLOW_BIND_HOST: '0.0.0.0', WEBGATE_TUNNEL_SECRET: 'x' });
    expect(check.passwordSet).toBe(true);
    expect(check.setAt).toMatch(/^\d{4}-/);
    expect(check.exposures).toHaveLength(3);
    expect(check.signedInBrowsers).toBe(0);
    await auth.login(PW, '9.9.9.9', 'ua');
    expect((await wizard.signInCheck({})).signedInBrowsers).toBe(1);
  });

  it('refuses to remove the password while exposed and leaves it in place', async () => {
    const { wizard, auth } = await mods();
    await auth.setPassword(PW);
    const refused = await wizard.removePassword({ DEVFLOW_BIND_HOST: '0.0.0.0' });
    expect(refused.ok).toBe(false);
    expect(await auth.hasPassword()).toBe(true);
  });

  it('refuses to remove the password while remote access is switched on in its settings file', async () => {
    const { wizard, auth } = await mods();
    await auth.setPassword(PW);
    await fs.writeFile(path.join(dir, 'remote-access.json'), JSON.stringify({ enabled: true }));
    const refused = await wizard.removePassword({});
    expect(refused.ok === false && refused.reason).toMatch(/remote access is switched on/);
    expect(await auth.hasPassword()).toBe(true);
  });

  it('removes the password and every session when nothing is exposed', async () => {
    const { wizard, auth } = await mods();
    await auth.setPassword(PW);
    const signedIn = await auth.login(PW, '9.9.9.9', 'ua');
    expect((await wizard.removePassword({})).ok).toBe(true);
    expect(await auth.hasPassword()).toBe(false);
    if (signedIn.ok) expect(await auth.validateSessionCookie(signedIn.cookie)).toBe(false);
  });

  it('removing the password is allowed when the owner set DEVFLOW_ALLOW_OPEN_REMOTE=1', async () => {
    const { wizard, auth } = await mods();
    await auth.setPassword(PW);
    expect((await wizard.removePassword({ DEVFLOW_BIND_HOST: '0.0.0.0', DEVFLOW_ALLOW_OPEN_REMOTE: '1' })).ok).toBe(true);
    expect(await auth.hasPassword()).toBe(false);
  });
});

describe('proveSignIn against the real routes', () => {
  it('passes every step with the password that was set', async () => {
    const m = await mods();
    await m.auth.setPassword(PW);
    const result = await m.wizard.proveSignIn(PW, ORIGIN, realHttp(m));
    expect(result.steps.map((s) => [s.name, s.ok])).toEqual([
      ['No cookie is not signed in', true],
      ['A wrong password is refused', true],
      ['The password signs in', true],
      ['The cookie is private to the browser', true],
      ['The cookie is recognised', true],
      ['Another site cannot sign in', true],
      ['Signing out ends the session', true],
    ]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PW);
  });

  it('fails at the sign-in step when the typed password is not the stored one', async () => {
    const m = await mods();
    await m.auth.setPassword(PW);
    const result = await m.wizard.proveSignIn('some other passphrase', ORIGIN, realHttp(m));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: 'The password signs in', ok: false });
  });

  it('fails when there is no password at all', async () => {
    const m = await mods();
    const result = await m.wizard.proveSignIn(PW, ORIGIN, realHttp(m));
    expect(result.ok).toBe(false);
  });

  it('leaves no signed-in browser behind', async () => {
    const m = await mods();
    await m.auth.setPassword(PW);
    await m.wizard.proveSignIn(PW, ORIGIN, realHttp(m));
    expect(await m.auth.sessionCount()).toBe(0);
  });

  it('catches a server that treats everyone as signed in', async () => {
    const m = await mods();
    const liar: import('@/lib/wizards/sign-in').ProofHttp = async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ signedIn: true }) });
    const result = await m.wizard.proveSignIn(PW, ORIGIN, liar);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
  });

  it('catches a server that accepts a wrong password', async () => {
    const m = await mods();
    const real = realHttp(m);
    await m.auth.setPassword(PW);
    const lax: import('@/lib/wizards/sign-in').ProofHttp = async (p, init) => {
      if (p === '/api/auth/login' && init.body && !init.body.includes(`"${PW}"`)) return { status: 200, headers: { get: () => `devflow_session=${'a'.repeat(43)}; HttpOnly` }, json: async () => ({ ok: true }) };
      return real(p, init);
    };
    const result = await m.wizard.proveSignIn(PW, ORIGIN, lax);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: 'A wrong password is refused', ok: false });
  });

  it('catches a cookie that survives sign-out and one that is not HttpOnly/SameSite', async () => {
    const m = await mods();
    await m.auth.setPassword(PW);
    const real = realHttp(m);
    const noLogout: import('@/lib/wizards/sign-in').ProofHttp = async (p, init) => (p === '/api/auth/logout' ? { status: 200, headers: { get: () => null }, json: async () => ({}) } : real(p, init));
    const a = await m.wizard.proveSignIn(PW, ORIGIN, noLogout);
    expect(a.ok).toBe(false);
    expect(a.steps.at(-1)).toMatchObject({ name: 'Signing out ends the session', ok: false });

    const plainCookie: import('@/lib/wizards/sign-in').ProofHttp = async (p, init) => {
      const r = await real(p, init);
      if (p !== '/api/auth/login' || r.status !== 200) return r;
      return { status: r.status, json: () => r.json(), headers: { get: (n) => (n.toLowerCase() === 'set-cookie' ? (r.headers.get('set-cookie') || '').replace(/; HttpOnly/i, '') : r.headers.get(n)) } };
    };
    const b = await m.wizard.proveSignIn(PW, ORIGIN, plainCookie);
    expect(b.steps.find((s) => s.name === 'The cookie is private to the browser')?.ok).toBe(false);
  });

  describe('against servers that get one answer wrong', () => {
    const cookie = 'c'.repeat(43);
    const ok = (status: number, setCookie: string | null, body: unknown = {}) => ({ status, headers: { get: (n: string) => (n.toLowerCase() === 'set-cookie' ? setCookie : null) }, json: async () => body });
    const GOOD = `devflow_session=${cookie}; Path=/; HttpOnly; SameSite=Strict`;
    /** A server that answers like the real one unless `override` has an answer for the call. */
    const server = (override: (p: string, init: { body?: string; headers: Record<string, string> }, n: number) => ReturnType<typeof ok> | undefined): import('@/lib/wizards/sign-in').ProofHttp => {
      let logins = 0;
      return async (p, init) => {
        const n = p === '/api/auth/login' ? ++logins : 0;
        const o = override(p, init, n);
        if (o) return o;
        if (p === '/api/auth/session') return ok(200, null, { signedIn: (init.headers.Cookie || '').includes(cookie) && !server_loggedOut });
        if (p === '/api/auth/logout') { server_loggedOut = true; return ok(200, null); }
        if (p === '/api/auth/login') {
          if (init.headers.Origin !== ORIGIN) return ok(403, null);
          return n === 1 ? ok(401, null) : ok(200, GOOD);
        }
        throw new Error(p);
      };
    };
    let server_loggedOut = false;
    beforeEach(() => { server_loggedOut = false; });

    it('a scripted good server passes (control)', async () => {
      const m = await mods();
      expect((await m.wizard.proveSignIn(PW, ORIGIN, server(() => undefined))).ok).toBe(true);
    });
    it('a wrong password that still gets a cookie fails step 2', async () => {
      const m = await mods();
      const r = await m.wizard.proveSignIn(PW, ORIGIN, server((p, _i, n) => (p === '/api/auth/login' && n === 1 ? ok(401, GOOD) : undefined)));
      expect(r.steps.at(-1)).toMatchObject({ name: 'A wrong password is refused', ok: false });
    });
    it('a good password answered 500 with a cookie fails step 3', async () => {
      const m = await mods();
      const r = await m.wizard.proveSignIn(PW, ORIGIN, server((p, _i, n) => (p === '/api/auth/login' && n === 2 ? ok(500, GOOD) : undefined)));
      expect(r.steps.at(-1)).toMatchObject({ name: 'The password signs in', ok: false });
    });
    it('a good password answered 200 without a cookie fails step 3', async () => {
      const m = await mods();
      const r = await m.wizard.proveSignIn(PW, ORIGIN, server((p, _i, n) => (p === '/api/auth/login' && n === 2 ? ok(200, null) : undefined)));
      expect(r.steps.at(-1)).toMatchObject({ name: 'The password signs in', ok: false });
    });
    it('a too-short cookie value is not taken for a session', async () => {
      const m = await mods();
      const r = await m.wizard.proveSignIn(PW, ORIGIN, server((p, _i, n) => (p === '/api/auth/login' && n === 2 ? ok(200, 'devflow_session=abc; HttpOnly; SameSite=Strict') : undefined)));
      expect(r.steps.at(-1)).toMatchObject({ name: 'The password signs in', ok: false });
    });
    it('a cookie without SameSite=Strict fails the private-cookie step', async () => {
      const m = await mods();
      const r = await m.wizard.proveSignIn(PW, ORIGIN, server((p, _i, n) => (p === '/api/auth/login' && n === 2 ? ok(200, `devflow_session=${cookie}; HttpOnly`) : undefined)));
      expect(r.steps.find((s) => s.name === 'The cookie is private to the browser')?.ok).toBe(false);
    });
    it('a cookie the server does not recognise fails step 4', async () => {
      const m = await mods();
      const r = await m.wizard.proveSignIn(PW, ORIGIN, server((p, i) => (p === '/api/auth/session' && (i.headers.Cookie || '').includes(cookie) ? ok(200, null, { signedIn: false }) : undefined)));
      expect(r.steps.at(-1)).toMatchObject({ name: 'The cookie is recognised', ok: false });
    });
  });

  it('reports a network failure as a failed step instead of throwing', async () => {
    const m = await mods();
    const down: import('@/lib/wizards/sign-in').ProofHttp = async () => { throw new Error('connect ECONNREFUSED'); };
    const result = await m.wizard.proveSignIn(PW, ORIGIN, down);
    expect(result).toMatchObject({ ok: false });
    expect(result.steps[0].detail).toMatch(/ECONNREFUSED/);
  });
});

describe('/api/wizards/sign-in', () => {
  const call = (m: Awaited<ReturnType<typeof mods>>, body?: unknown, headers: Record<string, string> = {}) =>
    (body === undefined ? m.route.GET : m.route.POST)(new NextRequest(`${ORIGIN}/api/wizards/sign-in`, { method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:3000', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));

  it('sets a password from this machine, refuses a weak one, and never echoes the password', async () => {
    const m = await mods();
    const weak = await call(m, { action: 'set', password: 'short' });
    expect(weak.status).toBe(400);
    const ok = await call(m, { action: 'set', password: PW });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await (await call(m)).json())).not.toContain(PW);
    expect(await m.auth.hasPassword()).toBe(true);
  });

  it('proves through the real routes only when asked with a password; undo removes it', async () => {
    const m = await mods();
    await call(m, { action: 'set', password: PW });
    expect((await call(m, { action: 'prove' })).status).toBe(400);
    expect((await call(m, { action: 'bogus' })).status).toBe(400);
    expect((await call(m, { action: 'undo' })).status).toBe(200);
    expect(await m.auth.hasPassword()).toBe(false);
  });

  it('refuses to undo with 409 while other computers can reach the dashboard, and keeps the password', async () => {
    const m = await mods();
    await call(m, { action: 'set', password: PW });
    vi.stubEnv('WEBGATE_TUNNEL_SECRET', 'x'.repeat(20));
    const res = await call(m, { action: 'undo' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/tunnel is set up/);
    expect(await m.auth.hasPassword()).toBe(true);
  });

  it('refuses a caller that is not on this machine and has no token, and changes nothing', async () => {
    const m = await mods();
    const outside = { 'x-forwarded-for': '203.0.113.7' };
    expect((await call(m, undefined, outside)).status).toBe(401);
    expect((await call(m, { action: 'set', password: PW }, outside)).status).toBe(401);
    expect(await m.auth.hasPassword()).toBe(false);
  });
});
