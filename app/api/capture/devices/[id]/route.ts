/**
 * PATCH  /api/capture/devices/<id>  { name?, paused? }   rename a device, or pause and resume it
 * DELETE /api/capture/devices/<id>                      revoke it: its token is refused from the next request
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { updateDevice, revokeDevice, appendLog } from '@/lib/capture/devices';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: 'No such device.', code: 'NOT_FOUND' }, { status: 404 });

export const PATCH = tracked('/api/capture/devices/[id]', async (request: NextRequest, context: Ctx) => {
  const denied = await requireAuthOrLocal(request, 'admin');
  if (denied) return denied;
  const { id } = await context.params;
  let body: Record<string, unknown> = {};
  try { const p = await request.json(); if (p && typeof p === 'object' && !Array.isArray(p)) body = p as Record<string, unknown>; } catch { /* empty */ }
  if (body.name === undefined && typeof body.paused !== 'boolean') return NextResponse.json({ error: 'Send a name or paused.', code: 'BAD_REQUEST' }, { status: 400 });
  const device = await updateDevice(id, body);
  if (!device) return notFound();
  if (body.name !== undefined) appendLog({ op: 'rename', requester: 'owner', deviceId: id, deviceName: device.name });
  if (typeof body.paused === 'boolean') appendLog({ op: body.paused ? 'pause' : 'resume', requester: 'owner', deviceId: id, deviceName: device.name });
  return NextResponse.json({ device });
});

export const DELETE = tracked('/api/capture/devices/[id]', async (request: NextRequest, context: Ctx) => {
  const denied = await requireAuthOrLocal(request, 'admin');
  if (denied) return denied;
  const { id } = await context.params;
  const device = await revokeDevice(id, 'owner');
  if (!device) return notFound();
  appendLog({ op: 'revoke', requester: 'owner', deviceId: id, deviceName: device.name, state: 'revoked' });
  return NextResponse.json({ device });
});
