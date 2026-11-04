/**
 * POST /api/broker/approvals: the signed-in owner approves one exact broker action for an agent or Jack (explain, offer, approve, act).
 * Body: { action, args?, secretNames? }. Returns { approvalId, expiresAt }: one use, ten minutes, only for that exact action.
 * An agent can never call this successfully, so it cannot approve itself: the owner's browser session is required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { requestHasSession } from '@/lib/dashboard-auth';
import { tracked } from '@/lib/api-tracking';
import { createApproval } from '@/lib/credential-broker';
import { BROKER_ACTIONS } from '@/lib/credential-broker-actions';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/broker/approvals', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  if (!(await requestHasSession(request))) {
    return NextResponse.json({ success: false, error: 'Only the signed-in owner can approve this.' }, { status: 403 });
  }
  let body: { action?: unknown; args?: unknown; secretNames?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Send JSON.' }, { status: 400 });
  }
  const names = Array.isArray(body.secretNames) && body.secretNames.every((n) => typeof n === 'string') ? (body.secretNames as string[]) : undefined;
  const made = await createApproval(typeof body.action === 'string' ? body.action : '', body.args, names ?? [], { actions: BROKER_ACTIONS });
  if ('error' in made) return NextResponse.json({ success: false, error: made.error }, { status: 400 });
  return NextResponse.json({ success: true, ...made }, { headers: { 'Cache-Control': 'no-store' } });
});
