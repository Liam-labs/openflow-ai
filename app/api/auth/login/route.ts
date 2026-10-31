/**
 * POST /api/auth/login  { password }
 *
 * Sign in a browser with the owner password (lib/dashboard-auth.ts). Open on purpose: it is the way in. Guesses are throttled per
 * address and across all addresses, and the page that posts here must be our own.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/api-auth';
import { cookieHeader, login, requestIsHttps, sameOriginForWrites } from '@/lib/dashboard-auth';

const json = (body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function POST(request: NextRequest) {
  if (!sameOriginForWrites('POST', {
    host: request.headers.get('host') || request.nextUrl?.host || null,
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
  })) {
    return json({ error: 'Sign in from the dashboard page itself.' }, 403);
  }

  let password: unknown;
  try {
    password = ((await request.json()) as { password?: unknown }).password;
  } catch {
    return json({ error: 'Send the password as JSON.' }, 400);
  }
  if (typeof password !== 'string' || !password) return json({ error: 'Enter the password.' }, 400);

  const result = await login(password, getClientIp(request), request.headers.get('user-agent') || '');
  if (result.ok) {
    return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(result.cookie, { secure: requestIsHttps(request.headers, request.url), maxAgeSeconds: result.maxAgeSeconds }) });
  }
  if (result.reason === 'throttled') {
    return json({ error: 'Too many wrong passwords. Try again later.', retryAfterSeconds: result.retryAfterSeconds }, 429, { 'Retry-After': String(result.retryAfterSeconds ?? 60) });
  }
  if (result.reason === 'no_password') {
    return json({ error: 'No password has been set yet. Set one on the computer that runs this (see the setup page or scripts/devflow-password).', code: 'no_password' }, 409);
  }
  return json({ error: 'That password is not right.' }, 401);
}
