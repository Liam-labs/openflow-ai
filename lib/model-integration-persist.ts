/**
 * Model Integration Persistence — Sprint M P1 T3 (Reynolds, 2026-05-27).
 *
 * Reads `.AppData/models.json`, runs `detectIntegrationForRegistry()` across
 * every model entry, and writes back the `integration` blocks IFF the
 * detection produced a different result than what's already on disk.
 *
 * AMENDMENT #3 from Sam's plan: idempotent + auto-run on server start.
 *
 *   - **Idempotent.** Re-running with no infrastructure changes produces
 *     ZERO writes. Compares per-model integration blocks via JSON-string
 *     equality (modulo `detectedAt`) before deciding to persist.
 *   - **Auto-run on boot.** Wired into `instrumentation.ts` so every PM2
 *     restart refreshes the integration blocks within ~10s of startup
 *     (post-server-ready, matches the other deferred subsystem pattern).
 *   - **File-locked.** Uses `withFileLock` from `lib/data-io` so concurrent
 *     calls (rebuild + manual `POST /api/models/detect`) serialise cleanly.
 *
 * Read path is unchanged — `ModelEntry.integration?` is just a new optional
 * field that consumers (Systems "Models" tab) read directly from models.json
 * without going through this module.
 */

import path from 'path';
import { withFileLock, readJsonFile, writeJsonFile } from './data-io';
import { DataPaths } from './data-paths';
import {
  detectIntegrationForModel,
  type CapabilitySlug,
  CAPABILITY_SLUGS,
} from './model-integration-detect';
import type { ModelEntry, ModelIntegration } from './model-registry';

interface ModelsFile {
  models: ModelEntry[];
  roleDefaults?: Record<string, Record<string, string>>;
  [k: string]: unknown;
}

/**
 * Strict equality between two integration blocks, ignoring `detectedAt`.
 * Re-running detection MUST refresh `detectedAt` semantically (it's the
 * "we re-ran the check" marker), but if every capability is unchanged we
 * still skip the write to honour idempotency under no-infra-change.
 */
function integrationEquivalent(
  a: ModelIntegration | undefined,
  b: ModelIntegration,
): boolean {
  if (!a) return false;
  if (a.status !== b.status) return false;
  if (a.interfaceType !== b.interfaceType) return false;
  // Compare capability maps slug-by-slug. Don't trust JSON.stringify here
  // because key-order can vary across writers and that's not a real diff.
  for (const slug of CAPABILITY_SLUGS as readonly CapabilitySlug[]) {
    if (a.capabilities[slug] !== b.capabilities[slug]) return false;
  }
  return true;
}

/**
 * Outcome of a single detect-and-persist pass. Returned for telemetry +
 * the API endpoint that the UI will poll.
 */
export interface DetectionRunReport {
  /** ISO timestamp the pass started. */
  ranAt: string;
  /** Total entries inspected. */
  totalModels: number;
  /** Number of entries that received a NEW or CHANGED integration block. */
  changed: number;
  /** Number of entries already up-to-date (no write). */
  unchanged: number;
  /** True iff we actually wrote to models.json this pass. */
  wrote: boolean;
  /** Per-model diff for logging — { modelId: changeKind }. */
  changes: Record<string, 'created' | 'updated' | 'unchanged'>;
}

/**
 * Run detection across the entire model registry and persist the result
 * back to `.AppData/models.json` if any block changed.
 *
 * Safe to call concurrently — withFileLock serialises against itself + any
 * other writer using `DataPaths.models`.
 */
export async function runIntegrationDetectionAndPersist(): Promise<DetectionRunReport> {
  const ranAt = new Date().toISOString();
  return withFileLock(DataPaths.models, async () => {
    const file = await readJsonFile<ModelsFile>(DataPaths.models, { models: [] });
    const changes: Record<string, 'created' | 'updated' | 'unchanged'> = {};
    let changed = 0;

    for (const entry of file.models) {
      const fresh = detectIntegrationForModel(entry.agentTypes, ranAt);
      if (integrationEquivalent(entry.integration, fresh)) {
        changes[entry.id] = 'unchanged';
        continue;
      }
      const kind = entry.integration ? 'updated' : 'created';
      changes[entry.id] = kind;
      entry.integration = fresh;
      changed++;
    }

    const totalModels = file.models.length;
    const unchanged = totalModels - changed;
    let wrote = false;
    if (changed > 0) {
      await writeJsonFile(DataPaths.models, file);
      wrote = true;
    }

    return { ranAt, totalModels, changed, unchanged, wrote, changes };
  });
}

/**
 * Server-boot hook. Logs a one-line summary so post-restart triage can see
 * the detection ran. Never throws — caller (instrumentation.ts) should
 * fire-and-forget in the same deferred-startup tier as the qdrant init +
 * cron scheduler boot.
 */
export async function startupRunIntegrationDetection(): Promise<void> {
  try {
    const report = await runIntegrationDetectionAndPersist();
    if (report.wrote) {
      console.log(
        `[DevFlow] Model integration detection: ${report.changed} changed, ${report.unchanged} unchanged (wrote models.json)`,
      );
    } else {
      console.log(
        `[DevFlow] Model integration detection: ${report.totalModels} models, no changes (idempotent skip)`,
      );
    }
  } catch (err) {
    console.log(
      '[DevFlow] Model integration detection skipped:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Re-export DataPaths.models for tests that need to know the canonical path
// without re-importing data-paths themselves.
export const MODELS_JSON_PATH = DataPaths.models;
// Suppress unused-import lint — `path` import is kept for downstream sub-tasks
// that may need to resolve override locations relative to models.json.
void path;
