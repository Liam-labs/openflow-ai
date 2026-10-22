/**
 * GET /api/system/firewall: what is locked down on each machine, how, and what is let through (service name, ports, who can reach each).
 * { generatedAt, machines: [{ id, label, reachable, reason?, firewall, ports[], rules[], controls[] }] }. Cached for 30 s; ?refresh=1 re-reads
 * (at most every 5 s). The port names come from data/firewall/registry.json; the verdict for each port is worked out from the live rule set.
 * Design and how to read it: platform/security-lockdown.md and platform/granting-access.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { getFirewallReport } from '@/lib/firewall/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  try {
    const refresh = request.nextUrl.searchParams.get('refresh') === '1';
    return NextResponse.json(await getFirewallReport({ refresh }));
  } catch {
    return NextResponse.json({ error: 'Could not build the firewall report', code: 'INTERNAL' }, { status: 500 });
  }
}
