/**
 * GET /api/capture/agent/state   (Bearer device token)  ->  { deviceId, name, paused }
 * The agent asks this at start-up and when it reconnects. A revoked or unknown token gets 401 REVOKED,
 * and the agent then stops and removes its own start-up entry.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import { authenticateDevice, bearer, touchDevice } from '@/lib/capture/devices';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/capture/agent/state', async (request: NextRequest) => {
  const device = await authenticateDevice(bearer(request));
  if (!device) return NextResponse.json({ error: 'This device is not allowed to send screenshots.', code: 'REVOKED' }, { status: 401 });
  await touchDevice(device.id);
  return NextResponse.json({ deviceId: device.id, name: device.name, paused: device.paused });
});
