/**
 * GET /api/scaffolding/health
 *
 * Fleet-wide scaffolding health summary — powers the X-Ray fleet grid
 * (Surface A in docs/spec-scaffolding-xray.md). One sync.py subprocess +
 * one hook-events.jsonl read covers every agent in the registry, so this
 * endpoint stays snappy regardless of fleet size.
 *
 * Response (matches spec):
 *   {
 *     success: true,
 *     agentsTotal,
 *     agentsHealthy,    // scaffolded && drift==0 && missing==0
 *     agentsDrift,      // scaffolded && drift>0
 *     agentsMissing,    // scaffolded && missing>0
 *     agentsUnscaffolded, // live in roster but no scaffolding manifest entries
 *     agents: [
 *       { id, name, model, roleId, workingDirectory, channelId, status,
 *         summary: { filesTotal, filesSynced, filesDrift, filesMissing,
 *                    hooksActive, hooksStale, lastSyncAt },
 *         scaffolded: bool }
 *     ],
 *     lastFleetSyncAt,  // newest file mtime across the fleet (proxy)
 *     verifiedAt
 *   }
 *
 * Sort: unhealthy first (drift+missing descending), then alphabetical.
 *
 * Auth: requireAuthOrLocal('read') — same Bearer pattern as /manifest.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { composeFleetHealth } from '@/lib/scaffolding-manifest';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/scaffolding/health', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const health = await composeFleetHealth();
    return NextResponse.json({ success: true, ...health });
  } catch (err) {
    console.error('[scaffolding/health] error', err);
    return NextResponse.json(
      { success: false, error: 'Internal error', detail: (err as Error).message },
      { status: 500 },
    );
  }
});
