/**
 * Sprint A T3.1 — Antigravity step interpretation.
 *
 * an agent's Phase-2 producer (T2.1/T2.2) decodes Antigravity trajectory.proto
 * steps into Claude-shaped RawContentBlocks emitted on /api/agent-stream. A
 * decoded tool step surfaces the REAL downstream tool as `tool_use.name`
 * (e.g. "view_file", "run_command", "outlook check_auth_status") and carries
 * a human `toolSummary` + `toolAction` in the input — perfect for the card
 * title/verb, cleaner than deriving from the raw name.
 *
 * Antigravity has no Claude-style exact dispatch entry, so these steps reach
 * `genericFallback`; it delegates here when the agy markers are present. Tone
 * is owned by `resolveTone`, which also delegates to `antigravityTone` for
 * marked steps. Pure data — no React, no I/O.
 */

import type { IconName, InterpretedAction, StreamItem, ToneName } from '../types';
import { stripUserPath, summarizeToolInput, truncate } from '../utils';

/**
 * A tool_use originated from an Antigravity agent iff its input carries the
 * decoder's `toolSummary` / `toolAction` keys. Claude tool inputs never do,
 * so this is a safe discriminator that leaves Claude rendering untouched.
 */
export function isAntigravityStep(
  input: Record<string, unknown> | undefined,
): boolean {
  if (!input || typeof input !== 'object') return false;
  return typeof input.toolSummary === 'string' || typeof input.toolAction === 'string';
}

/** "view_file" -> "View file", "browser_click_element" -> "Browser click element". */
function prettifyName(name: string): string {
  if (!name) return 'tool';
  const spaced = name.replace(/[_-]/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Map an Antigravity tool name to a category icon (specific names first). */
function antigravityIcon(name: string): IconName {
  const n = (name || '').toLowerCase();
  if (n.startsWith('browser_')) return 'eye';
  switch (n) {
    case 'run_command':
    case 'command_status':
    case 'read_terminal':
      return 'terminal';
    case 'search_web':
    case 'open_browser_url':
    case 'read_url_content':
    case 'view_content_chunk':
      return 'globe';
    case 'list_permissions':
      return 'shield';
    case 'code_action':
      return 'edit-3';
    case 'git_commit':
      return 'git-branch';
    case 'compile':
    case 'lint_diff':
      return 'wrench';
    case 'generate_image':
      return 'image';
    case 'invoke_subagent':
      return 'brain';
    case 'knowledge_generation':
      return 'sparkles';
    default:
      break;
  }
  if (n.startsWith('list_')) return 'folder-search'; // list_dir, list_directory, list_resources…
  if (n.includes('search') || n === 'find') return 'search';
  if (n.startsWith('view_') || n.startsWith('read_') || n.endsWith('_outline')) return 'file-text';
  // MCP real-names surfaced as "server tool" (the owner's "tool visibility" ask).
  if (/^(outlook|gmail)\b/.test(n)) return 'mail';
  if (/^(supabase|qdrant|sqlite|psql)\b/.test(n)) return 'database';
  if (/^github\b/.test(n)) return 'git-pull-request';
  // A space = MCP "server tool" real-name → plug; otherwise an unknown core tool.
  return n.includes(' ') ? 'plug' : 'wrench';
}

/**
 * Resolve the tone for an Antigravity tool name. Heuristic but ordered:
 * destructive verbs → danger, outside-the-machine (web/browser/MCP/subagent)
 * → external, local mutations → mutate, everything else (reads) → neutral.
 */
export function antigravityTone(toolName: string): ToneName {
  const n = (toolName || '').toLowerCase();
  if (!n) return 'neutral';
  if (/(^|[ _-])(send|delete|remove|destroy|drop|revoke|cancel|reset|purge)([ _-]|$)/.test(n)) {
    return 'danger';
  }
  if (n.startsWith('browser_')) return 'external';
  if (/(search_web|read_url|open_browser|generate_image|invoke_subagent)/.test(n)) return 'external';
  if (n.includes(' ')) return 'external'; // MCP real-name "server tool"
  if (/(run_command|code_action|git_commit|compile|lint|^edit|^write|create|update|generate)/.test(n)) {
    return 'mutate';
  }
  return 'neutral';
}

/** Drop the agy meta keys so the arg-summary fallback picks a real argument. */
function stripAgyMeta(input: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'toolSummary' || k === 'toolAction') continue;
    rest[k] = v;
  }
  return rest;
}

/**
 * Build the InterpretedAction for an Antigravity step. Leads with the human
 * toolAction (verb) + toolSummary (subject); falls back to a prettified name
 * + arg summary. Tone is a hint here — `interpret()` re-resolves it via
 * `resolveTone` (which delegates to `antigravityTone`).
 */
export function interpretAntigravity(
  input: Record<string, unknown>,
  item: StreamItem,
): InterpretedAction {
  const toolName = item.toolName ?? '';
  const summary = typeof input.toolSummary === 'string' ? input.toolSummary : '';
  const action = typeof input.toolAction === 'string' ? input.toolAction : '';
  const subjectSrc = summary || summarizeToolInput(stripAgyMeta(input));
  return {
    icon: antigravityIcon(toolName),
    verb: truncate(action || prettifyName(toolName), 60),
    subject: truncate(stripUserPath(subjectSrc), 120),
    detail: '',
    outcome: null,
    tone: antigravityTone(toolName),
    toolName,
    toolUseId: item.toolUseId ?? '',
  };
}
