/**
 * Model Registry — Shared resolution logic
 *
 * Three-layer model resolution (highest priority first):
 *   1. configuredModels.json overrides  — per-agent explicit overrides (UI-managed)
 *   2. models.json roleDefaults         — role+agentType defaults
 *   3. models.json isDefault:true       — global provider default
 *
 * Used at spawn time (roster.ts) and drift detection (sync.py mirrors this logic).
 * All reads are synchronous — this runs on the hot path before roster_add.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { appPath } from '@/lib/app-paths';

export interface ModelCapabilities {
  inputModes?: Array<'text' | 'image' | 'audio' | 'video' | 'file'>;
  outputModes?: Array<'text' | 'image' | 'audio'>;
  reasoning?: boolean;
  reasoningOnly?: boolean;
  vision?: boolean;
  toolUse?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsTemperature?: boolean;
  preview?: boolean;
  thinkingModes?: string[];
}

/**
 * Sprint M P1 — Reynolds, 2026-05-27.
 *
 * Ordinal severity tier used by `ModelIntegration.status` and by per-capability
 * entries in `ModelIntegration.capabilities`. Convention:
 *   - 'none'    — runtime capability is missing entirely. Provisioning may
 *                 succeed but the feature does nothing.
 *   - 'partial' — runtime works but with caveats (e.g. hook coverage at
 *                 log-only level, or scaffolding deploys but is not native).
 *   - 'full'    — capability has parity with the canonical Claude runtime.
 *
 * Per Sam's plan §1.5: aggregate `status` is computed from per-capability
 * counts: all 8 `full` → `full`; ≥4 `full` → `partial`; <4 → `none`.
 */
export type CapabilityLevel = 'none' | 'partial' | 'full';

/**
 * Auto-detected integration depth for a model.
 *
 * NEVER hand-maintained. The `model-integration-detect.ts` pass (NEW file,
 * Sprint M Phase 1.2) reads existing infrastructure (wrappers, scaffolding
 * adapters, hook events, provisioning registrations) and writes this back
 * into models.json on demand via `POST /api/models/detect`.
 *
 * Sprint M plan reference: docs/plan-model-integration-framework.md §1.5.
 */
export interface ModelIntegration {
  /** Aggregate severity — computed from `capabilities` per the §1.5 rule. */
  status: CapabilityLevel;
  /** Canonical interface label (e.g. 'claude-code', 'codex',
   *  'antigravity', 'gemini-cli', 'grok-cli'). Maps from `agentType` per
   *  the §1.3 table. Use the constant declared elsewhere if you need a
   *  programmatic list — string here keeps the schema open for new
   *  interfaces without a type-system change every time. */
  interfaceType: string;
  /** ISO 8601 timestamp of the most recent detection pass that wrote this
   *  block. Lets the UI show 'detected 3h ago' and the API guard against
   *  staleness when a wrapper update should trigger a re-detect. */
  detectedAt: string;
  /** Per-capability map. Keys are capability slugs (e.g. 'sessionPersistence',
   *  'hookCoverage', 'scaffoldingNative', 'webgateAware', ...). Values are
   *  the same `CapabilityLevel` enum. Schema is open — capabilities can be
   *  added without breaking older records. Detection pass owns the slug list;
   *  consumers should treat unknown slugs as 'none'. */
  capabilities: Record<string, CapabilityLevel>;
}

export interface ModelEntry {
  id: string;
  /** Provider-retired IDs that should still resolve for persisted roster and
   * override records, without remaining selectable registry entries. */
  aliases?: string[];
  agentTypes: string[];
  isDefault?: boolean;
  apiId?: string;
  /** Which API/auth this model routes to (e.g. 'anthropic', 'deepseek').
   *  See resolveProviderForModel. */
  provider?: string;
  capabilities?: ModelCapabilities;
  /** Auto-detected integration depth. Absent for legacy entries written
   *  before Sprint M; the detection pass populates them. Consumers reading
   *  this field must handle the undefined case as 'integration unknown,
   *  treat as none'. Sprint M P1 (Reynolds, 2026-05-27). */
  integration?: ModelIntegration;
}

interface ModelsData {
  models: ModelEntry[];
  roleDefaults?: Record<string, Record<string, string>>;
}

interface ConfiguredModelsData {
  overrides?: Record<string, { model: string; provider?: string }>;
}

function findModelEntry(
  models: ModelEntry[] | undefined,
  modelId: string,
): ModelEntry | undefined {
  return models?.find(model =>
    model.id === modelId
    || (Array.isArray(model.aliases) && model.aliases.includes(modelId)),
  );
}

function readJsonSync<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective model for an agent at spawn time.
 *
 * @param agentName  - Roster agent name (matches configuredModels.json key)
 * @param roleSlug   - Role slug (e.g. 'backend-dev', 'researcher')
 * @param agentType  - Agent type (e.g. 'claude', 'gemini', 'grok')
 * @returns Model ID string, or undefined if nothing resolves
 */
export function resolveModelFromRegistry(
  agentName: string,
  roleSlug: string,
  agentType: string
): string | undefined {
  const dataDir = appPath('.AppData');

  // Layer 1: per-agent override in configuredModels.json
  const configured = readJsonSync<ConfiguredModelsData>(
    path.join(dataDir, 'configuredModels.json')
  );
  const override = configured?.overrides?.[agentName];
  if (override?.model) return override.model;

  // Layer 2: roleDefaults in models.json
  const modelsData = readJsonSync<ModelsData>(path.join(dataDir, 'models.json'));
  if (modelsData?.roleDefaults) {
    const roleEntry =
      modelsData.roleDefaults[roleSlug] ?? modelsData.roleDefaults['_default'];
    if (roleEntry?.[agentType]) return roleEntry[agentType];
  }

  // Layer 3: isDefault model for this agentType
  if (modelsData?.models) {
    const defaultModel = modelsData.models.find(
      m => m.agentTypes.includes(agentType) && m.isDefault
    );
    if (defaultModel?.id) return defaultModel.id;
  }

  return undefined;
}

/**
 * Given a user-facing short model ID (e.g. "sonnet", "opus"), return the
 * canonical downstream `apiId` if the registry has one, else the input
 * unchanged. Used by spawn paths (Claude CLI `--model`, direct API calls)
 * to ensure they route to the intended variant — e.g. the 1M-context
 * sonnet/opus variants instead of the 200K defaults.
 */
export function resolveApiIdForModel(modelId: string): string {
  if (!modelId) return modelId;
  const dataDir = appPath('.AppData');
  const modelsData = readJsonSync<ModelsData>(path.join(dataDir, 'models.json'));
  const entry = findModelEntry(modelsData?.models, modelId);
  return entry?.apiId || modelId;
}

/** Return the registry-declared context window for a model, if known. */
export function resolveContextWindowForModel(modelId: string): number | null {
  if (!modelId) return null;
  const dataDir = appPath('.AppData');
  const modelsData = readJsonSync<ModelsData>(path.join(dataDir, 'models.json'));
  const value = findModelEntry(modelsData?.models, modelId)?.capabilities?.contextWindow;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Given a user-facing short model ID, return its registry `provider`
 * (e.g. "anthropic", "deepseek"), or null when the model is unknown.

 */
export function resolveProviderForModel(modelId: string): string | null {
  if (!modelId) return null;
  const dataDir = appPath('.AppData');
  const modelsData = readJsonSync<ModelsData>(path.join(dataDir, 'models.json'));
  const entry = findModelEntry(modelsData?.models, modelId);
  return entry?.provider || null;
}

/**
 * Sprint c62ebbd2 Phase A1 — canonical "what wrapper do I spawn for this model?"
 * lookup.
 *
 * Returns the first compatible agentType from the model's `agentTypes` registry
 * list, or null when the model is unknown or has no listed runtimes. The
 * registry's array ordering encodes preference (preferred runtime first).
 *
 * Used by:
 *   - roster.add default selection (B1) — pick the runtime that matches the
 *     requested model instead of falling back to a hard-coded 'claude' default
 *   - setOverride auto-routing (B2) — when an override model is incompatible
 *     with the current agentType, infer the right one
 *   - roster.update model-change path (B3) — same shape
 */
export function inferAgentTypeForModel(modelId: string): string | null {
  if (!modelId) return null;
  const dataDir = appPath('.AppData');
  const modelsData = readJsonSync<ModelsData>(path.join(dataDir, 'models.json'));
  const entry = findModelEntry(modelsData?.models, modelId);
  const first = entry?.agentTypes?.[0];
  return typeof first === 'string' && first ? first : null;
}

/**
 * Sprint c62ebbd2 Phase A2 — validator companion for callers that want to
 * check whether a (modelId, agentType) pair is allowed before mutating.
 *
 * Returns true iff the model exists in the registry AND the agentType is in
 * its `agentTypes` list. Returns false for unknown models, missing agentTypes,
 * empty inputs, or unreadable registry — fail-closed, never throws.
 */
export function isAgentTypeCompatibleWith(modelId: string, agentType: string): boolean {
  if (!modelId || !agentType) return false;
  const dataDir = appPath('.AppData');
  const modelsData = readJsonSync<ModelsData>(path.join(dataDir, 'models.json'));
  const entry = findModelEntry(modelsData?.models, modelId);
  if (!entry || !Array.isArray(entry.agentTypes)) return false;
  return entry.agentTypes.includes(agentType);
}
