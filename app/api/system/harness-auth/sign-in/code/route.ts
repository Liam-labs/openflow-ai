/** POST /api/system/harness-auth/sign-in/code { signInId, code }: type the pasted code into a waiting Claude sign-in. The code is never logged or echoed. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { submitCode } from '@/lib/harness-auth/service';
import { failure, readBody } from '@/lib/harness-auth/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const body = await readBody(request);
  if (body instanceof NextResponse) return body;
  try {
    return NextResponse.json({ signIn: await submitCode(body.signInId, body.code) });
  } catch (error) {
    return failure(error);
  }
}
