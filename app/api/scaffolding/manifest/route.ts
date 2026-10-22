/**
 * GET /api/scaffolding/manifest?agentId=<id|prefix|name>
 *
 * Returns the X-Ray manifest for one agent — exactly the JSON shape
 * described in docs/spec-scaffolding-xray.md:
 *
 *   {
 *     agent:    { id, name, model, roleId, workingDirectory, ... },
 *     files:    [ { entryId, source, masterPath, target, path,
 *                   status, drift, localSha256, masterSha256, mtime, reason? } ],
 *     hooks:    [ { name, event, configured, lastFiredAt, firedLast24h,
 *                   neverFired?, staleHook?, command? } ],
 *     syncLog:  [],            // empty in v1 — capture is future work
 *     summary:  { filesTotal, filesSynced, filesDrift, filesMissing,
 *                 hooksActive, hooksStale, lastSyncAt },
 *     verifiedAt
 *   }
 *
 * Accepts agentId by full UUID, short UUID prefix, or exact name.
 * 400 if the param is missing, 404 if no agent matches, 409 if the prefix
 * resolves ambiguously (caller should pass more of the id).
 *
 * Auth: requireAuthOrLocal — Bearer DEVFLOW_API_TOKEN or localhost origin.
 *
 * Cost: one subprocess invocation of `python3 sync.py --verify-only --json
 * --agent <name>` per request, plus a small handful of JSON file reads.
 * Verify subprocess is bounded to 30s by lib/scaffolding-manifest.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import {
  composeAgentManifest,
  loadAllRoster,
  resolveAgent,
} from '@/lib/scaffolding-manifest';

export const dynamic = 'force-dynamic';

function bad(error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: false, error, ...(extra ?? {}) }, { status: 400 });
}
function notFound(error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: false, error, ...(extra ?? {}) }, { status: 404 });
}
function conflict(error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: false, error, ...(extra ?? {}) }, { status: 409 });
}
function serverError(error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: false, error, ...(extra ?? {}) }, { status: 500 });
}

export const GET = tracked('/api/scaffolding/manifest', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  const { searchParams } = request.nextUrl;
  const agentId = (searchParams.get('agentId') ?? searchParams.get('agent') ?? '').trim();
  if (!agentId) {
    return bad('agentId required (full UUID, short prefix, or exact name)');
  }

  try {
    const agent = await resolveAgent(agentId);

    if (!agent) {
      // Distinguish "ambiguous prefix" from "not found" by re-querying the roster
      const roster = await loadAllRoster();
      const prefixMatches = roster.filter((a) => a.id.startsWith(agentId));
      const nameMatches = roster.filter(
        (a) => a.name.toLowerCase() === agentId.toLowerCase(),
      );
      if (prefixMatches.length > 1 || nameMatches.length > 1) {
        return conflict('Ambiguous agentId — multiple matches', {
          matches: [...prefixMatches, ...nameMatches]
            .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i)
            .map((a) => ({ id: a.id, name: a.name, workingDirectory: a.workingDirectory })),
        });
      }
      return notFound(`No agent matches '${agentId}'`, {
        hint: 'Use GET /api/scaffolding/manifest with a full UUID, short prefix, or exact name. List rosters via /api/agent {action:"roster.list", channelId}.',
      });
    }

    if (!agent.workingDirectory) {
      return serverError(`Agent '${agent.name}' has no workingDirectory in the roster`);
    }

    const manifest = await composeAgentManifest(agent);
    return NextResponse.json({ success: true, ...manifest });
  } catch (err) {
    console.error('[scaffolding/manifest] error', err);
    return serverError('Internal error', { detail: (err as Error).message });
  }
});
