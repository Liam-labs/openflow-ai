/**
 * Sprint 5 — Live-Feed Interpreter: Pure Utilities
 *
 * No React, no DOM, no I/O. Safe to import from server, client, or vitest.
 *
 * Two helpers (`summarizeToolInput`, `normalizeToolResult`) were relocated
 * from `components/collab/agent-stream/helpers.ts` so the interpreter does
 * not have to reach back into `components/`. The original module re-exports
 * them so existing imports keep working.
 */

const HOME_PREFIX = /^\/home\/[^/]+\//;

/**
 * Replace the user's HOME prefix with `~/` in absolute paths. Other paths
 * pass through unchanged. SSR-safe — does not touch `process.env`.
 */
export function stripUserPath(path: string): string {
  if (typeof path !== 'string' || !path) return '';
  const home = HOME_PREFIX.exec(path);
  if (home) {
    return '~/' + path.slice(home[0].length);
  }
  return path;
}

/**
 * Last path segment. Strips trailing slash. Returns empty string for
 * malformed input. Works for both POSIX and URL-style paths.
 */
export function basename(path: string): string {
  if (typeof path !== 'string' || !path) return '';
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Format the Read/Edit `offset`/`limit` pair into a `L<start>-<end>` chip.
 * Returns null when neither is present.
 */
export function formatLineRange(input: Record<string, unknown>): string | null {
  const offset = numericOrNull(input.offset);
  const limit = numericOrNull(input.limit);
  if (offset == null && limit == null) return null;
  if (offset != null && limit != null) {
    return `L${offset}-${offset + limit}`;
  }
  if (offset != null) return `L${offset}+`;
  return `L0-${limit}`;
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/**
 * Compress a URL to `host/.../<last>/<segment>` for headlines. Falls back
 * to truncated original when parsing fails.
 */
export function shortUrl(url: string): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length <= 2) {
      return `${u.host}${u.pathname}`;
    }
    const tail = segments.slice(-2).join('/');
    return `${u.host}/.../${tail}`;
  } catch {
    return truncate(url, 80);
  }
}

/** Hard cap with ellipsis. Default 80 chars. */
export function truncate(s: string, max = 80): string {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Strip leading `cd <path> && …` (or `;`) shell preludes before tokenizing.
 * Handles repeated `cd X && cd Y && cmd …`. Non-greedy; stops at the first
 * non-cd-prelude segment so the real command survives.
 *
 * Used by both the Bash handler (verb/icon classification) AND the tone
 * resolver (flag-aware danger detection) — the resolver MUST normalize
 * the same way as the handler or `cd ~/x && git push --force` slips
 * through as `mutate` instead of `danger`.
 */
export function stripCdPrelude(command: string): string {
  let s = (command ?? '').trim();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const m = /^cd\s+\S+\s*(?:&&|;)\s*/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/**
 * Strip leading `sudo`, `env`, and `KEY=value` env-var assignments from a
 * tokenized command. Returns a fresh slice — does not mutate input.
 */
export function stripEnvAndSudo(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'sudo' || t === 'env' || /^[A-Z][A-Z0-9_]*=.+$/.test(t)) {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * Combined normalization: strip cd-prelude, then strip leading env-vars
 * and sudo/env tokens. Returns the cleaned command string ready for
 * regex matching or first-token lookup.
 */
export function normalizeBashCommand(command: string): string {
  const stripped = stripCdPrelude(command);
  if (!stripped) return '';
  const tokens = stripped.split(/\s+/);
  const cleaned = stripEnvAndSudo(tokens);
  return cleaned.join(' ');
}

/**
 * First non-empty line. Used for outcome summaries on errors and for
 * single-line previews of multi-line tool results.
 */
export function firstLine(s: string): string {
  if (typeof s !== 'string' || !s) return '';
  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Normalize a tool_result `content` field into a single display string.
 * Claude Code stores it as either a plain string or an array of sub-blocks
 * ({type:'text',text:...}, {type:'image',...}). Images collapse to a marker.
 *
 * RELOCATED from `components/collab/agent-stream/helpers.ts` — re-exported
 * from the original location for backwards compatibility.
 */
export function normalizeToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as { type?: string; text?: string };
    if (obj.type === 'text' && typeof obj.text === 'string') {
      parts.push(obj.text);
    } else if (obj.type === 'image') {
      parts.push('[image]');
    }
  }
  return parts.join('\n');
}

/**
 * Tiny one-line summary of a tool_use input for the Summary view. Picks a
 * recognisable "headline" field when present (file_path, pattern, command,
 * url, query), otherwise falls back to the first string value, then JSON.
 *
 * RELOCATED from `components/collab/agent-stream/helpers.ts` — re-exported
 * from the original location for backwards compatibility.
 */
export function summarizeToolInput(
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return '';
  const headlineKeys = [
    'file_path',
    'path',
    'pattern',
    'command',
    'url',
    'query',
    'description',
  ];
  for (const k of headlineKeys) {
    const v = input[k];
    if (typeof v === 'string' && v) return truncate(v, 120);
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return truncate(v, 120);
  }
  try {
    return truncate(JSON.stringify(input), 120);
  } catch {
    return '';
  }
}
