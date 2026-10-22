/**
 * DeepSeek backbone-swap env injection.
 *
 * Sprint 66 T2 — when an agent's --model is a supported DeepSeek model,
 * the claude CLI must be spawned with ANTHROPIC_BASE_URL pointing at DeepSeek's
 * Anthropic-compatible endpoint and ANTHROPIC_API_KEY set to the user's
 * DeepSeek key. Sonnet/Opus/Haiku agents are unaffected.
 *
 * KB reference: ~/DevFlow/data/central-knowledge-base/user/integrations/deepseek-api.md
 *
 * Security:
 *  - The API key is read from $DEEPSEEK_API_KEY at spawn time, never logged.
 *  - The shell-prefix variant emits the variable reference, not the value, so
 *    the key never lands in process listings or logs (`ps -ef` shows the prefix
 *    string, not the resolved key).
 */

import { readFileSync } from 'fs';
import path from 'path';
import { getHomeDir } from '@/lib/home-dir';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
// DeepSeek-V4.1-Flash's canonical API name is `deepseek-flash`. DeepSeek's
// Claude Code guide uses the explicit `[1m]` variant, while the retired
// `deepseek-v4-flash` name remains a provider-side compatibility alias.
// V4 Pro remains valid until its announced retirement window completes.
const DEEPSEEK_MODEL_PATTERN = /^(?:deepseek-flash|deepseek-v4-(?:pro|flash)|deepseek-v4-flash-vision-exp)(?:\[1m\])?$/;

/**
 * Strict match for the DeepSeek model IDs we support. Anchored regex prevents
 * shell-injection model names from passing.
 */
export function isDeepSeekModel(modelName: string | undefined): boolean {
  if (!modelName) return false;
  return DEEPSEEK_MODEL_PATTERN.test(modelName);
}

/** Backwards-compatible export for existing callers/tests. */
export const isDeepSeekV4Model = isDeepSeekModel;

/**
 * Extract the value passed to --model in a claude CLI flag array, or undefined
 * if --model is absent or trailing.
 */
function extractModelFlag(claudeFlags: readonly string[]): string | undefined {
  const idx = claudeFlags.indexOf('--model');
  if (idx < 0 || idx + 1 >= claudeFlags.length) return undefined;
  return claudeFlags[idx + 1];
}

/**
 * Build a shell prefix that configures the claude CLI for DeepSeek agents.
 *
 * Returns empty string for non-DeepSeek models so callers can unconditionally
 * concatenate without affecting Claude/Gemini/Grok/Codex agents.
 *
 * Auth strategy: ANTHROPIC_AUTH_TOKEN
 * ─────────────────────────────────────
 * ANTHROPIC_AUTH_TOKEN is the "headless" auth path — when set, the claude CLI
 * uses it directly as the Bearer token for all API calls WITHOUT showing any
 * interactive login wizard. This is the correct approach for programmatic
 * DeepSeek agents: no wizard, no browser flow, no OAuth validation.
 *
 * ANTHROPIC_API_KEY is unset to prevent the custom-API-key wizard (shown
 * whenever a non-sk-ant- key is in ANTHROPIC_API_KEY) from appearing.
 *
 * The variable references ($DEEPSEEK_API_KEY) are left unresolved — bash
 * resolves them at exec time so the literal value never enters DevFlow logs
 * or `ps` output.
 *
 * CLAUDE_CONFIG_DIR is pointed at a temp dir containing:
 *   - settings.json (copied, for theme prefs / to skip first-run wizard)
 *   - .claude.json (minimal) with migration flags to suppress upgrade nags
 *   - .credentials.json (synthesised) where claudeAiOauth.accessToken =
 *     DEEPSEEK_API_KEY. Present as fallback; ANTHROPIC_AUTH_TOKEN takes
 *     priority for actual API calls. subscriptionType "max" and non-empty
 *     refreshToken prevent subscription-check or re-auth flows.
 *
 * With ANTHROPIC_BASE_URL pointed at DeepSeek and ANTHROPIC_AUTH_TOKEN set
 * to the DeepSeek key, every API call sends:
 *   Authorization: Bearer <DeepSeek API token>
 *   POST https://api.deepseek.com/anthropic/v1/messages
 * → accepted by DeepSeek. No login wizard ever appears.
 *
 * @param claudeFlags  CLI flags array — must contain a supported DeepSeek model.
 * @param workingDirectory  The agent's actual working directory. Used to pre-approve the
 *   trust dialog and CLAUDE.md external @includes for that path. When omitted, falls back
 *   to $PWD which is incorrect for roster agents (the cd happens after env setup).
 */
export function buildDeepSeekShellEnv(claudeFlags: readonly string[], workingDirectory?: string): string {
  const model = extractModelFlag(claudeFlags);
  if (!isDeepSeekModel(model)) return '';
  // Embed the actual working directory as a literal so the trust dialog is pre-approved
  // for the correct path. $PWD at shell execution time is the tmux launch dir, which is
  // NOT the agent's working dir (the cd happens after this env setup block runs).
  const wdLiteral = workingDirectory
    ? `'${workingDirectory.replace(/'/g, "'\\''")}'`  // single-quote escape for shell safety
    : '"$PWD"';                                        // fallback: per-message spawns without a fixed cwd
  return (
    `[ -f "$HOME/.secrets" ] && . "$HOME/.secrets"; ` +
    `_DSTMP=$(mktemp -d); ` +
    // Copy settings to skip theme/first-run wizard
    `[ -f "$HOME/.claude/settings.json" ] && cp "$HOME/.claude/settings.json" "$_DSTMP/"; ` +
    // .claude.json: suppress all first-run wizards.
    // - hasCompletedOnboarding + lastOnboardingVersion → skips security notice / "Press Enter"
    // - projects[workingDirectory].hasTrustDialogAccepted → skips "Do you trust this folder?" dialog
    // - projects[workingDirectory].hasClaudeMdExternalIncludesApproved → skips external @import warning
    `_CJ="$_DSTMP/.claude.json"; ` +
    `[ -f "$HOME/.claude.json" ] && cp "$HOME/.claude.json" "$_CJ" || ` +
    `printf '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.131","opusProMigrationComplete":true,"sonnet1m45MigrationComplete":true,"seenNotifications":{},"migrationVersion":13}' > "$_CJ"; ` +
    `_CJ="$_CJ" _WD=${wdLiteral} python3 -c "
import json, os
f = os.environ['_CJ']
wd = os.environ['_WD']
d = json.load(open(f))
d.setdefault('hasCompletedOnboarding', True)
proj = d.setdefault('projects', {}).setdefault(wd, {})
proj['hasTrustDialogAccepted'] = True
proj['hasClaudeMdExternalIncludesApproved'] = True
proj['hasClaudeMdExternalIncludesWarningShown'] = True
proj.setdefault('allowedTools', [])
proj.setdefault('mcpContextUris', [])
proj.setdefault('mcpServers', {})
proj.setdefault('enabledMcpjsonServers', [])
proj.setdefault('disabledMcpjsonServers', [])
json.dump(d, open(f, 'w'))
" 2>/dev/null || true; ` +
    // Synthesise credentials.json: accessToken = DeepSeek key, far-future expiry.
    // ANTHROPIC_AUTH_TOKEN takes priority for API calls; this is a belt-and-suspenders
    // fallback. subscriptionType "max" + non-empty refreshToken match real credential
    // format to prevent subscription-check or re-auth flows.
    `printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"x","expiresAt":9999999999999,"scopes":["user:inference"],"subscriptionType":"max","rateLimitTier":"default"}}' "$DEEPSEEK_API_KEY" > "$_DSTMP/.credentials.json"; ` +
    // ANTHROPIC_AUTH_TOKEN = DeepSeek key → direct Bearer, bypasses all login wizards.
    // ANTHROPIC_API_KEY unset → no custom-API-key wizard.
    // CLAUDE_CONFIG_DIR → temp dir so real ~/.claude/.credentials.json (Claude Max
    // OAuth token) is not read — that token would be rejected by DeepSeek's endpoint.
    `export ANTHROPIC_BASE_URL="${DEEPSEEK_BASE_URL}" ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" CLAUDE_CONFIG_DIR="$_DSTMP"; unset ANTHROPIC_API_KEY; `
  );
}

/**
 * Build an env override for the Windows path (claude.exe via Node child_process
 * spawn). DevFlow's PM2 process env does NOT include DEEPSEEK_API_KEY, so we
 * read it directly: process.env first, then ~/.secrets as fallback.
 *
 * Returns empty object for non-DeepSeek models, or when the key is
 * neither in process.env nor in ~/.secrets — never half-configures the env.
 */
export function buildDeepSeekProcessEnv(
  claudeFlags: readonly string[],
): Record<string, string> {
  const model = extractModelFlag(claudeFlags);
  if (!isDeepSeekModel(model)) return {};

  let apiKey: string | undefined = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    apiKey = readDeepSeekKeyFromSecrets();
  }
  if (!apiKey) return {};

  return {
    ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
    // Direct Bearer token — bypasses all login wizards (headless/CI auth path).
    ANTHROPIC_AUTH_TOKEN: apiKey,
    // Blank API key to prevent the custom-API-key wizard from appearing.
    ANTHROPIC_API_KEY: '',
  };
}

/**
 * Parse $HOME/.secrets for an export DEEPSEEK_API_KEY=value line. Tolerates
 * optional `export ` prefix and surrounding single/double quotes.
 *
 * Internal helper — exported only for tests; do NOT call from app code (use
 * buildDeepSeekProcessEnv).
 */
function readDeepSeekKeyFromSecrets(): string | undefined {
  try {
    const secretsPath = path.join(getHomeDir(), '.secrets');
    const content = readFileSync(secretsPath, 'utf-8');
    const match = content.match(/^(?:export\s+)?DEEPSEEK_API_KEY=(.+?)$/m);
    if (!match) return undefined;
    return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}
