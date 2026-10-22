/** POST /api/system/harness-auth/sign-in/cancel { signInId }: stop a sign-in. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { cancelSignIn } from '@/lib/harness-auth/service';
import { failure, readBody } from '@/lib/harness-auth/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const body = await readBody(request);
  if (body instanceof NextResponse) return body;
  try {
    await cancelSignIn(body.signInId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
