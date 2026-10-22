/** Shared plumbing for the /api/system/harness-auth routes: plain JSON errors in the contract's {error, code} shape. */
import { NextRequest, NextResponse } from 'next/server';
import { RequestError } from './service';

export async function readBody(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* fall through */ }
  return NextResponse.json({ error: 'Send a JSON object', code: 'BAD_REQUEST' }, { status: 400 });
}

export function failure(error: unknown): NextResponse {
  if (error instanceof RequestError) {
    return NextResponse.json({ error: error.message, code: error.code, ...(error.extra ?? {}) }, { status: error.status });
  }
  return NextResponse.json({ error: 'Something went wrong on the server', code: 'INTERNAL' }, { status: 500 });
}
