/**
 * POST /api/roster/prepare-restart
 *
 * Frontend-facing route for the "Prepare Restart" button.
 * No Bearer token required — dashboard calls this directly.
 * Delegates to roster.prepareRestart action.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prepareRestart } from '../../agent/actions/roster';
import { requireAuthOrLocal } from '@/lib/api-auth';
import type { AgentAuthContext } from '@/lib/types';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

const INTERNAL_AUTH: AgentAuthContext = {
  tokenId: 'internal',
  tokenName: 'dashboard',
  scope: 'admin',
  createdBy: 'system',
};

export const POST = tracked('/api/roster/prepare-restart', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const result = await prepareRestart(body, INTERNAL_AUTH);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[roster/prepare-restart] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to prepare restart' },
      { status: 500 }
    );
  }
});
