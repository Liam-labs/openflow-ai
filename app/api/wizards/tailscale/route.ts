/**
 * /api/wizards/tailscale: the remote-access wizard, Tailscale route (lib/wizards/tailscale.ts).
 *
 * GET   what Tailscale looks like here, what we would do, and any second-device visits seen.
 * POST  { action: 'enable' }  put this app on the user's tailnet with `tailscale serve` (needs the sign-in password first)
 *       { action: 'prove' }   the tailnet address reaches this app (the second device's visit is judged in GET)
 *       { action: 'disable' } remove only the Serve entry this wizard added
 *
 * Only this machine or an admin token: a browser signed in from elsewhere cannot switch remote access on or off.
 */
import { NextRequest, NextResponse } from 'next/server';
import { emitWizardChanged } from '@/lib/wizards/events';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { gatherFacts, judgeSecondDevice, planServe, proveReachable, readRecord, recordMatches, enableTailscale, disableTailscale } from '@/lib/wizards/tailscale';
import { recentOtherDeviceVisits } from '@/lib/wizards/tailscale-visits';
import { hasPassword } from '@/lib/dashboard-auth';

export const dynamic = 'force-dynamic';

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function state() {
  const [facts, record, passwordSet] = await Promise.all([gatherFacts(), readRecord(), hasPassword()]);
  const plan = planServe(facts, Number(process.env.PORT) || 3000);
  const active = recordMatches(record, facts.serve) ? record.tailscale! : null;
  // In a container the wizard cannot switch Serve on, but a second device's visit is still judged.
  const watching = !!active || facts.inContainer;
  const others = watching ? recentOtherDeviceVisits(facts.ips) : [];
  const visits = others.map((v) => ({ secondsAgo: Math.round((Date.now() - v.at) / 1000), device: v.device, user: v.user, allowed: v.allowed }));
  return { facts, passwordSet, plan, active, visits, secondDevice: watching ? judgeSecondDevice(others) : null };
}

export async function GET(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;
  return json({ success: true, ...(await state()) });
}

export async function POST(request: NextRequest) {
  const denied = await requireTokenOrLocal(request, 'admin');
  if (denied) return denied;

  let body: { action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: 'Send JSON.' }, 400);
  }

  if (body.action === 'enable') {
    const result = await enableTailscale();
    emitWizardChanged('tailscale');
    return json({ success: result.ok, ...result, ...(await state()) }, result.ok ? 200 : 409);
  }
  if (body.action === 'disable') {
    const result = await disableTailscale();
    emitWizardChanged('tailscale');
    return json({ success: result.ok, ...result, ...(await state()) }, result.ok ? 200 : 409);
  }
  if (body.action === 'prove') {
    const record = await readRecord();
    if (!record.tailscale) return json({ success: false, error: 'Switch remote access on first.' }, 409);
    const facts = await gatherFacts();
    if (!recordMatches(record, facts.serve)) return json({ success: false, error: 'Switch remote access on first.' }, 409);
    return json({ success: true, ...(await proveReachable(record.tailscale.url)), ...(await state()) });
  }
  return json({ success: false, error: 'Unknown action.' }, 400);
}
