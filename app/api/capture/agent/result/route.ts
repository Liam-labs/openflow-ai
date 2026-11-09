/**
 * POST /api/capture/agent/result?job=<id>&state=<ok|locked|off|blank|error>   (Bearer device token)
 * Body: the JPEG, when state is ok. The server keeps the picture only long enough to answer the request. It is never written to disk.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import { bearer } from '@/lib/capture/devices';
import { deviceFromToken, deliverResult, MAX_IMAGE_BYTES } from '@/lib/capture/jobs';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/capture/agent/result', async (request: NextRequest) => {
  const device = await deviceFromToken(bearer(request));
  if (!device) return NextResponse.json({ error: 'This device is not allowed to send screenshots.', code: 'REVOKED' }, { status: 401 });
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_IMAGE_BYTES) return NextResponse.json({ error: 'Picture too large.', code: 'TOO_LARGE' }, { status: 413 });
  const jobId = request.nextUrl.searchParams.get('job') || '';
  const state = request.nextUrl.searchParams.get('state') || 'error';
  const body = Buffer.from(await request.arrayBuffer());
  const taken = deliverResult(device, jobId, state, body.length ? body : null);
  return taken ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'No such request.', code: 'NOT_FOUND' }, { status: 404 });
});
