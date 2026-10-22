/** POST /api/system/harness-auth/sign-in { credentialId }: start a terminal-free sign-in on the machine that owns that login. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { startSignIn } from '@/lib/harness-auth/service';
import { failure, readBody } from '@/lib/harness-auth/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const body = await readBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const { signIn, alreadyActive } = await startSignIn(body.credentialId);
    if (alreadyActive) return NextResponse.json({ error: 'A sign-in is already running for this login', code: 'SIGN_IN_ACTIVE', signIn }, { status: 409 });
    return NextResponse.json({ signIn });
  } catch (error) {
    return failure(error);
  }
}
