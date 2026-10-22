import { NextRequest, NextResponse } from 'next/server';
import { getListeningPorts } from '@/lib/port-utils';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/ports', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const ports = await getListeningPorts();
    return NextResponse.json({ ports });
  } catch (error) {
    console.error('Error getting ports:', error);
    return NextResponse.json({ success: false, ports: [], error: 'Failed to get ports' });
  }
});
