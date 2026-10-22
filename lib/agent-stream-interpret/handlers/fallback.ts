/**
 * Sprint 5 — Generic fallbacks (catalogue §7).
 *
 * Two cases:
 *   - Unknown MCP family: `mcp__<server>__<action>` not in dispatch table.
 *     Emits a generic external-toned action with the server name visible.
 *   - Unknown core tool: anything else not in EXACT_HANDLERS.
 *
 * Plus the orphan-result builder used by `interpretStream` when a
 * `tool_result` arrives with no matching `tool_use` in the items array.
 */

import type { FamilyHandler, Handler, InterpretedAction, StreamItem } from '../types';
import { resolveTone } from '../tone';
import { summarizeToolInput } from '../utils';
import { interpretAntigravity, isAntigravityStep } from './antigravity';

/** Generic catch-all for unknown core tools. */
export const genericFallback: Handler = (input, item): InterpretedAction => {
  // Antigravity decoded steps reach here (no Claude exact-dispatch entry).
  // Render them via the agy interpreter when the decoder markers are present.
  if (isAntigravityStep(input)) return interpretAntigravity(input, item);
  const toolName = item.toolName ?? '';
  return {
    icon: 'wrench',
    verb: toolName || 'tool',
    subject: summarizeToolInput(input),
    detail: '',
    outcome: null,
    tone: resolveTone(toolName, input),
    toolName,
    toolUseId: item.toolUseId ?? '',
  };
};

/** Generic catch-all for unknown MCP families (catalogue §4 fallback row). */
export const mcpUnknownFamily: FamilyHandler = (action, input, item): InterpretedAction => {
  // Recover the server segment from the full tool name.
  const toolName = item.toolName ?? '';
  const m = /^mcp__([^_]+(?:[_-][^_]+)*)__/.exec(toolName);
  const server = m?.[1] ?? 'mcp';
  return {
    icon: 'plug',
    verb: `${server}: ${action.replace(/_/g, ' ')}`,
    subject: summarizeToolInput(input),
    detail: '',
    outcome: null,
    tone: resolveTone(toolName, input),
    toolName,
    toolUseId: item.toolUseId ?? '',
  };
};

/**
 * Build the synthetic InterpretedAction for an orphan tool_result —
 * a result with no matching tool_use in the items array. Outcome is
 * filled by the caller via buildOutcome(); tone reflects ok/error.
 */
export function buildOrphanAction(result: StreamItem): InterpretedAction {
  return {
    icon: 'wrench',
    verb: 'result',
    subject: '',
    detail: '(orphan — no matching tool_use)',
    outcome: null, // filled by buildOutcome
    tone: result.toolResultIsError ? 'danger' : 'neutral',
    toolName: '',
    toolUseId: result.toolUseId ?? '',
  };
}
