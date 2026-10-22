/**
 * GET /api/logs/memory-timeline
 *
 * Returns memory usage time-series data from logs/memory-timeseries.jsonl
 * written by scripts/memory-sampler.sh (every 30s, 24h rolling retention).
 *
 * Query parameters:
 *   from   ISO timestamp — start of range (default: 24h ago)
 *   to     ISO timestamp — end of range (default: now)
 *
 * Response:
 *   { points: Array<{ ts, memUsedPercent, memAvailMB, swapUsedMB }> }
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

interface MemorySample {
  ts:            string;
  memTotalMB:    number;
  memAvailMB:    number;
  memUsedMB:     number;
  swapUsedMB:    number;
  cpuLoad1m?:    number;
  cpuLoad5m?:    number;
}

export interface MemoryPoint {
  ts:             string;
  memUsedPercent: number;
  memAvailMB:     number;
  swapUsedMB:     number;
}

const TIMESERIES_FILE = appPath('logs', 'memory-timeseries.jsonl');

export const GET = tracked('/api/logs/memory-timeline', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const { searchParams } = request.nextUrl;
    const fromStr = searchParams.get('from');
    const toStr   = searchParams.get('to');

    const now  = Date.now();
    const from = fromStr ? new Date(fromStr).getTime() : now - 24 * 60 * 60 * 1000;
    const to   = toStr   ? new Date(toStr).getTime()   : now;

    if (isNaN(from) || isNaN(to)) {
      return NextResponse.json({ success: false, error: 'Invalid timestamp' }, { status: 400 });
    }

    let content: string;
    try {
      content = await fs.readFile(TIMESERIES_FILE, 'utf-8');
    } catch {
      // File doesn't exist yet — sampler not running or no data yet
      return NextResponse.json({ points: [] });
    }

    const points: MemoryPoint[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const sample = JSON.parse(trimmed) as MemorySample;
        const sampleTime = new Date(sample.ts).getTime();
        if (sampleTime < from || sampleTime > to) continue;
        if (!sample.memTotalMB || sample.memTotalMB === 0) continue;

        points.push({
          ts:             sample.ts,
          memUsedPercent: Math.round((sample.memUsedMB / sample.memTotalMB) * 1000) / 10,
          memAvailMB:     sample.memAvailMB,
          swapUsedMB:     sample.swapUsedMB,
        });
      } catch {
        // skip malformed line
      }
    }

    return NextResponse.json({ points });
  } catch (err) {
    console.error('[api/logs/memory-timeline] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});
