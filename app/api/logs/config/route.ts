/**
 * GET /api/logs/config — Read current logging configuration
 * PUT /api/logs/config — Update logging configuration (partial merge)
 *
 * Auth required for PUT (Bearer token). GET is unauthenticated (config is non-sensitive).
 *
 * PUT body (all fields optional):
 *   { retentionDays, memoryTimelineHours, oomEventMax, errorBufferSize, logLevel, verboseModules }
 *
 * Response: full LoggingConfig object
 */

import { NextRequest, NextResponse } from 'next/server';
import { getLoggingConfig, updateLoggingConfig, LOG_LEVEL_RANK } from '@/lib/log-config';
import type { LogLevel } from '@/lib/log-config';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/logs/config', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const config = await getLoggingConfig();
    return NextResponse.json(config);
  } catch (err) {
    console.error('[api/logs/config] GET error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
});

export const PUT = tracked('/api/logs/config', async (request: NextRequest) => {
  try {
    const authError = await requireAuthOrLocal(request, 'write');
    if (authError) return authError;

    const body = await request.json();

    // Validate logLevel if provided
    if (body.logLevel !== undefined) {
      if (typeof body.logLevel !== 'string' || !LOG_LEVEL_RANK.hasOwnProperty(body.logLevel)) {
        return NextResponse.json(
          { success: false, error: `Invalid logLevel. Must be one of: ${Object.keys(LOG_LEVEL_RANK).join(', ')}` },
          { status: 400 },
        );
      }
    }

    // Validate numeric fields
    for (const field of ['retentionDays', 'memoryTimelineHours', 'oomEventMax', 'errorBufferSize'] as const) {
      if (body[field] !== undefined && (typeof body[field] !== 'number' || isNaN(body[field]))) {
        return NextResponse.json({ success: false, error: `${field} must be a number` }, { status: 400 });
      }
    }

    // Validate verboseModules if provided
    if (body.verboseModules !== undefined) {
      if (typeof body.verboseModules !== 'object' || Array.isArray(body.verboseModules)) {
        return NextResponse.json(
          { success: false, error: 'verboseModules must be an object mapping module names to booleans' },
          { status: 400 },
        );
      }
    }

    const updated = await updateLoggingConfig(body);
    return NextResponse.json(updated);
  } catch (err) {
    console.error('[api/logs/config] PUT error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
});
