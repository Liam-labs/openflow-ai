/**
 * POST /api/capture/enrol-code  ->  { code, expiresAt }
 * The signed-in owner asks for a one-time code for a new device. Riley Voice puts it inside the set-up file it hands the device,
 * so nobody pastes or types it. The code works once and lasts 45 minutes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { mintEnrolCode } from '@/lib/capture/devices';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/capture/enrol-code', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'admin');
  if (denied) return denied;
  return NextResponse.json(await mintEnrolCode());
});
