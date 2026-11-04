/**
 * POST /api/broker/run: run one named broker action with a stored key, without the caller ever seeing the key.
 * Body: { action, args?, secretNames?, approvalId? }. An agent or Jack needs an approvalId for this exact action (see /api/broker/approvals);
 * the signed-in owner does not. The answer holds a status and an output cleaned of every secret, never a value.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal, validateApiToken } from '@/lib/api-auth';
import { requestHasSession } from '@/lib/dashboard-auth';
import { tracked } from '@/lib/api-tracking';
import { runWithSecret, type Actor, type BrokerStatus } from '@/lib/credential-broker';
import { BROKER_ACTIONS } from '@/lib/credential-broker-actions';

export const dynamic = 'force-dynamic';

const HTTP: Partial<Record<BrokerStatus, number>> = { 'bad-request': 400, 'unknown-action': 400, refused: 403, 'needs-approval': 403, locked: 423, 'missing-key': 409 };

export const POST = tracked('/api/broker/run', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  let body: { action?: unknown; args?: unknown; secretNames?: unknown; approvalId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, status: 'bad-request', message: 'Send JSON.' }, { status: 400 });
  }
  // The caller is never taken from the body: the owner is the signed-in browser, anyone else is an agent named by its token.
  let actor: Actor;
  if (await requestHasSession(request)) {
    actor = { kind: 'owner' };
  } else {
    const t = await validateApiToken(request);
    actor = { kind: 'agent', name: t.valid && t.token ? t.token.name : 'local agent' };
  }
  const result = await runWithSecret(
    {
      action: typeof body.action === 'string' ? body.action : '',
      args: body.args,
      secretNames: Array.isArray(body.secretNames) && body.secretNames.every((n) => typeof n === 'string') ? (body.secretNames as string[]) : undefined,
      approvalId: typeof body.approvalId === 'string' ? body.approvalId : undefined,
    },
    actor,
    { actions: BROKER_ACTIONS },
  );
  return NextResponse.json({ success: result.ok, ...result }, { status: result.ok ? 200 : (HTTP[result.status] ?? 200), headers: { 'Cache-Control': 'no-store' } });
});
