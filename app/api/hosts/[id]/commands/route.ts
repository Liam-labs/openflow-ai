import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { HOST_ID_RE, enqueue } from '@/lib/host-registry';

export const dynamic = 'force-dynamic';
const OPS = new Set(['spawn', 'kill', 'has', 'capture', 'inject', 'interrupt', 'status']);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const { id } = await params;
  const b = await request.json().catch(() => null);
  if (!HOST_ID_RE.test(id) || !b || !OPS.has(b.op)) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const waitMs = Math.min(Number(b.waitMs) || 0, 60_000);
  return NextResponse.json(await enqueue(id, b.op, b.args && typeof b.args === 'object' ? b.args : {}, waitMs));
}
