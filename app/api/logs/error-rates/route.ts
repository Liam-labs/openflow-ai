/**
 * GET /api/logs/error-rates
 *
 * Returns API error rate aggregation across rolling windows (1m, 5m, 1h).
 * Includes top error routes and recent error details.
 *
 * Response:
 *   {
 *     windows: { '1m': { total, success, clientError, serverError, errorRate }, ... },
 *     topErrorRoutes: [{ route, total, clientError, serverError, errorRate }],
 *     recentErrors: [{ timestamp, route, status }]
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getErrorRates } from '@/lib/error-rate-tracker';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/logs/error-rates', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const data = getErrorRates();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[api/logs/error-rates] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});
