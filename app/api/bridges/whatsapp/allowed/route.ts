/**
 * GET  /api/bridges/whatsapp/allowed  — proxy to bridge GET /settings/allowed
 * POST /api/bridges/whatsapp/allowed  — proxy to bridge POST /settings/allowed (add number or LID)
 * DELETE /api/bridges/whatsapp/allowed — proxy to bridge DELETE /settings/allowed (remove number or LID)
 */

import { NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

const BRIDGE_URL = 'http://localhost:8301';

export const GET = tracked('/api/bridges/whatsapp/allowed', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const res = await fetch(`${BRIDGE_URL}/settings/allowed`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Bridge error (${res.status})` }, { status: res.status });
    }
    const data = await res.json() as { numbers: string[]; lids: string[] };
    return NextResponse.json(data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Bridge unreachable: ${msg}` }, { status: 503 });
  }
});

export const POST = tracked('/api/bridges/whatsapp/allowed', async (request: Request) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;

  try {
    const body = await request.json() as { number?: string; lid?: string };
    const res = await fetch(`${BRIDGE_URL}/settings/allowed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as Record<string, unknown>;
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Bridge unreachable: ${msg}` }, { status: 503 });
  }
});

export const DELETE = tracked('/api/bridges/whatsapp/allowed', async (request: Request) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;

  try {
    const body = await request.json() as { number?: string; lid?: string };
    const res = await fetch(`${BRIDGE_URL}/settings/allowed`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as Record<string, unknown>;
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Bridge unreachable: ${msg}` }, { status: 503 });
  }
});
