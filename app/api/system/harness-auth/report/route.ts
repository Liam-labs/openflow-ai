/** POST /api/system/harness-auth/report: the watcher (scripts/harness_health.py) says what it sees on its machine. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { validateReport } from '@/lib/harness-auth/model';
import { recordReport } from '@/lib/harness-auth/service';
import { failure, readBody } from '@/lib/harness-auth/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;
  const body = await readBody(request);
  if (body instanceof NextResponse) return body;
  const checked = validateReport(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error, code: 'BAD_REPORT' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await recordReport(checked.value)) });
  } catch (error) {
    return failure(error);
  }
}
