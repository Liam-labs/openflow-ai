/** POST /api/capture/agent/self-revoke (Bearer device token). The uninstaller calls this so a removed device cannot be used again. */
import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import { authenticateDevice, bearer, revokeDevice, appendLog } from '@/lib/capture/devices';
import { dropDevice } from '@/lib/capture/jobs';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/capture/agent/self-revoke', async (request: NextRequest) => {
  const device = await authenticateDevice(bearer(request));
  if (!device) return NextResponse.json({ error: 'Already revoked.', code: 'REVOKED' }, { status: 401 });
  await revokeDevice(device.id, 'device');
  dropDevice(device.id);
  appendLog({ op: 'self-revoke', requester: 'device', deviceId: device.id, deviceName: device.name, state: 'revoked' });
  return NextResponse.json({ ok: true });
});
