/**
 * Sign-in wizard (stage 0 of the setup wizards): check, set, prove, undo for the owner password.
 *
 * Check  what is set today and what already reaches this dashboard from other computers.
 * Set    store the password (lib/dashboard-auth.ts); every browser signed in before is signed out.
 * Prove  sign in through the app's own HTTP routes with the password just chosen, then check that a wrong password, a request with
 *        no cookie and a signed-out cookie are all refused. "The file was written" is not proof.
 * Undo   forget the password, but never while something exposes the dashboard: that would be the state lib/exposure-guard.ts
 *        refuses to start in.
 */

import { exposureReasons, remoteAccessEnabled } from '../exposure-guard';
import { clearPassword, hasPassword, sessionCount, SESSION_COOKIE } from '../dashboard-auth';
import { readJsonFileStrict } from '../data-io';
import { DataPaths } from '../data-paths';

type Env = Record<string, string | undefined>;

export interface SignInCheck {
  passwordSet: boolean;
  setAt: string | null;
  signedInBrowsers: number;
  /** Reasons other computers can reach the dashboard right now (empty = this machine only). */
  exposures: string[];
}

export interface ProofStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProofResult {
  ok: boolean;
  steps: ProofStep[];
}

export async function signInCheck(env: Env = process.env): Promise<SignInCheck> {
  const stored = await readJsonFileStrict<{ password?: { setAt?: string } }>(DataPaths.dashboardAuth, {}).catch(() => ({} as { password?: { setAt?: string } }));
  return {
    passwordSet: await hasPassword(),
    setAt: stored.password?.setAt ?? null,
    signedInBrowsers: await sessionCount().catch(() => 0),
    exposures: [...exposureReasons(env, await remoteAccessEnabled()), ...(env.DEVFLOW_SERVER_MODE === '1' ? ['this is a server installation'] : [])],
  };
}

/** Removing the password is allowed only when nothing reaches the dashboard from other computers (or the owner opted out of the guard). */
export function mayRemovePassword(exposures: string[], allowOpen: boolean): { ok: true } | { ok: false; reason: string } {
  if (!exposures.length || allowOpen) return { ok: true };
  return {
    ok: false,
    reason: `The password stays while other computers can reach this dashboard (${exposures.join('; ')}). Turn that off first.`,
  };
}

export async function removePassword(env: Env = process.env): Promise<{ ok: true } | { ok: false; reason: string }> {
  // A loopback-bound server is still public through its installer-managed proxy.
  if (env.DEVFLOW_SERVER_MODE === '1') return { ok: false, reason: 'A server installation must keep its owner password. Change the password instead of removing it.' };
  const verdict = mayRemovePassword(exposureReasons(env, await remoteAccessEnabled()), env.DEVFLOW_ALLOW_OPEN_REMOTE === '1');
  if (!verdict.ok) return verdict;
  await clearPassword();
  return { ok: true };
}

// ─── Proof ───────────────────────────────────────────────────────────────────────────────────────────

export interface ProofHttp {
  (path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
}

function cookieValueFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]{20,200})`).exec(setCookie);
  return match ? match[1] : null;
}

/**
 * Drives the real routes. `origin` is the page address the request claims to come from (the routes demand a same-origin request),
 * `http` performs one request against this server. The password is only ever sent to our own loopback address.
 */
export async function proveSignIn(password: string, origin: string, http: ProofHttp): Promise<ProofResult> {
  const steps: ProofStep[] = [];
  const add = (name: string, ok: boolean, detail: string) => { steps.push({ name, ok, detail }); return ok; };
  const base = { Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => http(path, { method: 'POST', headers: { ...base, ...extra }, body: JSON.stringify(body) });
  const session = async (cookie?: string) => {
    const res = await http('/api/auth/session', { method: 'GET', headers: cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {} });
    return (await res.json()) as { signedIn?: boolean; passwordSet?: boolean };
  };

  try {
    // 1. A request with no cookie is not signed in.
    const anon = await session();
    if (!add('No cookie is not signed in', anon.signedIn === false, anon.signedIn === false ? 'A request without a sign-in cookie is turned away.' : 'A request with no cookie counted as signed in.')) return { ok: false, steps };

    // 2. A wrong password is refused.
    const wrong = await post('/api/auth/login', { password: `${password}-not-it` });
    if (!add('A wrong password is refused', wrong.status === 401 && !cookieValueFrom(wrong.headers.get('set-cookie')), `Answer ${wrong.status}, no sign-in cookie given.`)) return { ok: false, steps };

    // 3. The right password signs in and hands over a cookie.
    const right = await post('/api/auth/login', { password });
    const cookie = cookieValueFrom(right.headers.get('set-cookie'));
    if (!add('The password signs in', right.status === 200 && !!cookie, right.status === 200 && cookie ? 'Signed in; a sign-in cookie was given.' : `Answer ${right.status}.`)) return { ok: false, steps };
    const flags = (right.headers.get('set-cookie') || '').toLowerCase();
    add('The cookie is private to the browser', flags.includes('httponly') && flags.includes('samesite=strict'), 'HttpOnly and SameSite=Strict are set, so page scripts and other sites cannot use it.');

    // 4. That cookie is recognised.
    const withCookie = await session(cookie!);
    if (!add('The cookie is recognised', withCookie.signedIn === true, withCookie.signedIn ? 'The next request with the cookie is signed in.' : 'The cookie was not recognised.')) return { ok: false, steps };

    // 5. A page on another site cannot sign in.
    const foreign = await http('/api/auth/login', { method: 'POST', headers: { ...base, Origin: 'https://other-site.example' }, body: JSON.stringify({ password }) });
    add('Another site cannot sign in', foreign.status === 403, `Answer ${foreign.status} for a request claiming to come from another website.`);

    // 6. Signing out ends it.
    await post('/api/auth/logout', {}, { Cookie: `${SESSION_COOKIE}=${cookie}` });
    const after = await session(cookie!);
    add('Signing out ends the session', after.signedIn === false, after.signedIn === false ? 'The old cookie no longer works.' : 'The old cookie still worked after sign-out.');
  } catch (error) {
    add('The check could run', false, `Could not complete: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return { ok: steps.every((s) => s.ok), steps };
}
