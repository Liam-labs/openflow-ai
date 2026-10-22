import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import {
  deliveryEvidenceTelemetry,
  DeliveryEvidenceTelemetryError,
} from '@/lib/delivery-evidence/telemetry';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const projectId = request.nextUrl.searchParams.get('projectId') ?? undefined;
  const taskId = request.nextUrl.searchParams.get('taskId') ?? undefined;
  const limitValue = request.nextUrl.searchParams.get('limit');
  const limit = limitValue ? Number(limitValue) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) {
    return NextResponse.json({ error: 'Invalid telemetry limit' }, { status: 400 });
  }

  try {
    const events = await deliveryEvidenceTelemetry.read({ projectId, taskId, limit });
    return NextResponse.json({ events, summary: deliveryEvidenceTelemetry.summarize(events) });
  } catch {
    return NextResponse.json({ error: 'Telemetry storage unavailable' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  try {
    const event = await deliveryEvidenceTelemetry.record(body);
    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    const status = error instanceof DeliveryEvidenceTelemetryError ? error.statusCode : 500;
    return NextResponse.json(
      { error: status < 500 ? 'Telemetry event rejected' : 'Telemetry storage unavailable' },
      { status },
    );
  }
}
