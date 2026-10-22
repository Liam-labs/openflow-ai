/**
 * GET /api/logs/stats
 *
 * Aggregate stats for the Logs Dashboard header.
 *
 * Query parameters:
 *   from   ISO timestamp (default: 24h ago)
 *   to     ISO timestamp (default: now)
 *
 * Response:
 *   {
 *     total, bySource, bySeverity,
 *     hourlyBreakdown, storageBytes, timeRange
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getLogStats } from '@/lib/log-reader';
import { tracked } from '@/lib/api-tracking';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/logs/stats', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const { searchParams } = request.nextUrl;
    const fromStr = searchParams.get('from');
    const toStr = searchParams.get('to');

    const now = new Date();
    let from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let to = now;

    if (fromStr) {
      const d = new Date(fromStr);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ success: false, error: 'Invalid from timestamp' }, { status: 400 });
      }
      from = d;
    }
    if (toStr) {
      const d = new Date(toStr);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ success: false, error: 'Invalid to timestamp' }, { status: 400 });
      }
      to = d;
    }

    // OOM guard: stats loads full files per day — cap to 7 days
    const MAX_STATS_DAYS = 7;
    const maxFrom = new Date(to.getTime() - MAX_STATS_DAYS * 24 * 60 * 60 * 1000);
    if (from < maxFrom) from = maxFrom;

    const stats = await getLogStats(from, to);
    return NextResponse.json(stats);
  } catch (err) {
    console.error('[api/logs/stats] error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});
