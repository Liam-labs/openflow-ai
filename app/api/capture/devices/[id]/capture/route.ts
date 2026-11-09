/**
 * POST /api/capture/devices/<id>/capture  { monitor?, scale?, quality?, requester? }
 * Answers with the JPEG (image/jpeg) when the device took one. Otherwise answers JSON { state, message } with the reason:
 * offline, paused, locked, off, blank, error, timeout, busy or revoked. Every request is logged with who asked.
 * The owner may call this. Agent access (a Yes/No card for each agent's first request) is a separate step and is not built yet,
 * so for now an agent needs an admin token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { stateFile, type Device } from '@/lib/capture/devices';
import { requestCapture } from '@/lib/capture/jobs';
import { readJsonFileStrict } from '@/lib/data-io';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/capture/devices/[id]/capture', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const denied = await requireAuthOrLocal(request, 'admin');
  if (denied) return denied;
  const { id } = await context.params;
  const raw = await readJsonFileStrict<{ devices?: Device[] }>(stateFile(), {});
  const device = (raw?.devices ?? []).find((d) => d.id === id);
  if (!device) return NextResponse.json({ error: 'No such device.', code: 'NOT_FOUND' }, { status: 404 });
  let body: Record<string, unknown> = {};
  try { const p = await request.json(); if (p && typeof p === 'object' && !Array.isArray(p)) body = p as Record<string, unknown>; } catch { /* the body is optional */ }
  const requester = typeof body.requester === 'string' && body.requester.trim() ? body.requester.trim().slice(0, 60) : 'owner';
  const result = await requestCapture(device, requester, body as Record<string, unknown>);
  if (result.state === 'ok' && result.image) {
    return new NextResponse(new Uint8Array(result.image), { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } });
  }
  return NextResponse.json({ state: result.state, message: result.message }, { status: result.state === 'revoked' ? 410 : 200 });
});
