/**
 * Single source of truth for the Claude CLI spawn-env auth invariant.
 *
 * THE INVARIANT (runbook §0): an interactive Claude (`claude` / `claude.exe`)
 * agent session bills to the owner's Max subscription if and only if
 * ANTHROPIC_API_KEY is ABSENT from its spawned process env. The key is exported
 * in ~/.secrets and inherited by the DevFlow PM2 process env, so it is present
 * by default and MUST be explicitly removed by every spawn path. Forgetting to
 * remove it in one path silently flips that agent onto pay-per-token API
 * billing — exactly the regression that the Opus 4.8 rollout surfaced.
 *
 * Before this module the scrub logic was copy-pasted and divergent across the
 * three CLI spawn paths (lib/collab-pty.ts ×3),
 * and two of them stripped CLAUDECODE/CLAUDE_CODE_ENTRYPOINT but NOT the API
 * key. Centralising here = one place to be correct, guarded by
 * tests/unit/claude-spawn-env.test.ts (runbook §5b).
 *
 * PER-AGENT OPT-IN (authMode 'api-key', June to Oct 2026 rollout of the Max-limit fallback): one agent at a time can be switched to pay-per-token
 * API billing with the Anthropic key the owner saved in the Logins dialog (lib/anthropic-api-key.ts, encrypted at rest). The key is passed
 * to that agent only: in the env object of a child process, or through a private file the launch shell reads and deletes (never on a
 * command line). Every other agent, and every agent whose authMode is missing, still gets the scrub described above.
 *
 * DeepSeek is the sanctioned exception: it rides the Claude CLI but bills
 * DeepSeek via the headless ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL pair,
 * which it passes in `extra`. Those survive untouched — only ANTHROPIC_API_KEY
 * is stripped (DeepSeek sets it to '' to suppress the custom-API-key wizard;
 * deleting it outright achieves the same and keeps the invariant uniform).
 */

/**
 * Env keys every Claude CLI spawn must remove. Single source of truth shared by
 * the process-env builder ({@link scrubClaudeSpawnEnv}) and the shell-unset
 * prefix ({@link claudeSpawnUnsetPrefix}).
 *
 * - ANTHROPIC_API_KEY: enforces Max-subscription OAuth (see invariant above).
 * - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT: prevent "nested session" detection when
 *   spawned from a Claude context. Must be DELETED, not set to undefined — on
 *   Windows undefined passes through as an empty string and breaks claude.exe.
 */
export const CLAUDE_SPAWN_SCRUB_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'ANTHROPIC_API_KEY',
] as const;

/**
 * Build the process env for a Claude CLI spawn: inherit the current process env,
 * apply `extra` overrides (e.g. DeepSeek's AUTH_TOKEN/BASE_URL, channel
 * identity), then unconditionally strip the scrub keys. Use this for every spawn
 * path that passes an env object to `spawn()`.
 */
export function scrubClaudeSpawnEnv(
  extra: Record<string, string | undefined> = {},
  options: { apiKey?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of CLAUDE_SPAWN_SCRUB_KEYS) {
    delete env[key];
  }
  // A per-agent API key (authMode 'api-key') is the one deliberate way back in. DeepSeek agents (they carry their own token or endpoint) never get it.
  if (options.apiKey && !carriesOwnAnthropicEndpoint(extra)) {
    env.ANTHROPIC_API_KEY = options.apiKey;
    return env;
  }
  // API-key mode keeps only DevFlow's own key. A caller that sets the variable itself (DeepSeek sets it to '') still loses it.
  if (claudeUsesApiKey() && extra.ANTHROPIC_API_KEY === undefined && process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  return env;
}

/** True when `extra` points the Claude CLI at another provider (DeepSeek: ANTHROPIC_AUTH_TOKEN and/or ANTHROPIC_BASE_URL). */
export function carriesOwnAnthropicEndpoint(extra: Record<string, string | undefined>): boolean {
  return !!(extra.ANTHROPIC_AUTH_TOKEN || extra.ANTHROPIC_BASE_URL);
}

/** How one Claude agent pays: the Max plan (the default, the API key is scrubbed) or the saved Anthropic API key (per token). */
export type ClaudeAuthMode = 'max' | 'api-key';
export const CLAUDE_AUTH_MODES: readonly ClaudeAuthMode[] = ['max', 'api-key'];

/** Strict parse for input from a request: only the two known words. */
export function parseAuthMode(value: unknown): ClaudeAuthMode | null {
  return value === 'max' || value === 'api-key' ? value : null;
}

/** The mode an agent runs in. Anything missing or unknown means Max, so a damaged roster can never turn on API billing. */
export function authModeOf(agent: { authMode?: unknown } | null | undefined): ClaudeAuthMode {
  return agent?.authMode === 'api-key' ? 'api-key' : 'max';
}

/** Anthropic API keys start with sk-ant- and are printable ASCII without spaces. This also keeps a DeepSeek or other key out of the slot. */
export function isAnthropicApiKeyShape(key: unknown): key is string {
  return typeof key === 'string' && /^sk-ant-[A-Za-z0-9_-]{8,400}$/.test(key);
}

/** Shell lines that load the key from a private file the launcher wrote, then delete that file. Only the path is on the command line. */
export function claudeApiKeyFileLoad(filePath: string): string {
  const q = "'" + filePath.replace(/'/g, "'\\''") + "'";
  return `set -a; . ${q}; set +a; rm -f ${q};`;
}

/**
 * Opt-in for an installation that has no Claude subscription login: `DEVFLOW_CLAUDE_AUTH=api-key` lets Claude agents keep
 * ANTHROPIC_API_KEY. Anything else (including unset, which is how our own instance runs) keeps the subscription invariant above.
 */
export function claudeUsesApiKey(env: Record<string, string | undefined> = process.env): boolean {
  return (env.DEVFLOW_CLAUDE_AUTH || '').trim().toLowerCase() === 'api-key';
}

/**
 * Shell-prefix equivalent of {@link scrubClaudeSpawnEnv} for the tmux / WSL path,
 * which scrubs at the shell level rather than via a process-env object. Returns
 * `unset <keys>;` so it can be safely concatenated before the launch command.
 * Built from the same key list so the two paths can never drift.
 */
export function claudeSpawnUnsetPrefix(): string {
  const keys = claudeUsesApiKey() ? CLAUDE_SPAWN_SCRUB_KEYS.filter((k) => k !== 'ANTHROPIC_API_KEY') : CLAUDE_SPAWN_SCRUB_KEYS;
  return `unset ${keys.join(' ')};`;
}
