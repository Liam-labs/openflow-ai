/**
 * Sprint 5 — Live-Feed Interpreter: Public Module Entry
 *
 * Pure data module — no React, no DOM, no I/O. Consumed by SummaryView /
 * FullView in `components/collab/agent-stream/`. The dispatch tables are
 * exposed as readonly so tests can introspect handler selection without
 * reaching into private internals.
 *
 * Layout:
 *   index.ts        — this file (public API + dispatch wiring)
 *   types.ts        — InterpretedAction, IconName, ToneName, Handler, etc.
 *   tone.ts         — resolveTone (6-step resolution per catalogue §10)
 *   utils.ts        — pure helpers (path strip, line range, basename, ...)
 *   outcome.ts      — buildOutcome + per-tool refiners
 *   handlers/       — one file per logical group; each exports
 *                     `registerHandlers(exact, family)`
 */

import type {
  DispatchTier,
  FamilyHandler,
  Handler,
  InterpretedAction,
  StreamItem,
} from './types';
import { resolveTone } from './tone';
import { buildOutcome } from './outcome';
import { buildOrphanAction, genericFallback, mcpUnknownFamily } from './handlers/fallback';

// Handler module imports — each module self-registers via registerHandlers.
import * as coreFs from './handlers/core-fs';
import * as coreSearch from './handlers/core-search';
import * as coreBash from './handlers/core-bash';
import * as coreAgent from './handlers/core-agent';
import * as coreSkill from './handlers/core-skill';
import * as coreTask from './handlers/core-task';
import * as coreDeferred from './handlers/core-deferred';
import * as familyGithub from './handlers/family-github';
import * as familySupabase from './handlers/family-supabase';
import * as familyOutlook from './handlers/family-outlook';
import * as familyMisc from './handlers/family-misc';

// ── Dispatch tables ────────────────────────────────────────────────────

const exactMutable: Record<string, Handler> = {};
const familyMutable: Record<string, FamilyHandler> = {};

const REGISTRARS = [
  coreFs,
  coreSearch,
  coreBash,
  coreAgent,
  coreSkill,
  coreTask,
  coreDeferred,
  familyGithub,
  familySupabase,
  familyOutlook,
  familyMisc,
];

for (const mod of REGISTRARS) {
  mod.registerHandlers(exactMutable, familyMutable);
}

/** Read-only view of registered exact-name handlers (test introspection). */
export const EXACT_HANDLERS: Readonly<Record<string, Handler>> = Object.freeze(
  { ...exactMutable },
);

/** Read-only view of registered MCP family handlers (test introspection). */
export const FAMILY_HANDLERS: Readonly<Record<string, FamilyHandler>> = Object.freeze(
  { ...familyMutable },
);

// ── Dispatch ──────────────────────────────────────────────────────────

const MCP_PREFIX = /^mcp__([^_]+(?:[_-][^_]+)*)__(.+)$/;

/**
 * Public introspection API. Returns which dispatch tier would be selected
 * for a given tool name. Used by the T4 test suite to assert routing
 * without exposing handler bodies.
 */
export function dispatchTier(toolName: string): DispatchTier {
  if (!toolName) return 'fallback';
  // Bash is registered in EXACT_HANDLERS so the runtime dispatch hits
  // it via tier 1, but conceptually it's its own tier per spec §5
  // (sub-tool sniffing). Report the conceptual tier so tests assert
  // the spec rather than the implementation detail.
  if (toolName === 'Bash') return 'bash';
  if (EXACT_HANDLERS[toolName]) return 'exact';
  const m = MCP_PREFIX.exec(toolName);
  if (m && FAMILY_HANDLERS[m[1]]) return 'family';
  return 'fallback';
}

function pickHandler(
  toolName: string,
): { run: (input: Record<string, unknown>, item: StreamItem) => InterpretedAction } {
  const exact = EXACT_HANDLERS[toolName];
  if (exact) {
    return { run: (input, item) => exact(input, item) };
  }
  const m = MCP_PREFIX.exec(toolName);
  if (m) {
    const family = FAMILY_HANDLERS[m[1]];
    if (family) {
      return { run: (input, item) => family(m[2], input, item) };
    }
    return { run: (input, item) => mcpUnknownFamily(m[2], input, item) };
  }
  return { run: (input, item) => genericFallback(input, item) };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Interpret a single tool_use StreamItem. If the paired tool_result is
 * known, pass it as the second arg to fill `outcome` immediately. Without
 * a result the action is returned with `outcome: null`.
 *
 * Tone is always resolved by `resolveTone` AFTER the handler runs — the
 * handler's own `tone` field is a hint that the resolver may override.
 * Determinism: identical inputs always produce deep-equal output.
 */
export function interpret(
  toolUse: StreamItem,
  toolResult?: StreamItem | null,
): InterpretedAction {
  const toolName = toolUse.toolName ?? '';
  const input =
    toolUse.toolInput && typeof toolUse.toolInput === 'object' ? toolUse.toolInput : {};
  const handler = pickHandler(toolName);
  const action = handler.run(input, toolUse);
  // Authoritative tone resolution.
  action.tone = resolveTone(toolName, input);
  if (toolResult) {
    action.outcome = buildOutcome(action, toolResult);
  }
  return action;
}

/**
 * Walk a list of StreamItems, pair tool_use with tool_result by toolUseId,
 * and return a parallel array of InterpretedAction (or null at indexes the
 * UI should skip).
 *
 * Skip rules:
 *   - Non-tool items (text, thinking, system, summary) → null
 *   - tool_result that was MERGED into a tool_use row → null
 *   - tool_result that has NO matching tool_use (orphan) → emit minimal
 *     orphan InterpretedAction (NOT null; per spec §8.5)
 */
export function interpretStream(
  items: StreamItem[],
): Array<InterpretedAction | null> {
  if (!Array.isArray(items)) return [];

  // Build use-id → result-item map for pairing.
  const resultByUseId = new Map<string, StreamItem>();
  const useIdsSeen = new Set<string>();
  for (const it of items) {
    if (it?.kind === 'tool_use' && it.toolUseId) useIdsSeen.add(it.toolUseId);
    if (it?.kind === 'tool_result' && it.toolUseId) {
      // Last write wins if duplicates appear (extremely rare in practice).
      resultByUseId.set(it.toolUseId, it);
    }
  }

  return items.map((item) => {
    if (!item) return null;
    if (item.kind === 'tool_use') {
      const result = item.toolUseId ? resultByUseId.get(item.toolUseId) ?? null : null;
      return interpret(item, result);
    }
    if (item.kind === 'tool_result') {
      // Merged into tool_use? skip.
      if (item.toolUseId && useIdsSeen.has(item.toolUseId)) return null;
      // Orphan — emit minimal action with outcome populated.
      const orphan = buildOrphanAction(item);
      orphan.outcome = buildOutcome(orphan, item);
      return orphan;
    }
    return null;
  });
}

// ── Re-exports ────────────────────────────────────────────────────────

export type {
  IconName,
  InterpretedAction,
  InterpretedOutcome,
  ToneName,
  Handler,
  FamilyHandler,
  DispatchTier,
  StreamItem,
} from './types';

export { resolveTone, resolveToneTier } from './tone';
export { buildOutcome } from './outcome';
export {
  basename,
  formatLineRange,
  normalizeToolResult,
  shortUrl,
  stripUserPath,
  summarizeToolInput,
  truncate,
  firstLine,
} from './utils';
