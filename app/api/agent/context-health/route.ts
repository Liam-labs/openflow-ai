/**
 * Context Health API
 *
 * POST /api/agent/context-health — agent self-reports context fill each turn
 * GET  /api/agent/context-health?channelId=X — read last-known health per agent in channel
 *
 * Storage:
 *   - In-memory ring buffer (last 50 reports per participantId) for history
 *   - Persists last-known to channels.json roster entry `lastContextHealth`
 *
 * Writer: scripts/context_sampler.py (a desktop service) reads each agent's own transcript and posts here. It sends
 * contextTokens and contextWindow as well as the percentage, so the bar can say what it measured. The old per-message
 * hook that fed this was retired on purpose on 31 Aug 2026 and nothing replaced it until the sampler.
 * Frontend reads from roster data (lastContextHealth is embedded in channel JSON) and polls GET below; it hides a reading
 * older than CONTEXT_HEALTH_MAX_AGE_MS (lib/context-health/merge.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { DataPaths } from '@/lib/data-paths';
import type { CollabChannelsData } from '@/lib/types';
import { isFreshContextHealth } from '@/lib/context-health/merge';

export const dynamic = 'force-dynamic';

interface ContextHealthReport {
  participantId: string;
  percent: number;
  turnCount: number;
  model: string;
  reportedAt: string;
  tokens?: number;
  window?: number;
  source?: string;
}

// In-memory ring buffer — survives across requests, resets on process restart
// (last-known value is persisted to channels.json for durability)
const healthBuffer = new Map<string, ContextHealthReport[]>();
const BUFFER_SIZE = 50;

// ──────────────────────────────────────────────────────────────
// POST — agent self-reports context health
// ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: {
    participantId?: string; contextPercent?: number; turnCount?: number; model?: string; channelId?: string;
    contextTokens?: number; contextWindow?: number; source?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { participantId, contextPercent, turnCount, model, channelId, contextTokens, contextWindow, source } = body;

  if (!participantId || contextPercent === undefined || contextPercent === null) {
    return NextResponse.json(
      { success: false, error: 'participantId and contextPercent are required' },
      { status: 400 }
    );
  }

  if (typeof contextPercent !== 'number' || contextPercent < 0 || contextPercent > 100) {
    return NextResponse.json(
      { success: false, error: 'contextPercent must be a number between 0 and 100' },
      { status: 400 }
    );
  }

  // Optional detail from reporters that know what they measured.
  const bad = (field: string) => NextResponse.json({ success: false, error: `${field} is not valid` }, { status: 400 });
  if (contextTokens !== undefined && !(typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens >= 0)) return bad('contextTokens');
  if (contextWindow !== undefined && !(typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0)) return bad('contextWindow');
  if (source !== undefined && !(typeof source === 'string' && source.length > 0 && source.length <= 40)) return bad('source');

  const report: ContextHealthReport = {
    participantId,
    percent: Math.round(contextPercent),
    turnCount: turnCount ?? 0,
    model: model ?? 'unknown',
    reportedAt: new Date().toISOString(),
    ...(contextTokens !== undefined ? { tokens: Math.round(contextTokens) } : {}),
    ...(contextWindow !== undefined ? { window: Math.round(contextWindow) } : {}),
    ...(source !== undefined ? { source } : {}),
  };

  // Update in-memory ring buffer
  const history = healthBuffer.get(participantId) ?? [];
  history.push(report);
  if (history.length > BUFFER_SIZE) history.shift();
  healthBuffer.set(participantId, history);

  // Persist last-known to channels.json roster entry
  if (channelId) {
    try {
      await mutateChannels('context-health:record', async data => {
        const channel = data.channels.find(c => c.id === channelId);
        if (channel?.roster) {
          const agent = channel.roster.agents.find(a => a.participantId === participantId);
          if (agent) {
            // Replaced whole, so detail from an earlier reporter never lingers beside a newer reading.
            agent.lastContextHealth = {
              percent: report.percent,
              turnCount: report.turnCount,
              model: report.model,
              reportedAt: report.reportedAt,
              ...(report.tokens !== undefined ? { tokens: report.tokens } : {}),
              ...(report.window !== undefined ? { window: report.window } : {}),
              ...(report.source !== undefined ? { source: report.source } : {}),
            };
            await saveChannels(data);
          }
        }
      });
    } catch {
      // Non-fatal — in-memory update succeeded, persistence is best-effort
    }
  }

  return NextResponse.json({ success: true });
}

// ──────────────────────────────────────────────────────────────
// GET — read last-known health for all agents in a channel
// ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const channelId = request.nextUrl.searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json({ success: false, error: 'channelId is required' }, { status: 400 });
  }

  try {
    const defaultData: CollabChannelsData = { channels: [], lastUpdated: new Date().toISOString() };
    const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, defaultData);
    const channel = data.channels.find(c => c.id === channelId);

    if (!channel?.roster) {
      return NextResponse.json({ success: true, agents: [] });
    }

    const agents = channel.roster.agents.map(agent => ({
      agentId: agent.id,
      name: agent.name,
      participantId: agent.participantId,
      lastContextHealth: agent.lastContextHealth ?? null,
      // True when there is no reading or it is too old to show (the UI hides such a reading).
      stale: !isFreshContextHealth(agent.lastContextHealth),
      // Include recent history from in-memory buffer if available
      recentHistory: healthBuffer.get(agent.participantId)?.slice(-10) ?? [],
    }));

    return NextResponse.json({ success: true, agents });
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to read channel data' }, { status: 500 });
  }
}
