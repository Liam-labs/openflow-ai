/**
 * Model Configuration API — UI-Facing (no auth required)
 *
 * Provides direct read/write access to configuredModels.json for the
 * Model Configuration Panel UI. Auth is not required because this
 * is a local-only DevFlow dashboard endpoint.
 *
 * GET  /api/models/configured            → { providers, overrides }
 * POST /api/models/configured            → action-based mutations
 *   { action: 'configure', provider, authType, configured? }
 *   { action: 'setOverride', agentName, model, provider? }
 *   { action: 'removeOverride', agentName }
 */

import { NextRequest, NextResponse } from 'next/server';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import {
  inferAgentTypeForModel,
  isAgentTypeCompatibleWith,
} from '@/lib/model-registry';
import type { CollabChannelsData, AgentRosterEntry } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

interface ModelOverride {
  model: string;
  provider?: string;
  setAt: string;
  setBy?: string;
  // Sprint c62ebbd2 B2: if the override model is incompatible with the
  // agent's previously-configured agentType, the inferred compatible
  // agentType is stored here so spawn paths can route to the right wrapper
  // without re-deriving on every spawn.
  agentType?: string;
}

interface ProviderConfig {
  authType: 'api-key' | 'subscription';
  configured: boolean;
  configuredAt?: string;
}

interface ConfiguredModelsData {
  version: string;
  updatedAt: string;
  overrides: Record<string, ModelOverride>;
  providers: Record<string, ProviderConfig>;
}

const DEFAULT_DATA: ConfiguredModelsData = {
  version: '1.0.0',
  updatedAt: new Date().toISOString(),
  overrides: {},
  providers: {},
};

// ── GET ──────────────────────────────────────────────────────────────────────

export const GET = tracked('/api/models/configured', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const data = await readJsonFile<ConfiguredModelsData>(DataPaths.configuredModels, DEFAULT_DATA);
  return NextResponse.json({
    providers: data.providers ?? {},
    overrides: data.overrides ?? {},
  });
});

// ── POST ─────────────────────────────────────────────────────────────────────

export const POST = tracked('/api/models/configured', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action } = body;

  try {
    switch (action) {
      case 'configure': {
        const provider = body.provider as string;
        const authType = body.authType as 'api-key' | 'subscription';
        const isConfigured = (body.configured as boolean) !== false;

        if (!provider || !authType) {
          return NextResponse.json({ success: false, error: 'provider and authType are required' }, { status: 400 });
        }
        if (authType !== 'api-key' && authType !== 'subscription') {
          return NextResponse.json({ success: false, error: "authType must be 'api-key' or 'subscription'" }, { status: 400 });
        }

        await withFileLock(DataPaths.configuredModels, async () => {
          const data = await readJsonFile<ConfiguredModelsData>(DataPaths.configuredModels, DEFAULT_DATA);
          if (!data.providers) data.providers = {};
          data.providers[provider] = {
            authType,
            configured: isConfigured,
            configuredAt: new Date().toISOString(),
          };
          data.updatedAt = new Date().toISOString();
          await writeJsonFile(DataPaths.configuredModels, data);
        });

        return NextResponse.json({ success: true, provider, authType, configured: isConfigured });
      }

      case 'setOverride': {
        const agentName = body.agentName as string;
        const model = body.model as string;
        if (!agentName || !model) {
          return NextResponse.json({ success: false, error: 'agentName and model are required' }, { status: 400 });
        }

        let previous: ModelOverride | null = null;
        let autoRoutedAgentType: string | null = null;

        // Sprint c62ebbd2 B2 — find the current agentType for this agent across
        // all channel rosters BEFORE taking the write lock, so the compatibility
        // check is read-only against channels.json (no second lock acquired).
        // Multiple roster entries can share a name across channels; we trust
        // them all to share the same agentType (matches the spawn-path
        // assumption — they would share a wrapper if spawned together).
        let currentAgentType: string | undefined;
        try {
          const channelsData = await readJsonFile<CollabChannelsData>(
            DataPaths.collabChannels,
            { channels: [], lastUpdated: new Date().toISOString() } as CollabChannelsData,
          );
          for (const ch of channelsData.channels || []) {
            const rosterAgents: AgentRosterEntry[] | undefined = ch.roster?.agents;
            const match = rosterAgents?.find(a => a.name === agentName);
            if (match?.agentType) {
              currentAgentType = match.agentType;
              break;
            }
          }
        } catch {
          // Non-fatal: if we can't read channels, fall back to "no current type"
          // — the override still writes, and inferAgentTypeForModel still runs.
        }

        await withFileLock(DataPaths.configuredModels, async () => {
          const data = await readJsonFile<ConfiguredModelsData>(DataPaths.configuredModels, DEFAULT_DATA);
          if (!data.overrides) data.overrides = {};
          previous = data.overrides[agentName] ?? null;

          // Decide whether the override needs an explicit agentType stamp.
          // If the agent's current agentType is compatible with the model, no
          // override on agentType is needed (spawn path uses the existing one).
          // If it's incompatible OR unknown, stamp the inferred compatible
          // agentType into the override so the spawn path routes to the right
          // wrapper without callers having to also pass agentType.
          let agentTypeStamp: string | undefined;
          if (currentAgentType && isAgentTypeCompatibleWith(model, currentAgentType)) {
            agentTypeStamp = undefined;
          } else {
            const inferred = inferAgentTypeForModel(model);
            if (inferred) {
              agentTypeStamp = inferred;
              autoRoutedAgentType = inferred;
              if (currentAgentType) {
                console.warn(
                  `[setOverride] model='${model}' not compatible with agent='${agentName}' agentType='${currentAgentType}'; stamping agentType='${inferred}' on override`,
                );
              }
            }
          }

          data.overrides[agentName] = {
            model,
            provider: (body.provider as string) || undefined,
            setAt: new Date().toISOString(),
            setBy: 'user',
            agentType: agentTypeStamp,
          };
          data.updatedAt = new Date().toISOString();
          await writeJsonFile(DataPaths.configuredModels, data);
        });

        return NextResponse.json({
          success: true,
          agentName,
          model,
          previous,
          autoRoutedAgentType,
        });
      }

      case 'removeOverride': {
        const agentName = body.agentName as string;
        if (!agentName) {
          return NextResponse.json({ success: false, error: 'agentName is required' }, { status: 400 });
        }

        let removed = false;

        await withFileLock(DataPaths.configuredModels, async () => {
          const data = await readJsonFile<ConfiguredModelsData>(DataPaths.configuredModels, DEFAULT_DATA);
          if (!data.overrides) data.overrides = {};
          removed = agentName in data.overrides;
          if (removed) {
            delete data.overrides[agentName];
            data.updatedAt = new Date().toISOString();
            await writeJsonFile(DataPaths.configuredModels, data);
          }
        });

        return NextResponse.json({ success: true, agentName, removed });
      }

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
});
