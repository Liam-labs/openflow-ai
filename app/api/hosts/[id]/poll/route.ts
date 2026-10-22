import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { HOST_ID_RE, verifyHostToken, pollHost } from '@/lib/host-registry';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const { id } = await params;
  if (!verifyHostToken(id, request.headers.get('x-host-token'))) return NextResponse.json({ error: 'host token rejected' }, { status: 403 });
  if (!HOST_ID_RE.test(id)) return NextResponse.json({ error: 'bad host id' }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  const commands = await pollHost(id, body.status, Number(body.version) || undefined, Number(body.wait) || 0);
  return NextResponse.json({ commands });
}
