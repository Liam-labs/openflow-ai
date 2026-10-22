/**
 * GET /api/system/agent-sessions
 *
 * Returns all active agent sessions across all collab channels.
 * No auth — read-only metadata, safe to expose locally.
 *
 * Response:
 *   total_active: number
 *   sessions: Array<{
 *     name, model, channelName, channelId, status, pid,
 *     ptySessionId, lastStartedAt, uptimeSeconds
 *   }>
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { isFreshContextHealth } from '@/lib/context-health/merge';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

interface RosterAgent {
  id: string;
  name: string;
  channelId: string;
  participantId: string;
  status: string;
  model?: string;
  pid?: number;
  ptySessionId?: string;
  lastStartedAt?: string;
  lastContextHealth?: { model?: string; percent?: number; turnCount?: number; reportedAt?: string };
}

interface ChannelData {
  id: string;
  name: string;
  roster?: { agents?: RosterAgent[]; lastUpdated?: string };
}

interface CollabChannelsData {
  channels: ChannelData[];
}

interface AgentSession {
  name: string;
  model: string;
  channelName: string;
  channelId: string;
  status: string;
  pid: number | null;
  ptySessionId: string | null;
  lastStartedAt: string | null;
  uptimeSeconds: number | null;
}

function resolveModel(agent: RosterAgent): string {
  // Prefer context health model (the actual running model), but only while the reading is current: an old reading names
  // whatever model the agent ran months ago.
  if (agent.lastContextHealth?.model && isFreshContextHealth(agent.lastContextHealth)) return agent.lastContextHealth.model;
  // Fall back to configured model
  if (agent.model) return agent.model;
  return 'unknown';
}

function computeUptime(lastStartedAt: string | undefined): number | null {
  if (!lastStartedAt) return null;
  try {
    return Math.max(0, Math.floor((Date.now() - new Date(lastStartedAt).getTime()) / 1000));
  } catch {
    return null;
  }
}

export const GET = tracked('/api/system/agent-sessions', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const errors: string[] = [];
  let sessions: AgentSession[] = [];

  try {
    const channelsPath = appPath('.AppData', 'collab-channels.json');
    const raw = await fs.readFile(channelsPath, 'utf-8');
    const data: CollabChannelsData = JSON.parse(raw);

    for (const ch of data.channels) {
      const agents = ch.roster?.agents ?? [];
      for (const agent of agents) {
        if (agent.status !== 'running') continue;

        sessions.push({
          name: agent.name,
          model: resolveModel(agent),
          channelName: ch.name,
          channelId: ch.id,
          status: agent.status,
          pid: agent.pid ?? null,
          ptySessionId: agent.ptySessionId ?? null,
          lastStartedAt: agent.lastStartedAt ?? null,
          uptimeSeconds: computeUptime(agent.lastStartedAt),
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`collab-channels.json read failed: ${msg}`);
  }

  // Sort by channel name then agent name
  sessions.sort((a, b) => {
    const ch = a.channelName.localeCompare(b.channelName);
    if (ch !== 0) return ch;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json(
    {
      total_active: sessions.length,
      sessions,
      errors: errors.length > 0 ? errors : undefined,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
});
