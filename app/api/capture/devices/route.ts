/** GET /api/capture/devices -> { devices } : every device, active and revoked. Never includes a token or its hash. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { listDevices } from '@/lib/capture/devices';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/capture/devices', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'admin');
  if (denied) return denied;
  return NextResponse.json({ devices: await listDevices() });
});
