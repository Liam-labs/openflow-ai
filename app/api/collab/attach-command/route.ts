/**
 * GET /api/collab/attach-command?session=<tmux session name>
 *
 * The command to look at an agent's own terminal, right for where this app runs (inside a container or not). The page cannot tell, so it asks.
 * Answers { command } for a plain session name, and 400 for anything else.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { attachCommand } from '@/lib/attach-command';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/collab/attach-command', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  const command = attachCommand(request.nextUrl.searchParams.get('session'));
  if (!command) return NextResponse.json({ success: false, error: 'That is not a plain terminal session name.' }, { status: 400 });
  return NextResponse.json({ success: true, command }, { headers: { 'Cache-Control': 'no-store' } });
});
