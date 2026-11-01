/**
 * Dashboard sign-in: one owner password and browser sessions.
 *
 * Why it exists: on this machine the dashboard is trusted without a login (lib/local-trust.ts). From another computer there is
 * nothing to trust, and an API token is a header a browser cannot send. Once a password is set, a browser that is not on this
 * machine signs in at /login and is then accepted by requireAuthOrLocal like the owner at the keyboard.
 *
 * What a session is allowed: everything requireAuthOrLocal guards (the dashboard, and so every agent the dashboard drives). It is
 * NOT accepted by requireTokenOrLocal (restart WSL, systemd, folders, dev servers) or by the agent API (/api/agent): those stay
 * for this machine and for tokens.
 *
 * Storage: .AppData/dashboard-auth.json (0600). The password is a scrypt hash; a session is stored as the SHA-256 of its random
 * cookie value, so the file alone cannot be used to sign in.
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import path from 'path';
import type { NextRequest } from 'next/server';
import { DataPaths } from './data-paths';
import { readJsonFileStrict, writeJsonFile, withFileLock } from './data-io';
import { splitHost } from './local-trust';

export const SESSION_COOKIE = 'devflow_session';

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;       // signed out after a week unused
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;  // and after 30 days whatever the use
const SEEN_WRITE_EVERY_MS = 5 * 60 * 1000;                    // "last seen" is saved at most this often
const MAX_SESSIONS = 50;

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

export const LOGIN_FAILURE_LIMIT = 5;                          // per address, in the window
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_GLOBAL_LIMIT = 40;                          // across all addresses, per hour (a spread-out guesser)
export const LOGIN_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

interface SessionRecord {
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string;
  userAgent: string;
}

interface AttemptRecord {
  count: number;
  firstAt: number;
}

export interface DashboardAuthStore {
  version: 1;
  password?: { hash: string; setAt: string };
  setupCodeConsumed?: string;
  sessions: Record<string, SessionRecord>;
  attempts: Record<string, AttemptRecord>;
  globalAttempts: AttemptRecord;
}

function emptyStore(): DashboardAuthStore {
  return { version: 1, sessions: {}, attempts: {}, globalAttempts: { count: 0, firstAt: 0 } };
}

// ─── Password hashing (pure apart from the random salt) ─────────────────────────────────────────────

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 128 * n * r * 2 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** "scrypt$N$r$p$<salt hex>$<hash hex>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), key.toString('hex')].join('$');
}

export async function verifyPasswordHash(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored || typeof password !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 1 << 20 || r > 32 || p > 16) return false;
  let salt: Buffer;
  let want: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    want = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (!salt.length || want.length !== KEY_LENGTH) return false;
  let got: Buffer;
  try {
    got = await scryptAsync(password, salt, n, r, p);
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

const COMMON_PASSWORDS = new Set([
  'password1234', 'passwordpassword', '123456789012', '1234567890123', 'qwertyuiopas', 'qwertyuiop12', 'letmeinletmein',
  'iloveyou1234', 'administrator', 'welcome12345', 'changeme1234', 'devflow12345', 'openflow1234',
]);

/** Null when the password is acceptable, otherwise a sentence to show the person. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters. A few ordinary words in a row is fine.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) return 'That password is too easy to guess. Pick something else.';
  if (new Set(password).size < 5) return 'That password is too easy to guess. Pick something else.';
  return null;
}

// ─── Pure decisions ────────────────────────────────────────────────────────────────────────────────

export function sessionKey(cookieValue: string): string {
  return createHash('sha256').update(cookieValue).digest('hex');
}

export function parseCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return /^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** Is this stored session still good at `now`? */
export function sessionUsable(record: SessionRecord | undefined, now: number): boolean {
  if (!record) return false;
  if (now >= record.expiresAt) return false;
  if (now - record.lastSeenAt >= SESSION_IDLE_MS) return false;
  return true;
}

/** May the next login attempt from this address go ahead? `retryAfterSeconds` is set when not. */
export function loginThrottle(store: Pick<DashboardAuthStore, 'attempts' | 'globalAttempts'>, ip: string, now: number): { allowed: boolean; retryAfterSeconds?: number } {
  const own = store.attempts[ip];
  if (own && now - own.firstAt < LOGIN_WINDOW_MS && own.count >= LOGIN_FAILURE_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((own.firstAt + LOGIN_WINDOW_MS - now) / 1000)) };
  }
  const global = store.globalAttempts;
  if (global && now - global.firstAt < LOGIN_GLOBAL_WINDOW_MS && global.count >= LOGIN_GLOBAL_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((global.firstAt + LOGIN_GLOBAL_WINDOW_MS - now) / 1000)) };
  }
  return { allowed: true };
}

/**
 * A request that carries the session cookie may change things only if it came from our own page: a page on another site can make the
 * browser attach the cookie (SameSite=Strict stops most of that; this is the second lock). Reads pass.
 */
export function sameOriginForWrites(method: string, facts: { host: string | null; origin: string | null; secFetchSite: string | null }): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (facts.secFetchSite && facts.secFetchSite !== 'same-origin' && facts.secFetchSite !== 'none') return false;
  if (facts.origin) {
    let originHost: string;
    try { originHost = new URL(facts.origin).host.toLowerCase(); } catch { return false; }
    const want = splitHost(facts.host);
    const got = splitHost(originHost);
    if (!want || !got) return false;
    return want.name === got.name && want.port === got.port;
  }
  // No Origin on a state-changing request: only a non-browser sends that, and a non-browser has no cookie to attach.
  return facts.secFetchSite === 'same-origin' || facts.secFetchSite === 'none' || facts.secFetchSite === null;
}

export function cookieHeader(value: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${opts.maxAgeSeconds}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedCookieHeader(secure: boolean): string {
  return cookieHeader('', { secure, maxAgeSeconds: 0 });
}

export function requestIsHttps(headers: { get(name: string): string | null }, url: string): boolean {
  const proto = (headers.get('x-forwarded-proto') || '').split(',').pop()?.trim().toLowerCase();
  if (proto) return proto === 'https';
  return url.startsWith('https:');
}

// ─── Store ─────────────────────────────────────────────────────────────────────────────────────────

async function load(): Promise<DashboardAuthStore> {
  const data = await readJsonFileStrict<Partial<DashboardAuthStore>>(DataPaths.dashboardAuth, {});
  return { ...emptyStore(), ...data, sessions: data.sessions ?? {}, attempts: data.attempts ?? {}, globalAttempts: data.globalAttempts ?? { count: 0, firstAt: 0 } };
}

async function mutate<T>(fn: (store: DashboardAuthStore) => Promise<T> | T): Promise<T> {
  return withFileLock(DataPaths.dashboardAuth, async () => {
    const store = await load();
    const result = await fn(store);
    await writeJsonFile(DataPaths.dashboardAuth, store);
    return result;
  });
}

export async function hasPassword(): Promise<boolean> {
  try {
    return !!(await load()).password;
  } catch {
    return true;      // an unreadable file must not read as "no password": that would open the first-come path
  }
}

/** Set (or replace) the password. Every existing session is ended: whoever was signed in must sign in again. */
export async function setPassword(newPassword: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const problem = passwordProblem(newPassword);
  if (problem) return { ok: false, error: problem };
  const hash = await hashPassword(newPassword);
  await mutate((store) => {
    store.password = { hash, setAt: new Date().toISOString() };
    store.sessions = {};
    store.attempts = {};
    store.globalAttempts = { count: 0, firstAt: 0 };
  });
  return { ok: true };
}

/**
 * Set the FIRST password: the same as setPassword, but the "is there a password yet" check and the save happen under one file lock,
 * so of two simultaneous first calls exactly one succeeds. The other gets { ok: false, taken: true }.
 */
export async function setFirstPassword(newPassword: string): Promise<{ ok: true } | { ok: false; error: string; taken?: true }> {
  const problem = passwordProblem(newPassword);
  if (problem) return { ok: false, error: problem };
  const hash = await hashPassword(newPassword);
  const saved = await mutate((store) => {
    if (store.password) return false;
    store.password = { hash, setAt: new Date().toISOString() };
    store.sessions = {};
    store.attempts = {};
    store.globalAttempts = { count: 0, firstAt: 0 };
    return true;
  });
  return saved ? { ok: true } : { ok: false, error: 'A password is already set.', taken: true };
}

/** Lock-out recovery (run on the machine): forget the password and every session. Sign-in is then off until a new one is set. */
export async function clearPassword(): Promise<void> {
  await mutate((store) => {
    delete store.password;
    store.sessions = {};
    store.attempts = {};
    store.globalAttempts = { count: 0, firstAt: 0 };
  });
}

export type LoginResult =
  | { ok: true; cookie: string; maxAgeSeconds: number }
  | { ok: false; reason: 'no_password' | 'wrong' | 'throttled'; retryAfterSeconds?: number };

export async function login(password: string, ip: string, userAgent: string, now = Date.now()): Promise<LoginResult> {
  const snapshot = await load();
  if (!snapshot.password) return { ok: false, reason: 'no_password' };
  const gate = loginThrottle(snapshot, ip, now);
  if (!gate.allowed) return { ok: false, reason: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };

  const good = typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH && (await verifyPasswordHash(password, snapshot.password.hash));

  return mutate((store) => {
    if (!good) {
      const own = store.attempts[ip];
      store.attempts[ip] = own && now - own.firstAt < LOGIN_WINDOW_MS ? { count: own.count + 1, firstAt: own.firstAt } : { count: 1, firstAt: now };
      const g = store.globalAttempts;
      store.globalAttempts = g.firstAt && now - g.firstAt < LOGIN_GLOBAL_WINDOW_MS ? { count: g.count + 1, firstAt: g.firstAt } : { count: 1, firstAt: now };
      return { ok: false as const, reason: 'wrong' as const };
    }
    delete store.attempts[ip];
    const cookie = randomBytes(32).toString('base64url');
    // Drop dead sessions, and the oldest ones beyond the cap.
    for (const [key, rec] of Object.entries(store.sessions)) if (!sessionUsable(rec, now)) delete store.sessions[key];
    const keys = Object.keys(store.sessions).sort((a, b) => store.sessions[a].createdAt - store.sessions[b].createdAt);
    while (keys.length >= MAX_SESSIONS) delete store.sessions[keys.shift()!];
    store.sessions[sessionKey(cookie)] = { createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_ABSOLUTE_MS, ip, userAgent: userAgent.slice(0, 200) };
    return { ok: true as const, cookie, maxAgeSeconds: Math.floor(SESSION_ABSOLUTE_MS / 1000) };
  });
}

export async function logout(cookieValue: string | null): Promise<void> {
  if (!cookieValue) return;
  await mutate((store) => { delete store.sessions[sessionKey(cookieValue)]; });
}

/** Is this cookie a live session? Also keeps "last seen" fresh (written at most every 5 minutes). */
export async function validateSessionCookie(cookieValue: string | null, now = Date.now()): Promise<boolean> {
  if (!cookieValue) return false;
  let store: DashboardAuthStore;
  try {
    store = await load();
  } catch {
    return false;
  }
  const key = sessionKey(cookieValue);
  const record = store.sessions[key];
  if (!sessionUsable(record, now)) return false;
  if (now - record.lastSeenAt >= SEEN_WRITE_EVERY_MS) {
    await mutate((s) => { if (s.sessions[key]) s.sessions[key].lastSeenAt = now; }).catch(() => undefined);
  }
  return true;
}

/**
 * The request carries a live session AND is allowed to act with it (same-origin for anything that changes data).
 * This is the one check the guards in lib/api-auth.ts call.
 */
export async function requestHasSession(request: NextRequest): Promise<boolean> {
  const cookie = parseCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!cookie) return false;
  const ok = sameOriginForWrites(request.method, {
    host: request.headers.get('host') || request.nextUrl?.host || null,
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
  });
  if (!ok) return false;
  return validateSessionCookie(cookie);
}

export async function sessionCount(): Promise<number> {
  const now = Date.now();
  const store = await load();
  return Object.values(store.sessions).filter((s) => sessionUsable(s, now)).length;
}

// The installer writes only a hash. Claiming it and setting the password use the
// same lock as every other password writer, so two first-login requests cannot win.
export type SetupLoginResult =
  | { ok: true; cookie: string; maxAgeSeconds: number }
  | { ok: false; reason: 'already_configured' | 'invalid_code' | 'throttled' | 'bad_password'; error?: string; retryAfterSeconds?: number };

export async function claimSetupCode(code: unknown, password: unknown, ip: string, userAgent: string, now = Date.now()): Promise<SetupLoginResult> {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, reason: 'bad_password', error: problem };
  return mutate(async (store): Promise<SetupLoginResult> => {
    if (store.password) return { ok: false, reason: 'already_configured' };
    const gate = loginThrottle(store, ip, now);
    if (!gate.allowed) return { ok: false, reason: 'throttled', retryAfterSeconds: gate.retryAfterSeconds };
    const issued = await readJsonFileStrict<{ hash?: string; expiresAt?: number }>(path.join(path.dirname(DataPaths.dashboardAuth), 'setup-code.json'), {});
    const supplied = typeof code === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(code) ? sessionKey(code) : '';
    const valid = supplied && supplied !== store.setupCodeConsumed && typeof issued.hash === 'string' && /^[a-f0-9]{64}$/.test(issued.hash)
      && typeof issued.expiresAt === 'number' && now < issued.expiresAt
      && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(issued.hash, 'hex'));
    if (!valid) {
      const own = store.attempts[ip];
      store.attempts[ip] = own && now - own.firstAt < LOGIN_WINDOW_MS ? { count: own.count + 1, firstAt: own.firstAt } : { count: 1, firstAt: now };
      const g = store.globalAttempts;
      store.globalAttempts = g.firstAt && now - g.firstAt < LOGIN_GLOBAL_WINDOW_MS ? { count: g.count + 1, firstAt: g.firstAt } : { count: 1, firstAt: now };
      return { ok: false, reason: 'invalid_code' };
    }
    store.setupCodeConsumed = supplied;
    store.password = { hash: await hashPassword(password as string), setAt: new Date(now).toISOString() };
    store.attempts = {};
    store.globalAttempts = { count: 0, firstAt: 0 };
    const cookie = randomBytes(32).toString('base64url');
    store.sessions = { [sessionKey(cookie)]: { createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_ABSOLUTE_MS, ip, userAgent: userAgent.slice(0, 200) } };
    return { ok: true, cookie, maxAgeSeconds: Math.floor(SESSION_ABSOLUTE_MS / 1000) };
  });
}
