/**
 * GET /api/system/laptop-agents: is the laptop (the DevFlow server) ready to run agents, and what can they reach from there?
 * { ready, mode: 'files-only' | 'files-and-commands', checks: [{ id, label, ok, detail }] }. The roster UI enables "Run remote" only when ready.
 * Capability flags (fileShare, desktopCommands) live in data/scaffolding/service-locations.json under "remote"; they are flipped only when the
 * ability truly works. Design: platform/remote-agents-design.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { laptopReadiness } from '@/lib/laptop-readiness';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  try {
    return NextResponse.json(await laptopReadiness());
  } catch {
    return NextResponse.json({ error: 'Could not check the Remote server', code: 'INTERNAL' }, { status: 500 });
  }
}
