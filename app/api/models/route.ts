import { NextResponse } from 'next/server';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { tracked, withTiming } from '@/lib/api-tracking';
import { parseQueryParams, z } from '@/lib/api-validation';
import type { ModelIntegration, CapabilityLevel } from '@/lib/model-registry';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

interface ModelCapabilities {
  reasoning?: boolean;
  reasoningOnly?: boolean;
  vision?: boolean;
  toolUse?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsTemperature?: boolean;
  preview?: boolean;
}

interface ModelEntry {
  id: string;
  provider: string;
  classification: string;
  label: string;
  description?: string;
  tier: string;
  agentTypes: string[];
  isDefault?: boolean;
  apiId?: string;
  capabilities?: ModelCapabilities;
  /** Sprint M P1 — auto-detected integration depth. Populated on server
   *  boot by instrumentation.ts → startupRunIntegrationDetection(). */
  integration?: ModelIntegration;
}

interface ModelsData {
  version: string;
  updatedAt: string;
  roleDefaults?: Record<string, Record<string, string>>;
  models: ModelEntry[];
}

interface ConfiguredModelsData {
  overrides?: Record<string, { model: string; provider?: string; setAt: string; setBy?: string }>;
  providers?: Record<string, { authType: string; configured: boolean; configuredAt?: string }>;
}

const DEFAULT_MODELS: ModelsData = { version: '1.0.0', updatedAt: new Date().toISOString(), models: [] };
const DEFAULT_CONFIGURED: ConfiguredModelsData = { overrides: {}, providers: {} };

// Ordinal severity rank for capability comparisons. `capability=hooks:full`
// matches when the model's hooks capability is 'full'; `hooks:partial`
// matches 'partial' OR 'full'; `hooks:none` matches everything (vacuous).
const CAP_RANK: Record<CapabilityLevel, number> = { none: 0, partial: 1, full: 2 };

// Sprint M P1 T4 — Reynolds, 2026-05-27. Co-located query schema per
// Q1's api-validation pattern. `includeIntegration` opts into the new
// integration blocks; `capability` is a comma-separated list of
// `slug:level` filters applied to ModelEntry.integration.capabilities.
const ModelsQuerySchema = z.object({
  agentType: z.string().min(1).max(100).optional(),
  provider: z.string().min(1).max(100).optional(),
  includeIntegration: z.enum(['true', 'false']).optional()
    .transform((v) => v === 'true'),
  /** Format: `slug:level[,slug:level]*` e.g. `hooks:full,scaffolding:partial`.
   *  Each constraint requires the model's capability for `slug` to be at
   *  the requested level OR higher. */
  capability: z.string().min(1).max(2048).optional(),
});

/** Parse a `slug:level,slug:level,...` constraint string into structured form.
 *  Throws nothing — invalid pieces are dropped silently; caller's schema
 *  has already validated the overall string shape. */
function parseCapabilityFilter(raw: string): Array<{ slug: string; min: CapabilityLevel }> {
  const out: Array<{ slug: string; min: CapabilityLevel }> = [];
  for (const piece of raw.split(',')) {
    const [slug, level] = piece.split(':').map((s) => s.trim().toLowerCase());
    if (!slug || !level) continue;
    if (level !== 'none' && level !== 'partial' && level !== 'full') continue;
    out.push({ slug, min: level as CapabilityLevel });
  }
  return out;
}

function modelMatchesCapabilityFilter(
  model: ModelEntry,
  constraints: Array<{ slug: string; min: CapabilityLevel }>,
): boolean {
  // No integration block → only matches when ALL constraints are 'none' (vacuous).
  const caps = model.integration?.capabilities ?? {};
  for (const { slug, min } of constraints) {
    const actual = (caps[slug] as CapabilityLevel | undefined) ?? 'none';
    if (CAP_RANK[actual] < CAP_RANK[min]) return false;
  }
  return true;
}

export const GET = withTiming('/api/models', tracked('/api/models', async (request: Request) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const parsed = parseQueryParams(request, ModelsQuerySchema, { label: 'models query' });
  if (!parsed.ok) return parsed.response;
  const { agentType, provider, includeIntegration, capability } = parsed.data;

  const [data, configured] = await Promise.all([
    readJsonFile<ModelsData>(DataPaths.models, DEFAULT_MODELS),
    readJsonFile<ConfiguredModelsData>(DataPaths.configuredModels, DEFAULT_CONFIGURED),
  ]);

  let models = data.models;
  if (agentType) models = models.filter(m => m.agentTypes.includes(agentType));
  if (provider) models = models.filter(m => m.provider === provider);

  if (capability) {
    const constraints = parseCapabilityFilter(capability);
    models = models.filter((m) => modelMatchesCapabilityFilter(m, constraints));
  }

  // Strip integration blocks unless explicitly requested. Keeps the default
  // payload size unchanged for existing consumers; opt-in via the new flag.
  const responseModels = includeIntegration
    ? models
    : models.map(({ integration: _omit, ...rest }) => rest);

  return NextResponse.json({
    models: responseModels,
    total: responseModels.length,
    version: data.version,
    roleDefaults: data.roleDefaults ?? {},
    overrides: configured.overrides ?? {},
    providers: configured.providers ?? {},
  }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}));
