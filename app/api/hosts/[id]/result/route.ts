import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { HOST_ID_RE, verifyHostToken, recordResult } from '@/lib/host-registry';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const { id } = await params;
  if (!verifyHostToken(id, request.headers.get('x-host-token'))) return NextResponse.json({ error: 'host token rejected' }, { status: 403 });
  const b = await request.json().catch(() => null);
  if (!HOST_ID_RE.test(id) || !b || typeof b.id !== 'string') return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const known = recordResult(id, { id: b.id, ok: !!b.ok, result: b.result, error: b.error });
  return NextResponse.json({ ok: known });
}
