/**
 * Sprint 5 — Tone Resolution
 *
 * Single source of truth for `InterpretedAction.tone`. Follows the 6-step
 * resolution order from the spec (and catalogue §10):
 *
 *   1. Explicit per-tool override (catalogue §10a, §10b)
 *   2. MCP family pattern (catalogue §10c)
 *   3. Bash token + flag analysis (catalogue §10e)
 *   4. Skill category lookup (catalogue §10f)
 *   5. MCP unknown-family keyword sniff (catalogue §10d)
 *   6. Default neutral
 *
 * Pure function — no I/O, no randomness. Determinism guaranteed.
 */

import type { ToneName } from './types';
import { normalizeBashCommand } from './utils';
import { antigravityTone, isAntigravityStep } from './handlers/antigravity';

// ── 1. Explicit tones (catalogue §10a + §10b) ──────────────────────────

const EXPLICIT_TONES: Readonly<Record<string, ToneName>> = {
  // §10a — core
  Read: 'neutral',
  Glob: 'neutral',
  Grep: 'neutral',
  ToolSearch: 'neutral',
  Edit: 'mutate',
  Write: 'mutate',
  ScheduleWakeup: 'mutate',
  Agent: 'external',
  // §10b — deferred
  TaskGet: 'neutral',
  TaskList: 'neutral',
  TaskOutput: 'neutral',
  EnterPlanMode: 'neutral',
  ExitPlanMode: 'neutral',
  AskUserQuestion: 'neutral',
  Monitor: 'neutral',
  ListMcpResourcesTool: 'neutral',
  ReadMcpResourceTool: 'neutral',
  CronList: 'neutral',
  TaskCreate: 'mutate',
  TaskUpdate: 'mutate',
  EnterWorktree: 'mutate',
  ExitWorktree: 'mutate',
  CronCreate: 'mutate',
  NotebookEdit: 'mutate',
  WebSearch: 'external',
  WebFetch: 'external',
  PushNotification: 'external',
  RemoteTrigger: 'external',
  TaskStop: 'danger',
  CronDelete: 'danger',
};

// ── 2. MCP family patterns (catalogue §10c) ────────────────────────────
// Order matters — first match wins. More specific patterns first.

interface FamilyRule {
  pattern: RegExp;
  tone: ToneName;
}

const FAMILY_RULES: readonly FamilyRule[] = [
  // qdrant
  { pattern: /^mcp__qdrant__qdrant_(find|get)$/, tone: 'neutral' },
  { pattern: /^mcp__qdrant__qdrant_store$/, tone: 'mutate' },

  // snapshot — defaults external, two neutrals
  { pattern: /^mcp__snapshot__(scroll_page|wait_for)$/, tone: 'neutral' },
  { pattern: /^mcp__snapshot__/, tone: 'external' },

  // pdf-editor — explicit reads, then everything else mutate
  { pattern: /^mcp__pdf-editor__pdf_(read|info|search|get_form_fields|extract_images)$/, tone: 'neutral' },
  { pattern: /^mcp__pdf-editor__/, tone: 'mutate' },

  // outlook — danger first (most specific)
  { pattern: /^mcp__outlook__(send|reply|forward)_email$/, tone: 'danger' },
  { pattern: /^mcp__outlook__delete_/, tone: 'danger' },
  { pattern: /^mcp__outlook__cancel_event$/, tone: 'danger' },
  { pattern: /^mcp__outlook__revoke_authentication$/, tone: 'danger' },
  // Everything else outlook → external
  { pattern: /^mcp__outlook__/, tone: 'external' },

  // github — danger first
  { pattern: /^mcp__github__delete_file$/, tone: 'danger' },
  { pattern: /^mcp__github__merge_pull_request$/, tone: 'danger' },
  { pattern: /^mcp__github__/, tone: 'external' },

  // supabase — danger first
  { pattern: /^mcp__claude_ai_Supabase__(execute_sql|apply_migration|pause_project|delete_branch|reset_branch|rebase_branch)$/, tone: 'danger' },
  { pattern: /^mcp__claude_ai_Supabase__/, tone: 'external' },

  // canva — all external
  { pattern: /^mcp__canva__/, tone: 'external' },

  // OAuth-only families
  { pattern: /^mcp__claude_ai_(Gmail|Google_Calendar|Google_Drive)__/, tone: 'external' },

  // n8n — danger for delete_*, else external
  { pattern: /^mcp__n8n-mcp__delete_(workflow|execution)$/, tone: 'danger' },
  { pattern: /^mcp__n8n-mcp__/, tone: 'external' },
];

// ── 3. Bash command tone (catalogue §10e) ──────────────────────────────

const BASH_NEUTRAL_TOKENS = new Set(['ls', 'wc', 'head', 'tail', 'jq', 'source', 'cat']);
const BASH_NEUTRAL_GIT_SUBS = new Set(['status', 'log', 'diff', 'show', 'remote']);
const BASH_MUTATE_TOKENS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'uv',
  'pm2', 'mkdir', 'cp', 'mv', 'chmod', 'chown',
  'tsc', 'vitest', 'jest',
  'python', 'python3', 'node',
  'sqlite3', 'psql',
]);
const BASH_EXTERNAL_TOKENS = new Set(['curl', 'gh', 'docker', 'wget']);

const DOCKER_DANGER_SUBS = new Set(['rm', 'rmi', 'stop', 'kill']);

function bashTone(command: string): ToneName {
  // CRITICAL: same normalization the Bash handler uses, otherwise
  // `cd ~/x && git push --force` and `sudo rm -rf /` slip through as
  // mutate. Hole found by Weir's edge-case sanity check.
  const cmd = normalizeBashCommand(command);
  if (!cmd) return 'neutral';

  // Destructive flag patterns BEFORE token classification.
  if (
    /^git\s+push\s+(?:[^&|;]*\s)?--force(?:\s|$)/.test(cmd) ||
    /^git\s+push\s+(?:[^&|;]*\s)?-f(?:\s|$)/.test(cmd)
  ) {
    return 'danger';
  }
  if (/^git\s+reset\s+(?:[^&|;]*\s)?--hard(?:\s|$)/.test(cmd)) {
    return 'danger';
  }
  if (/^git\s+checkout\s+(?:[^&|;]*\s)?--(?:\s|$)/.test(cmd)) {
    return 'danger';
  }

  const tokens = cmd.split(/\s+/);
  const head = tokens[0];

  if (head === 'rm') return 'danger';
  if (BASH_NEUTRAL_TOKENS.has(head)) return 'neutral';

  if (head === 'git') {
    const sub = tokens[1] ?? '';
    if (BASH_NEUTRAL_GIT_SUBS.has(sub)) return 'neutral';
    if (sub === 'push') return 'external';
    if (sub === 'commit') return 'mutate';
    return 'mutate';
  }

  if (head === 'docker') {
    const sub = tokens[1] ?? '';
    if (DOCKER_DANGER_SUBS.has(sub)) return 'danger';
    return 'external';
  }

  if (BASH_EXTERNAL_TOKENS.has(head)) return 'external';
  if (BASH_MUTATE_TOKENS.has(head)) return 'mutate';

  return 'mutate';
}

// ── 4. Skill category tone (catalogue §10f) ────────────────────────────

const SKILL_CATEGORY_TONES: Readonly<Record<string, ToneName>> = {
  // Research / read-only
  review: 'neutral',
  'security-review': 'neutral',
  audit: 'neutral',
  critique: 'neutral',
  sessions: 'neutral',
  // Local file edits
  init: 'mutate',
  'init-project': 'mutate',
  simplify: 'mutate',
  doc: 'mutate',
  'flush-journal': 'mutate',
  'update-config': 'mutate',
  gitcommit: 'mutate',
  'sprint-plan': 'mutate',
  // Browser / external testing
  'browser-test': 'external',
  'ai-terminal': 'external',
  schedule: 'external',
  'task-claim': 'external',
  // Collab / messaging
  'collab-post': 'external',
  'collab-poll': 'external',
  'collab-join': 'external',
  broadcast: 'external',
  ask: 'external',
  'register-session': 'external',
  devflow: 'external',
  // UI modification
  animate: 'mutate',
  harden: 'mutate',
  optimize: 'mutate',
  colorize: 'mutate',
  typeset: 'mutate',
  polish: 'mutate',
  arrange: 'mutate',
  bolder: 'mutate',
  distill: 'mutate',
  quieter: 'mutate',
  overdrive: 'mutate',
  normalize: 'mutate',
  delight: 'mutate',
  onboard: 'mutate',
  clarify: 'mutate',
  extract: 'mutate',
  adapt: 'mutate',
  'frontend-design': 'mutate',
  'ui-ux': 'mutate',
  // SEO / content
  reporter: 'external',
  executor: 'external',
  'image-optimization': 'external',
  'internal-linking': 'external',
  'ux-seo': 'external',
  'technical-seo': 'external',
  'content-quality': 'external',
  'meta-tags-optimization': 'external',
  meta: 'external',
  // Loop / schedule
  'cancel-ralph': 'danger',
  'ralph-loop': 'mutate',
  loop: 'mutate',
  // API integrations
  'claude-api': 'external',
  rightmove: 'external',
  shopify: 'external',
  android: 'external',
  'cloudflare-tunnels': 'external',
  'one-plus': 'external',
};

// ── 5. MCP unknown-family keyword sniff (catalogue §10d) ───────────────

// Letter-boundary anchored — `mcp__foo__list_updates` must NOT match
// `update` (it's a noun-form list of updates, not the verb `update`).
// `\b` is wrong because regex word-class includes `_`, so `_update_`
// has no word boundaries. Use letter-class lookarounds instead, so
// `update_thing` and `update-thing` both match (verb form), but
// `list_updates` does not (the trailing `s` extends the action word).
const DANGER_KEYWORDS = /(?<![a-z])(delete|remove|destroy|drop|purge|cancel|revoke|reset)(?![a-z])/i;
const EXTERNAL_KEYWORDS = /(?<![a-z])(create|update|send|write|push|deploy|merge|fork)(?![a-z])/i;

function mcpFallbackTone(toolName: string): ToneName {
  if (DANGER_KEYWORDS.test(toolName)) return 'danger';
  if (EXTERNAL_KEYWORDS.test(toolName)) return 'external';
  return 'external'; // §10d: any mcp__ default is external
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Resolve the tone for a tool invocation. Inputs are read-only.
 *
 * @param toolName  Verbatim Claude Code tool name (e.g. 'Read', 'Bash',
 *                  'mcp__github__create_pull_request', 'Skill').
 * @param input     The `tool_use` input object — needed for Bash flag
 *                  analysis and Skill category lookup. May be undefined.
 */
export function resolveTone(
  toolName: string,
  input?: Record<string, unknown>,
): ToneName {
  if (!toolName) return 'neutral';

  // 1. Explicit
  const explicit = EXPLICIT_TONES[toolName];
  if (explicit) return explicit;

  // 2. MCP family pattern
  if (toolName.startsWith('mcp__')) {
    for (const rule of FAMILY_RULES) {
      if (rule.pattern.test(toolName)) return rule.tone;
    }
  }

  // 3. Bash token + flags
  if (toolName === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : '';
    return bashTone(command);
  }

  // 4. Skill category
  if (toolName === 'Skill') {
    const skill = typeof input?.skill === 'string' ? input.skill : '';
    return SKILL_CATEGORY_TONES[skill] ?? 'neutral';
  }

  // 4.5 Antigravity decoded steps (carry toolSummary/toolAction marker).
  // Their real-tool names aren't mcp__-prefixed, so resolve here before the
  // mcp/default tiers.
  if (isAntigravityStep(input)) return antigravityTone(toolName);

  // 5. MCP unknown-family keyword sniff
  if (toolName.startsWith('mcp__')) {
    return mcpFallbackTone(toolName);
  }

  // 6. Default
  return 'neutral';
}

/**
 * Test-only introspection: which tier resolved the tone? Useful for
 * vitest assertions on the dispatch path without exposing internal maps.
 */
export function resolveToneTier(
  toolName: string,
  input?: Record<string, unknown>,
): 'explicit' | 'family' | 'bash' | 'skill' | 'mcp-fallback' | 'default' {
  if (!toolName) return 'default';
  if (EXPLICIT_TONES[toolName]) return 'explicit';
  if (toolName.startsWith('mcp__')) {
    for (const rule of FAMILY_RULES) {
      if (rule.pattern.test(toolName)) return 'family';
    }
  }
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'Skill') return 'skill';
  if (toolName.startsWith('mcp__')) return 'mcp-fallback';
  void input;
  return 'default';
}
