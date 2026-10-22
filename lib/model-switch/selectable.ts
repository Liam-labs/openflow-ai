/**
 * Model Switcher P3.1 — pure selector for the Switch-Model picker.
 *
 * Given the model registry and a live agent's current model, produce the list
 * of switchable targets grouped by canonical agentType. Excludes the current
 * model (the backend rejects a same-model switch as a no-op) and any model
 * with no wrapper (empty agentTypes — backend would reject it too). Pure: no
 * React, no I/O — unit-testable.
 */

import type { ModelEntry } from '@/components/colab-types';
import { getModelLabel, isReasoningOnlyModel } from '@/lib/model-label';

export interface SwitchTarget {
  id: string;
  label: string;
  reasoningOnly: boolean;
}

export interface SwitchTargetGroup {
  agentType: string;
  models: SwitchTarget[];
}

/** A model's effective downstream identity — its apiId if it has one, else its
 *  id. Two registry entries with the same effective apiId (e.g. `opus` and
 *  `opus[1m]`, both → claude-opus-4-8[1m]) invoke the identical model. */
function effectiveApiId(entry: ModelEntry): string {
  return entry.apiId || entry.id;
}

export function selectSwitchTargets(
  registry: ModelEntry[] | undefined,
  currentModelId: string | undefined | null,
): SwitchTargetGroup[] {
  if (!Array.isArray(registry)) return [];

  // Resolve the current model's effective apiId so we can hide every alias of
  // the model the agent is already on (the backend rejects a same-model switch
  // anyway — offering it is pure confusion).
  const currentEntry = currentModelId
    ? registry.find(m =>
        m && (m.id === currentModelId || m.aliases?.includes(currentModelId)),
      )
    : undefined;
  const currentApiId = currentEntry ? effectiveApiId(currentEntry) : currentModelId;

  const groups = new Map<string, SwitchTarget[]>();
  const seenApiIds = new Set<string>();
  for (const entry of registry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    const apiId = effectiveApiId(entry);
    if (apiId === currentApiId) continue; // current model + its aliases → unreachable
    if (seenApiIds.has(apiId)) continue; // collapse duplicate-apiId entries to one
    const agentType =
      Array.isArray(entry.agentTypes) && entry.agentTypes.length > 0
        ? entry.agentTypes[0]
        : '';
    if (!agentType) continue; // no wrapper → not a valid switch target
    seenApiIds.add(apiId);
    const list = groups.get(agentType) ?? [];
    list.push({
      id: entry.id,
      label: getModelLabel(entry.id, registry),
      reasoningOnly: isReasoningOnlyModel(entry.id, registry),
    });
    groups.set(agentType, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agentType, models]) => ({
      agentType,
      models: models.sort((a, b) => a.label.localeCompare(b.label)),
    }));
}
