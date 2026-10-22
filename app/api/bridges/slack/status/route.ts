/**
 * GET /api/bridges/slack/status
 *
 * Returns the current Slack bridge status: connection state,
 * mapping counts, last sync time, and recent errors.
 */

import { NextResponse } from 'next/server';
import { getBridgeStatus } from '@/slack-integration/lib/slack-bridge';
import { tracked } from '@/lib/api-tracking';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const GET = tracked('/api/bridges/slack/status', async (request: NextRequest) => {
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
