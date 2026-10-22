/**
 * Role Tool Permission Tiers
 *
 * Parses YAML frontmatter from role .md files to extract per-role tool allowlists.
 * Used at agent spawn time to inject --allowedTools flags, reducing blast radius.
 *
 * Frontmatter format in role .md files:
 * ---
 * allowedTools:
 *   - Read
 *   - Edit
 *   - Bash
 * ---
 */

import matter from 'gray-matter';

export interface RoleFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse YAML frontmatter from a role markdown file.
 * Returns the parsed frontmatter data and the markdown body (without frontmatter).
 */
export function parseRoleFrontmatter(md: string): RoleFrontmatter {
  const parsed = matter(md);
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    body: parsed.content.trim(),
  };
}

/**
 * Extract the allowedTools list from a role markdown file's frontmatter.
 * Returns null if no allowedTools key exists (unrestricted role).
 * Returns the array if present (even if empty — that means "no tools allowed").
 */
export function getAllowedToolsForRole(roleContent: string): string[] | null {
  const { frontmatter } = parseRoleFrontmatter(roleContent);
  if (!('allowedTools' in frontmatter)) return null;
  const tools = frontmatter.allowedTools;
  if (!Array.isArray(tools)) return null;
  return tools.map(String);
}

/**
 * Infrastructure tools always available to all restricted roles.
 * These are meta-tools (sub-agent spawning, deferred schema loading)
 * that don't affect blast radius but are required for agent framework operation.
 */
export const INFRASTRUCTURE_TOOLS = ['Agent', 'ToolSearch'] as const;

/**
 * Get the effective tool list for a role: frontmatter allowedTools + infrastructure tools.
 * Returns null if no allowedTools specified (unrestricted role).
 */
export function getEffectiveToolsForRole(roleContent: string): string[] | null {
  const tools = getAllowedToolsForRole(roleContent);
  if (tools === null) return null;
  const effective = [...tools];
  for (const infra of INFRASTRUCTURE_TOOLS) {
    if (!effective.includes(infra)) {
      effective.push(infra);
    }
  }
  return effective;
}

/**
 * Build the comma-separated value for the --allowedTools CLI flag.
 */
export function buildAllowedToolsFlag(tools: string[]): string {
  return tools.join(',');
}

/**
 * Universal MCP server defaults — applied when a role has no explicit
 * `mcpServers` field or when the field is an empty array.
 *
 * Sprint 38 T3.1 audit (an agent) showed snapshot is near-universal (5 of 6
 * active roles use it) and deferring it costs ~749K tokens per mid-session
 * ToolSearch. Pre-loading costs ~60K. qdrant is the memory-access baseline
 * required by every role.
 */
export const UNIVERSAL_MCP_SERVERS: readonly string[] = ['qdrant', 'snapshot'];

/**
 * Resolve the effective MCP server list for a role. Returns the role's
 * explicit `mcpServers` list if present and non-empty; otherwise returns a
 * fresh copy of UNIVERSAL_MCP_SERVERS. The returned array is always a copy
 * so callers can mutate it safely.
 *
 * Sprint 38 T3.2 — feeds T3.3 (roster.provision .mcp.json writer).
 */
export function resolveMcpServersForRole(
  role: { mcpServers?: string[] | null } | null | undefined,
): string[] {
  if (!role || !Array.isArray(role.mcpServers) || role.mcpServers.length === 0) {
    return [...UNIVERSAL_MCP_SERVERS];
  }
  return [...role.mcpServers];
}
