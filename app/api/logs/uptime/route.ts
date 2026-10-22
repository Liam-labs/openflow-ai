/**
 * GET /api/logs/uptime
 *
 * Per-agent uptime percentage derived from agent lifecycle events in the event log.
 * No new data collection required — computes from existing spawn/crash/exit events.
 *
 * Query parameters:
 *   window   Time window: '1h' | '24h' | '7d' | '30d'  (default: '24h')
 *   from     ISO timestamp — start of range (overrides window)
 *   to       ISO timestamp — end of range (default: now)
 *
 * Response:
 *   {
 *     window: { from: string; to: string };
 *     agents: Array<{
 *       name: string;
 *       uptimePercent: number;       // 0–100
 *       downtimeMs: number;
 *       windowMs: number;
 *       crashCount: number;
 *       lastSeen: string | null;
 *       status: 'up' | 'down' | 'unknown';
 *     }>;
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryLogs } from '@/lib/log-reader';
import { tracked } from '@/lib/api-tracking';
import { computeAgentUptime } from '@/lib/uptime-helpers';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const WINDOW_PRESETS: Record<string, number> = {
  '1h':  1 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface AgentEvent {
  event: string;
  timestamp: number;
}

interface AgentUptimeResult {
  name: string;
  uptimePercent: number;
  downtimeMs: number;
  windowMs: number;
  crashCount: number;
  lastSeen: string | null;
  status: 'up' | 'down' | 'unknown';
}

export const GET = tracked('/api/logs/uptime', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const { searchParams } = request.nextUrl;

    const windowParam = searchParams.get('window') || '24h';
    const fromStr = searchParams.get('from');
    const toStr = searchParams.get('to');

    const now = new Date();
    const windowMs = WINDOW_PRESETS[windowParam] ?? WINDOW_PRESETS['24h'];

    let to = now;
    let from = new Date(now.getTime() - windowMs);

    if (fromStr) {
      const d = new Date(fromStr);
      if (isNaN(d.getTime())) return NextResponse.json({ success: false, error: 'Invalid from timestamp' }, { status: 400 });
      from = d;
    }
    if (toStr) {
      const d = new Date(toStr);
      if (isNaN(d.getTime())) return NextResponse.json({ success: false, error: 'Invalid to timestamp' }, { status: 400 });
      to = d;
    }

    const actualWindowMs = to.getTime() - from.getTime();

    // Query all agent lifecycle events in the window (generous limit — unlikely to exceed)
    const result = await queryLogs({
      sources: ['agent'],
      from,
      to,
      limit: 5000,
    });

    // Group events by agent name
    const byAgent = new Map<string, AgentEvent[]>();

    for (const entry of result.entries) {
      const meta = entry.metadata as Record<string, unknown>;
      const agentName = typeof meta.agentName === 'string' ? meta.agentName : null;
      const event = typeof meta.event === 'string' ? meta.event : null;
      if (!agentName || !event) continue;

      if (!byAgent.has(agentName)) byAgent.set(agentName, []);
      byAgent.get(agentName)!.push({
        event,
        timestamp: new Date(entry.timestamp).getTime(),
      });
    }

    // Sort each agent's events chronologically
    for (const events of byAgent.values()) {
      events.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Compute uptime per agent
    const agents: AgentUptimeResult[] = [];

    for (const [name, events] of byAgent.entries()) {
      const { downtimeMs, crashCount, lastSeen, status } = computeAgentUptime(
        events,
        from.getTime(),
        to.getTime()
      );
      const uptimeMs = Math.max(0, actualWindowMs - downtimeMs);
      const uptimePercent = actualWindowMs > 0
        ? Math.round((uptimeMs / actualWindowMs) * 1000) / 10  // 1 decimal place
        : 100;

      agents.push({
        name,
        uptimePercent: Math.min(100, Math.max(0, uptimePercent)),
        downtimeMs,
        windowMs: actualWindowMs,
        crashCount,
        lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
        status,
      });
    }

    // Sort by uptime ascending (worst first)
    agents.sort((a, b) => a.uptimePercent - b.uptimePercent);

    return NextResponse.json({
      window: { from: from.toISOString(), to: to.toISOString() },
      agents,
    });
  } catch (err) {
    console.error('[api/logs/uptime] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});
