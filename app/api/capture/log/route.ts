/** GET /api/capture/log?limit=100 -> { entries } newest first. Who asked, which device, the result. Never a picture. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { readLog } from '@/lib/capture/devices';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/capture/log', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'admin');
  if (denied) return denied;
  const limit = Number(request.nextUrl.searchParams.get('limit')) || 100;
  return NextResponse.json({ entries: readLog(limit) });
});
