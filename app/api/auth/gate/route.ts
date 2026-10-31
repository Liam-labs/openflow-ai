/**
 * GET /api/auth/gate
 *
 * Asked by middleware.ts for every page request: may this caller see the dashboard pages, or should it be sent to /login?
 * Open on purpose: it answers one boolean about the caller's own request.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isCloudflaredRequest, isLocalRequest } from '@/lib/api-auth';
import { requestHasSession } from '@/lib/dashboard-auth';
import { noteTailnetVisit } from '@/lib/wizards/tailscale-visits';

export async function GET(request: NextRequest) {
  const allow = isLocalRequest(request) || isCloudflaredRequest(request) || (await requestHasSession(request));
  noteTailnetVisit(request.headers, allow);
  return NextResponse.json({ allow }, { headers: { 'Cache-Control': 'no-store' } });
}
