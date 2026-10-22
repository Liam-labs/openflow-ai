/** Authenticated server-owned active-gate discovery for execution hooks. */

import { NextRequest, NextResponse } from 'next/server';
import { hasPermission, rateLimitedResponse, validateApiToken } from '@/lib/api-auth';
import { findActiveDesignReferenceGate } from '@/lib/design-references/store';

export const dynamic = 'force-dynamic';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export async function GET(request: NextRequest) {
  const auth = await validateApiToken(request);
  // A throttled token or a locked address is told so (429 + Retry-After) instead of looking like a bad token; every agent's gate hook calls this.
  if (auth.code === 'RATE_LIMITED') return rateLimitedResponse(auth);
  if (!auth.valid || !auth.token || !hasPermission(auth.token.scope, 'read')) {
    return NextResponse.json({ error: 'Authenticated read token required' }, { status: 401 });
  }

  const workspacePath = request.nextUrl.searchParams.get('workspacePath') ?? '';
  const nativeSessionId = request.nextUrl.searchParams.get('sessionId') ?? '';
  const launcherPids = request.nextUrl.searchParams.getAll('launcherPid');
  if (!workspacePath || workspacePath.length > 4096 || !workspacePath.startsWith('/')) {
    return NextResponse.json({ error: 'canonical workspacePath is required' }, { status: 400 });
  }
  if (nativeSessionId && !SESSION_ID_RE.test(nativeSessionId)) {
    return NextResponse.json({ error: 'sessionId is invalid' }, { status: 400 });
  }
  const sessionIds = [
    ...(nativeSessionId ? [`session:${nativeSessionId}`] : []),
    ...launcherPids
      .filter(value => /^[1-9][0-9]{0,11}$/.test(value))
      .map(value => `pid:${value}`),
  ];
  const result = await findActiveDesignReferenceGate(workspacePath, sessionIds);
  if (result.status === 'identity-mismatch') {
    return NextResponse.json(result, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
  if (result.status === 'ambiguous') {
    return NextResponse.json(result, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
