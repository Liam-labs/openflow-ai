/**
 * GET /api/logs
 *
 * Unified log query endpoint for the DevFlow Logs Dashboard.
 *
 * Query parameters:
 *   sources       Comma-separated: agent,api,cron,service,build,error,tools,crash
 *   severity      Comma-separated: critical,high,medium,low,info
 *   search        Full-text search across title, details, metadata
 *   from          ISO timestamp — start of range (default: 24h ago)
 *   to            ISO timestamp — end of range (default: now)
 *   limit         Max entries to return (default: 100, max: 1000)
 *   offset        Pagination offset (default: 0)
 *   agentName     Filter by agent name (metadata.agentName)
 *   channelId     Filter by channel ID (metadata.channelId)
 *   serviceName   Filter by service name (metadata.serviceName)
 *
 * Response:
 *   { entries, total, sources, timeRange }
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryLogs } from '@/lib/log-reader';
import { logEvent } from '@/lib/log-writer';
import { validateApiToken } from '@/lib/api-auth';
import type { LogSource, LogSeverity } from '@/lib/log-types';
import { tracked, withTiming } from '@/lib/api-tracking';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const VALID_SOURCES: Set<string> = new Set(['agent', 'api', 'cron', 'service', 'build', 'error', 'tools', 'crash', 'supabase-backup']);
const VALID_SEVERITIES: Set<string> = new Set(['critical', 'high', 'medium', 'low', 'info', 'debug']);

export const GET = withTiming('/api/logs', tracked('/api/logs', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const { searchParams } = request.nextUrl;

    const sourcesRaw = searchParams.get('sources');
    const severityRaw = searchParams.get('severity');
    const search = searchParams.get('search') || undefined;
    const fromStr = searchParams.get('from');
    const toStr = searchParams.get('to');
    const limitStr = searchParams.get('limit');
    const offsetStr = searchParams.get('offset');
    const agentName = searchParams.get('agentName') || undefined;
    const channelId = searchParams.get('channelId') || undefined;
    const serviceName = searchParams.get('serviceName') || undefined;

    const sources = sourcesRaw ? (sourcesRaw.split(',').filter(Boolean) as LogSource[]) : undefined;
    const severity = severityRaw ? (severityRaw.split(',').filter(Boolean) as LogSeverity[]) : undefined;

    let from: Date | undefined;
    let to: Date | undefined;

    if (fromStr) {
      from = new Date(fromStr);
      if (isNaN(from.getTime())) {
        return NextResponse.json({ success: false, error: 'Invalid from timestamp' }, { status: 400 });
      }
    }
    if (toStr) {
      to = new Date(toStr);
      if (isNaN(to.getTime())) {
        return NextResponse.json({ success: false, error: 'Invalid to timestamp' }, { status: 400 });
      }
    }

    const limit = limitStr ? Math.max(1, parseInt(limitStr, 10)) : undefined;
    const offset = offsetStr ? Math.max(0, parseInt(offsetStr, 10)) : undefined;

    const result = await queryLogs({
      sources,
      severity,
      search,
      from,
      to,
      limit,
      offset,
      agentName,
      channelId,
      serviceName,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/logs] query error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}));

/**
 * POST /api/logs
 *
 * Write a log entry to the unified event log.
 * Used by shell scripts (earlyoom-notify.sh, tmux-monitor.sh) and external callers.
 *
 * Body: { source, severity, title, metadata?, details? }
 * Auth: Authorization: Bearer $DEVFLOW_API_TOKEN
 */
export const POST = tracked('/api/logs', async (request: NextRequest) => {
  try {
    const authResult = await validateApiToken(request);
    if (!authResult.valid) {
      return NextResponse.json(
        { success: false, error: authResult.error || 'Authentication required' },
        { status: authResult.code === 'RATE_LIMITED' ? 429 : 401 }
      );
    }

    const body = await request.json();
    const { source, severity, title, metadata, details } = body;

    if (!source || !VALID_SOURCES.has(source)) {
      return NextResponse.json(
        { success: false, error: `Invalid source. Must be one of: ${[...VALID_SOURCES].join(', ')}` },
        { status: 400 }
      );
    }
    if (!severity || !VALID_SEVERITIES.has(severity)) {
      return NextResponse.json(
        { success: false, error: `Invalid severity. Must be one of: ${[...VALID_SEVERITIES].join(', ')}` },
        { status: 400 }
      );
    }
    if (!title || typeof title !== 'string') {
      return NextResponse.json({ success: false, error: 'title is required and must be a string' }, { status: 400 });
    }

    await logEvent(
      source as LogSource,
      severity as LogSeverity,
      title,
      metadata && typeof metadata === 'object' ? metadata : {},
      typeof details === 'string' ? details : undefined,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/logs] POST error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});
