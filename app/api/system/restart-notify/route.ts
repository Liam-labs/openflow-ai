/**
 * POST /api/system/restart-notify
 *
 * Called by safe-build.sh before PM2 restart to notify all SSE clients.
 * Broadcasts a 'system:restarting' event so clients can handle graceful disconnect.
 * Local-only (no external auth needed — same-machine curl from build script).
 */

import { NextRequest, NextResponse } from 'next/server';
import { eventBus } from '@/lib/event-bus';
import { isLocalRequest } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { PRODUCT_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/system/restart-notify', async (request: NextRequest) => {
  // Only allow from localhost
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: 'Local access only' }, { status: 403 });
  }

  const clientCount = eventBus.getClientCount();

  // Broadcast restart event to all connected SSE clients
  eventBus.emitEvent('system:restarting', {
    reason: 'build',
    message: `${PRODUCT_NAME} is restarting after a build. Reconnect in ~5 seconds.`,
    timestamp: new Date().toISOString(),
  });

  return NextResponse.json({
    success: true,
    notified: clientCount,
    message: `Restart notification sent to ${clientCount} SSE client(s)`,
  });
});
