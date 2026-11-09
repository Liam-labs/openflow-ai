/**
 * POST /api/capture/enroll  { code, name?, platform? }  ->  { deviceId, token, name }
 * The device trades its one-time code for a token. No sign-in is possible here, so the code is the proof, and the route
 * refuses a caller after 10 wrong tries in 15 minutes. The token is shown once and only its hash is kept.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import { getClientIp } from '@/lib/api-auth';
import { exchangeCode, appendLog } from '@/lib/capture/devices';

export const dynamic = 'force-dynamic';

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;
const fails = new Map<string, number[]>();

function tooMany(ip: string, now: number): boolean {
  const recent = (fails.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  fails.set(ip, recent);
  return recent.length >= MAX_FAILS;
}

export const POST = tracked('/api/capture/enroll', async (request: NextRequest) => {
  const ip = getClientIp(request);
  const now = Date.now();
  if (tooMany(ip, now)) return NextResponse.json({ error: 'Too many tries. Wait a few minutes.', code: 'RATE_LIMITED' }, { status: 429 });
  let body: Record<string, unknown> = {};
  try { const p = await request.json(); if (p && typeof p === 'object' && !Array.isArray(p)) body = p as Record<string, unknown>; } catch { /* handled below */ }
  const result = await exchangeCode(body.code, body.name, body.platform, now);
  if (!result.ok) {
    if (result.reason === 'bad_code') { fails.set(ip, [...(fails.get(ip) ?? []), now]); }
    const msg = result.reason === 'bad_code' ? 'That code is not valid. It may have been used or have expired.' : 'This computer already has the most devices it allows. Remove one first.';
    return NextResponse.json({ error: msg, code: result.reason === 'bad_code' ? 'BAD_CODE' : 'TOO_MANY_DEVICES' }, { status: result.reason === 'bad_code' ? 400 : 409 });
  }
  appendLog({ op: 'enrol', requester: 'device', deviceId: result.device.id, deviceName: result.device.name, state: 'ok' }, now);
  return NextResponse.json({ deviceId: result.device.id, token: result.token, name: result.device.name });
});
