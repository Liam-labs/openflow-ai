/**
 * xAI capability-aware request-body builder.
 *
 * Reads model capabilities from .AppData/models.json and strips kwargs that the
 * target model does not support. Prevents 400s from xAI when e.g. a caller sends
 * temperature to a reasoning-only model.
 *
 * Mirror of scripts/grok_tools.py :: build_xai_kwargs().
 */
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { appPath } from '@/lib/app-paths';

interface ModelCapabilities {
  reasoning?: boolean;
  reasoningOnly?: boolean;
  toolUse?: boolean;
  supportsStreaming?: boolean;
  supportsTemperature?: boolean;
}

interface ModelEntry {
  id: string;
  provider: string;
  capabilities?: ModelCapabilities;
}

interface ModelsData {
  models?: ModelEntry[];
}

const MODELS_JSON = appPath('.AppData', 'models.json');

let cacheMtime = 0;
let cache: Record<string, ModelCapabilities> = {};

function loadXaiCapabilities(): Record<string, ModelCapabilities> {
  try {
    const mtime = statSync(MODELS_JSON).mtimeMs;
    if (mtime === cacheMtime && Object.keys(cache).length > 0) return cache;
    const raw = readFileSync(MODELS_JSON, 'utf-8');
    const data = JSON.parse(raw) as ModelsData;
    const entries: Record<string, ModelCapabilities> = {};
    for (const m of data.models ?? []) {
      if (m.provider === 'xai') entries[m.id] = m.capabilities ?? {};
    }
    cacheMtime = mtime;
    cache = entries;
    return entries;
  } catch {
    return {};
  }
}

export interface XaiRequestBody extends Record<string, unknown> {
  model: string;
}

/**
 * Returns a copy of `base` with kwargs forbidden by the model's capability
 * flags removed. Unknown models (not in the registry) pass through unchanged.
 */
export function buildXaiBody(model: string, base: Record<string, unknown>): XaiRequestBody {
  const caps = loadXaiCapabilities()[model];
  const out: XaiRequestBody = { model, ...base };
  if (!caps) return out;

  const drop = new Set<string>();
  if (caps.reasoningOnly) {
    ['temperature', 'top_p', 'stream', 'tools', 'tool_choice'].forEach(k => drop.add(k));
  }
  if (caps.supportsTemperature === false) {
    ['temperature', 'top_p'].forEach(k => drop.add(k));
  }
  if (caps.supportsStreaming === false) drop.add('stream');
  if (caps.toolUse === false) ['tools', 'tool_choice'].forEach(k => drop.add(k));

  for (const k of drop) delete out[k];
  return out;
}

/** Test-only: reset the module-level cache so tests can swap model fixtures. */
export function __resetXaiCapabilitiesCacheForTest(): void {
  cacheMtime = 0;
  cache = {};
}
