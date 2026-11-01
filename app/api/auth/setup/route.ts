import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/api-auth';
import { claimSetupCode, cookieHeader, hasPassword, requestIsHttps, sameOriginForWrites } from '@/lib/dashboard-auth';

export const dynamic = 'force-dynamic';
const json = (body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function GET() {
  return json({ needsSetup: !(await hasPassword()), serverMode: process.env.DEVFLOW_SERVER_MODE === '1' });
}

export async function POST(request: NextRequest) {
  if (!sameOriginForWrites('POST', {
    host: request.headers.get('host') || request.nextUrl.host,
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
  })) return json({ error: 'Create your login from the setup page itself.' }, 403);
  let body: { code?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
  } catch { return json({ error: 'Send the setup code and new password as JSON.' }, 400); }
  const result = await claimSetupCode(body.code, body.newPassword, getClientIp(request), request.headers.get('user-agent') || '');
  if (result.ok) return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(result.cookie, { secure: requestIsHttps(request.headers, request.url), maxAgeSeconds: result.maxAgeSeconds }) });
  if (result.reason === 'already_configured') return json({ code: result.reason, error: 'A login already exists. Sign in instead.' }, 409);
  if (result.reason === 'throttled') return json({ code: result.reason, error: 'Too many attempts. Try again later.', retryAfterSeconds: result.retryAfterSeconds }, 429, { 'Retry-After': String(result.retryAfterSeconds ?? 60) });
  if (result.reason === 'bad_password') return json({ code: result.reason, error: result.error }, 400);
  return json({ code: result.reason, error: 'That setup code is invalid or expired. Generate a new code on the server.' }, 401);
}
