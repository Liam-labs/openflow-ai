/**
 * GET /api/channel-tools?channelId=<id> - the tools in a channel's `channel-tools/` folder, for the AgentChat
 * "Channel tools" launcher. Read-only. A missing folder is a normal empty state, not an error; a broken
 * tool.json becomes a warning on that tool and never hides the others.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { listChannelTools } from '@/lib/channel-tools';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/channel-tools', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const channelId = request.nextUrl.searchParams.get('channelId');
  if (!channelId) return NextResponse.json({ success: false, error: 'channelId is required' }, { status: 400 });
  const result = await listChannelTools(channelId);
  if (!result) return NextResponse.json({ success: false, error: 'Channel not found' }, { status: 404 });
  return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
});
