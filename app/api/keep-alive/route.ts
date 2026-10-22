/**
 * Keep Alive API (Frontend-facing)
 *
 * Browser-callable route for the Keep Alive modal.
 * No Bearer token required — calls the handler directly server-side.
 *
 * GET  /api/keep-alive?channelId=x&agentId=y  - Get keep-alive status
 * POST /api/keep-alive                         - start/stop/status/update
 */

import { NextRequest, NextResponse } from 'next/server';
import { keepAlive } from '@/app/api/agent/actions/keep-alive';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { tracked } from '@/lib/api-tracking';
import { requireAuthOrLocal, validateApiToken } from '@/lib/api-auth';

/**
 * Derive the real auth context from the incoming request.
 * Uses the validated Bearer token identity when present, falling back
 * to a minimal internal context for localhost-originated requests.
 * Never returns a hardcoded bypass — every request carries its actual identity.
 */
async function deriveAuthContext(request: NextRequest): Promise<AgentAuthContext> {
  const authResult = await validateApiToken(request);
  if (authResult.valid && authResult.token) {
    return {
      tokenId: authResult.token.id,
      tokenName: authResult.token.name,
      scope: authResult.token.scope,
      createdBy: authResult.token.createdBy,
    };
  }
  // No valid Bearer token — localhost request (already cleared by requireAuthOrLocal)
  return {
    tokenId: 'internal',
    tokenName: 'keep-alive-localhost',
    scope: 'read',
    createdBy: 'system',
  };
}

export const GET = tracked('/api/keep-alive', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const { searchParams } = request.nextUrl;
  const channelId = searchParams.get('channelId');
  const agentId = searchParams.get('agentId');

  if (!channelId || !agentId) {
    return NextResponse.json(
      { success: false, error: 'channelId and agentId are required' },
      { status: 400 }
    );
  }

  try {
    const auth = await deriveAuthContext(request);
    const result = await keepAlive(
      { action: 'roster.keepAlive', mode: 'status', channelId, agentId } as AgentApiRequest,
      auth
    );
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
});

export const POST = tracked('/api/keep-alive', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const { mode } = body;
  if (!mode || !['start', 'stop', 'status', 'update'].includes(mode as string)) {
    return NextResponse.json(
      { success: false, error: 'mode is required (start, stop, status, update)' },
      { status: 400 }
    );
  }

  try {
    const auth = await deriveAuthContext(request);
    const result = await keepAlive(
      { action: 'roster.keepAlive', ...body } as AgentApiRequest,
      auth
    );
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: err instanceof Error && 'statusCode' in err ? (err as { statusCode: number }).statusCode : 400 }
    );
  }
});
