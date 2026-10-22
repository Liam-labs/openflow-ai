/**
 * GET /api/system/machine-memory: the memory of both machines, side by side.
 * { generatedAt, machines: [{ id: 'server' | 'desktop', label, reachable, reason?, memory? }] } where `memory` has the same fields as
 * /api/system/wsl-memory. The server is read here; the desktop's WSL is read by its helper (agent-hostd, op "memory-facts"), because the server
 * cannot see the PC's /proc or .wslconfig. Cached for 4 s. Code: lib/system-memory.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { getMachineMemory } from '@/lib/system-memory';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  try {
    return NextResponse.json(await getMachineMemory(), { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({ error: 'Could not read the machines\' memory', code: 'INTERNAL' }, { status: 500 });
  }
}
