/**
 * POST /api/agent/switch-model — requireAuthOrLocal convenience route.
 *
 * The canonical action is roster.switchModel on /api/agent (bearer token).
 * This route lets the dashboard (localhost) and token-bearing callers invoke
 * the same handler without constructing a full agent-API request envelope.
 *
 * Body: { channelId, agentId?, agentName?, targetModel }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { switchModel } from '@/app/api/agent/actions/roster';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';

export const dynamic = 'force-dynamic';

function stubAuth(): AgentAuthContext {
  return {
    tokenId: 'rest:switch-model',
    tokenName: '/api/agent/switch-model',
    scope: 'write',
    createdBy: 'rest-route',
  };
}

async function handler(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const result = await switchModel(body as AgentApiRequest, stubAuth());
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode || 500;
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal error' },
      { status: statusCode >= 400 && statusCode < 600 ? statusCode : 500 },
    );
  }
}

export const POST = tracked('/api/agent/switch-model', handler);
