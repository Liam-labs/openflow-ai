/**
 * GET /api/system/harness-auth: every harness login (claude/codex on the desktop and on the server) with its state, the active sign-in if any,
 * and the agents that depend on it. Design: platform/harness-signin-health.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { listCredentialViews } from '@/lib/harness-auth/service';
import { failure } from '@/lib/harness-auth/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  try {
    return NextResponse.json({ credentials: await listCredentialViews() });
  } catch (error) {
    return failure(error);
  }
}
