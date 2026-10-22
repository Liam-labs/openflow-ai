/**
 * Model Registry Actions (Agent API)
 *
 * Provides programmatic access to the AI model registry (data/models.json).
 * models.list  — return all models, optionally filtered by provider or agentType
 * models.sync  — update the registry (add/update/remove models)
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';

interface ModelEntry {
  id: string;
  provider: 'anthropic' | 'google' | 'xai' | string;
  classification: string; // required — e.g. 'opus', 'sonnet', 'haiku', 'pro', 'flash', 'lite', 'reasoning', 'fast'
  label: string;
  description?: string;
  tier: 'fast' | 'balanced' | 'powerful' | string;
  agentTypes: string[];
  isDefault?: boolean;
}

interface ModelsData {
  version: string;
  updatedAt: string;
  roleDefaults?: Record<string, Record<string, string>>;
  models: ModelEntry[];
}

interface ModelOverride {
  model: string;
  provider?: string;
  setAt: string;
  setBy?: string;
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

const DEFAULT_MODELS_DATA: ModelsData = {
  version: '1.0.0',
  updatedAt: new Date().toISOString(),
  models: [],
};

const DEFAULT_CONFIGURED_MODELS: ConfiguredModelsData = {
  version: '1.0.0',
  updatedAt: new Date().toISOString(),
  overrides: {},
  providers: {},
};

async function loadModels(): Promise<ModelsData> {
  return readJsonFile<ModelsData>(DataPaths.models, DEFAULT_MODELS_DATA);
}

async function loadConfiguredModels(): Promise<ConfiguredModelsData> {
  return readJsonFile<ConfiguredModelsData>(DataPaths.configuredModels, DEFAULT_CONFIGURED_MODELS);
}

/**
 * models.list — Return the model registry, roleDefaults, and current overrides
 *
 * Optional params:
 *   provider: string   — filter models by provider
 *   agentType: string  — filter models by agent type compatibility
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  models: ModelEntry[];
  total: number;
  version: string;
  roleDefaults: Record<string, Record<string, string>>;
  overrides: Record<string, ModelOverride>;
  providers: Record<string, ProviderConfig>;
}> {
  const [data, configured] = await Promise.all([loadModels(), loadConfiguredModels()]);

  let models = data.models;

  if (body.provider) {
    models = models.filter(m => m.provider === body.provider);
  }

  if (body.agentType) {
    models = models.filter(m => m.agentTypes.includes(body.agentType as string));
  }

  return {
    models,
    total: models.length,
    version: data.version,
    roleDefaults: data.roleDefaults ?? {},
    overrides: configured.overrides,
    providers: configured.providers,
  };
}

/**
 * models.sync — Upsert or remove models in the registry
 *
 * Params:
 *   upsert: ModelEntry[]   — models to add or update (matched by id)
 *   remove: string[]       — model IDs to remove
 */
export async function sync(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ updated: number; removed: number; total: number }> {
  const data = await loadModels();

  const upserts: ModelEntry[] = Array.isArray(body.upsert) ? body.upsert : [];
  const removals: string[] = Array.isArray(body.remove) ? body.remove : [];

  // Apply removals
  const beforeCount = data.models.length;
  if (removals.length > 0) {
    data.models = data.models.filter(m => !removals.includes(m.id));
  }
  const removed = beforeCount - data.models.length;

  // Validate and apply upserts (update existing by id, append new)
  let updated = 0;
  const invalid: string[] = [];
  for (const entry of upserts) {
    if (!entry.id) continue;
    const isNew = data.models.findIndex(m => m.id === entry.id) < 0;
    // New entries must include classification; updates may omit it (merges with existing)
    if (isNew && !entry.classification) {
      invalid.push(entry.id);
      continue;
    }
    const idx = data.models.findIndex(m => m.id === entry.id);
    if (idx >= 0) {
      data.models[idx] = { ...data.models[idx], ...entry };
      updated++;
    } else {
      data.models.push(entry);
      updated++;
    }
  }

  if (invalid.length > 0) {
    throw new Error(`models.sync: new model entries missing required 'classification' field: ${invalid.join(', ')}`);
  }

  data.updatedAt = new Date().toISOString();
  await writeJsonFile(DataPaths.models, data);

  return { updated, removed, total: data.models.length };
}

/**
 * models.setOverride — Set a per-agent model override in configuredModels.json
 *
 * Params:
 *   agentName: string   — agent name (matches roster name)
 *   model: string       — model ID to override with
 *   provider?: string   — provider hint (e.g. 'google', 'anthropic')
 *   setBy?: string      — who set this override (defaults to 'user')
 */
export async function setOverride(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ agentName: string; model: string; previous: ModelOverride | null }> {
  const agentName = body.agentName as string;
  const model = body.model as string;
  if (!agentName || !model) throw new Error('agentName and model are required');

  const configured = await loadConfiguredModels();
  const previous = configured.overrides[agentName] ?? null;

  configured.overrides[agentName] = {
    model,
    provider: (body.provider as string) || undefined,
    setAt: new Date().toISOString(),
    setBy: (body.setBy as string) || 'user',
  };
  configured.updatedAt = new Date().toISOString();
  await writeJsonFile(DataPaths.configuredModels, configured);

  return { agentName, model, previous };
}

/**
 * models.removeOverride — Remove a per-agent model override from configuredModels.json
 *
 * Params:
 *   agentName: string   — agent name to remove override for
 */
export async function removeOverride(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ agentName: string; removed: boolean }> {
  const agentName = body.agentName as string;
  if (!agentName) throw new Error('agentName is required');

  const configured = await loadConfiguredModels();
  const existed = agentName in configured.overrides;

  if (existed) {
    delete configured.overrides[agentName];
    configured.updatedAt = new Date().toISOString();
    await writeJsonFile(DataPaths.configuredModels, configured);
  }

  return { agentName, removed: existed };
}

/**
 * models.configure — Store provider auth configuration (auth type only — keys go to vault)
 *
 * Params:
 *   provider: string                    — provider name (e.g. 'anthropic', 'google', 'openai')
 *   authType: 'api-key' | 'subscription' — auth method in use
 *   configured?: boolean               — mark as configured (default: true)
 */
export async function configure(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ provider: string; authType: string; configured: boolean }> {
  const provider = body.provider as string;
  const authType = body.authType as 'api-key' | 'subscription';
  if (!provider || !authType) throw new Error('provider and authType are required');
  if (authType !== 'api-key' && authType !== 'subscription') {
    throw new Error("authType must be 'api-key' or 'subscription'");
  }

  const configured = await loadConfiguredModels();
  const isConfigured = (body.configured as boolean) !== false; // default true

  configured.providers[provider] = {
    authType,
    configured: isConfigured,
    configuredAt: new Date().toISOString(),
  };
  configured.updatedAt = new Date().toISOString();
  await writeJsonFile(DataPaths.configuredModels, configured);

  return { provider, authType, configured: isConfigured };
}

/**
 * models.detect — Sprint M P1 T6 (Reynolds, 2026-05-27).
 *
 * Mirror of `POST /api/models/detect` into the agent-API dispatcher. Runs
 * `runIntegrationDetectionAndPersist()` to refresh the `integration` block
 * on every entry in `.AppData/models.json`. Idempotent — re-running with
 * no infrastructure change produces zero writes (wrote=false).
 *
 * Auth: the dispatcher in app/api/agent/route.ts already gates the action
 * by `requiredScope: 'write'` via the action registration in
 * actions/index.ts — no per-handler auth check needed here.
 *
 * Same detector logic + same persistence boundary as the route-handler
 * surface; dual-path coverage (Q1 lesson) means both endpoints converge
 * on `runIntegrationDetectionAndPersist()` under withFileLock.
 *
 * Returns the same DetectionRunReport shape as the route-handler POST.
 */
export async function detect(
  _body: AgentApiRequest,
  _auth: AgentAuthContext,
): Promise<{
  ranAt: string;
  totalModels: number;
  changed: number;
  unchanged: number;
  wrote: boolean;
  changes: Record<string, 'created' | 'updated' | 'unchanged'>;
}> {
  // Lazy import keeps the actions module light at load time; detection logic
  // pulls in adapters.py subprocess + filesystem reads we don't need for
  // models.list / models.sync / etc.
  const { runIntegrationDetectionAndPersist } = await import('@/lib/model-integration-persist');
  return runIntegrationDetectionAndPersist();
}
