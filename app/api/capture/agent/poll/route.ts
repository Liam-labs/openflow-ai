/**
 * GET /api/capture/agent/poll  (Bearer device token)  ->  200 { job: { id, params } }  or  204 after about 20 seconds with no job
 * The agent calls this again straight away each time. It is how the device hears about a request without opening a port.
 * A revoked or unknown token gets 401 REVOKED.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import { bearer, touchDevice } from '@/lib/capture/devices';
import { deviceFromToken, nextJob } from '@/lib/capture/jobs';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/capture/agent/poll', async (request: NextRequest) => {
  const device = await deviceFromToken(bearer(request));
  if (!device) return NextResponse.json({ error: 'This device is not allowed to send screenshots.', code: 'REVOKED' }, { status: 401 });
  void touchDevice(device.id);
  const job = await nextJob(device.id);
  return job ? NextResponse.json({ job }) : new NextResponse(null, { status: 204 });
});
