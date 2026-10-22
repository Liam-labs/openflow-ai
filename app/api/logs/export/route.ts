/**
 * GET /api/logs/export
 *
 * Export filtered logs as downloadable JSONL or CSV.
 * Supports same filters as /api/logs plus a format parameter.
 *
 * Query parameters:
 *   format        'jsonl' (default) or 'csv'
 *   sources       Comma-separated: agent,api,cron,service,build,error,tools,crash
 *   severity      Comma-separated: critical,high,medium,low,info
 *   search        Full-text search across title, details, metadata
 *   from          ISO timestamp — start of range (default: 24h ago)
 *   to            ISO timestamp — end of range (default: now)
 *   limit         Max entries (default: 10000, max: 50000)
 *   agentName     Filter by agent name
 *   channelId     Filter by channel ID
 *   serviceName   Filter by service name
 *
 * Response: file download with Content-Disposition header
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryLogs } from '@/lib/log-reader';
import type { LogSource, LogSeverity, UnifiedLogEntry } from '@/lib/log-types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function entryToCSVRow(entry: UnifiedLogEntry): string {
  return [
    escapeCSV(entry.id),
    escapeCSV(entry.timestamp),
    escapeCSV(entry.source),
    escapeCSV(entry.severity),
    escapeCSV(entry.title),
    escapeCSV(entry.details ?? ''),
    escapeCSV(JSON.stringify(entry.metadata)),
  ].join(',');
}

const CSV_HEADER = 'id,timestamp,source,severity,title,details,metadata';

export const GET = tracked('/api/logs/export', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = request.nextUrl;

    const format = searchParams.get('format') ?? 'jsonl';
    if (format !== 'jsonl' && format !== 'csv') {
      return NextResponse.json({ success: false, error: 'format must be "jsonl" or "csv"' }, { status: 400 });
    }

    const sourcesRaw = searchParams.get('sources');
    const severityRaw = searchParams.get('severity');
    const search = searchParams.get('search') || undefined;
    const fromStr = searchParams.get('from');
    const toStr = searchParams.get('to');
    const limitStr = searchParams.get('limit');
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

    const limit = limitStr ? Math.max(1, Math.min(50000, parseInt(limitStr, 10))) : 10000;

    const result = await queryLogs({
      sources,
      severity,
      search,
      from,
      to,
      limit,
      offset: 0,
      agentName,
      channelId,
      serviceName,
    });

    const now = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const ext = format === 'csv' ? 'csv' : 'jsonl';
    const filename = `devflow-logs-${now}.${ext}`;
    const contentType = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8';

    let body: string;
    if (format === 'csv') {
      const rows = result.entries.map(entryToCSVRow);
      body = CSV_HEADER + '\n' + rows.join('\n') + '\n';
    } else {
      body = result.entries.map(e => JSON.stringify(e)).join('\n') + (result.entries.length ? '\n' : '');
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Total-Entries': String(result.total),
        'X-Exported-Entries': String(result.entries.length),
      },
    });
  } catch (err) {
    console.error('[api/logs/export] error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
});
