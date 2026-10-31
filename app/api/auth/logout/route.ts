/**
 * POST /api/auth/logout
 *
 * Ends the caller's own session and clears the cookie. Open on purpose: it only ever acts on the cookie the caller sent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, clearedCookieHeader, logout, parseCookie, requestIsHttps, sameOriginForWrites } from '@/lib/dashboard-auth';

export async function POST(request: NextRequest) {
  if (!sameOriginForWrites('POST', {
    host: request.headers.get('host') || request.nextUrl?.host || null,
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
  })) {
    return NextResponse.json({ error: 'Sign out from the dashboard page itself.' }, { status: 403 });
  }
  await logout(parseCookie(request.headers.get('cookie'), SESSION_COOKIE));
  return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': clearedCookieHeader(requestIsHttps(request.headers, request.url)), 'Cache-Control': 'no-store' } });
}
