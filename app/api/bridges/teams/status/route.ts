/**
 * GET /api/bridges/teams/status
 *
 * Returns the current Teams bridge status: connection state,
 * mapping counts, last sync time, and recent errors.
 */

import { NextResponse } from 'next/server';
import { getBridgeStatus } from '@/teams-integration/lib/teams-bridge';
import { tracked } from '@/lib/api-tracking';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const GET = tracked('/api/bridges/teams/status', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const status = await getBridgeStatus();
    return NextResponse.json(status);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
