/** POST /api/system/harness-auth/restart-blocked { credentialId }: respawn the running agents that were blocked on that login, so they pick up the new one. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { restartBlocked } from '@/lib/harness-auth/service';
import { failure, readBody } from '@/lib/harness-auth/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const body = await readBody(request);
  if (body instanceof NextResponse) return body;
  try {
    return NextResponse.json(await restartBlocked(body.credentialId, `http://127.0.0.1:${process.env.PORT ?? 3000}`));
  } catch (error) {
    return failure(error);
  }
}
