/**
 * First-run middleware
 *
 * Redirects to /setup when DevFlow hasn't been configured yet, and to /login when the caller is neither on this machine, nor
 * coming through the tunnel, nor signed in with the owner password (see /api/auth/gate).
 *
 * Detection: checks a lightweight API endpoint. Edge runtime cannot
 * access the filesystem directly (no fs/path modules).
 *
 * Excluded paths: /setup, /login, /api/*, /_next/*, static assets
 */

import { NextRequest, NextResponse } from 'next/server';

// Cache the result in-process — once setup is detected, skip further checks
let setupComplete: boolean | null = null;

/**
 * Send the caller to /login (or /setup) on the address they used. A redirect built from request.nextUrl names the server's own idea of its host
 * (localhost), which is wrong behind a proxy or a Tailscale name, and middleware refuses a relative Location, so the address is
 * rebuilt from the Host header (only when it looks like a host) and the protocol the caller used.
 */
function requestOrigin(request: NextRequest): string {
  const host = request.headers.get('host') || '';
  const proto = (request.headers.get('x-forwarded-proto') || '').split(',').pop()?.trim().toLowerCase() === 'https' ? 'https:' : request.nextUrl.protocol;
  return /^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9a-fA-F:.]+\](:\d{1,5})?$/.test(host) ? `${proto}//${host}` : request.nextUrl.origin;
}

function toLogin(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const origin = requestOrigin(request);
  const next = pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname + search)}` : '';
  const res = NextResponse.redirect(new URL(`/login${next}`, origin));
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** Ask this server's own gate whether the caller may see the pages. Anything that goes wrong lets the page load: the API refuses on its own. */
async function mayViewPages(request: NextRequest): Promise<boolean> {
  try {
    // The caller's own headers go along unchanged, so the gate judges the original request (cookie, Host, proxy address).
    const headers = new Headers();
    for (const name of ['cookie', 'host', 'origin', 'sec-fetch-site', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'x-tunnel-auth', 'tailscale-user-login']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // The gate call below comes from this server itself, so its own connection says nothing about the caller. Add the real
    // connection address (written by lib/peer-stamp.ts, never by the caller) to the forwarded chain: a LAN caller who writes
    // "X-Forwarded-For: 127.0.0.1" then arrives as "127.0.0.1, <their LAN address>" and is not local. An HTTP/1.0 peer is a plain proxy.
    const peer = request.headers.get('x-openflow-peer');
    if (peer) headers.set('x-forwarded-for', [headers.get('x-forwarded-for'), peer].filter(Boolean).join(', '));
    if (request.headers.get('x-openflow-http-version') === '1.0') headers.set('via', '1.0 http10-peer');
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/auth/gate`, { headers, cache: 'no-store' });
    if (!res.ok) return true;
    return (await res.json()).allow !== false;
  } catch {
    return true;
  }
}

export async function middleware(request: NextRequest) {
  // In-process cache: once setup is detected, skip the setup check until restart
  if (setupComplete) {
    if (await mayViewPages(request)) return NextResponse.next();
    return toLogin(request);
  }

  // Check setup status via internal API (Edge-compatible — no fs/path)
  try {
    // Always this server's own address: the Host header of the request must not decide where this call goes.
    const baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;
    const res = await fetch(`${baseUrl}/api/setup/status`, {
      headers: { 'x-middleware-check': '1' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.setupComplete) {
        setupComplete = true;
        if (await mayViewPages(request)) return NextResponse.next();
        return toLogin(request);
      }
    }
  } catch {
    // If the status endpoint fails, let the request through (don't block the app)
    return NextResponse.next();
  }

  // Not configured → redirect to setup wizard, on the address the caller used. request.nextUrl names the server's own idea of its host
  // and port (inside a container that is localhost:3000), which sent anyone who published another port to the wrong service.
  return NextResponse.redirect(new URL('/setup', requestOrigin(request)));
}

export const config = {
  matcher: [
    '/((?!setup|login|api|_next|favicon\\.ico|.*\\..*).*)',
  ],
};
