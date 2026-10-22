/**
 * Per-agent MCP config computation + filesystem writer.
 *
 * Sprint 38 T3.3 — Token Efficiency Pass. Given a role's `mcpServers` list and
 * a canonical source of server command configs (global `~/.mcp.json`), produce
 * the per-agent `.mcp.json` (project-level, Claude Code's native format) and
 * the `.claude/settings.local.json` allow-list (`enabledMcpjsonServers`).
 *
 * Design notes:
 *   - `computeAgentMcpConfig` is a PURE helper — no I/O. Unit-testable with
 *     fake inputs.
 *   - `writeAgentMcpConfig` is a thin wrapper that reads the canonical source
 *     + existing agent settings.local.json, calls the pure helper, and writes
 *     the two output files.
 *   - Servers in the role list that are NOT present in the canonical source
 *     (e.g. claude_ai_Supabase, outlook, remote/authenticated MCPs) are NOT
 *     written into per-agent .mcp.json but ARE listed in
 *     enabledMcpjsonServers. Claude Code resolves those at load time from
 *     its own global config, so the allow-list is still useful.
 *   - Universal fallback: empty role list → ['qdrant', 'snapshot'] via
 *     resolveMcpServersForRole semantics.
 *   - Idempotent: running twice with the same inputs produces identical
 *     files byte-for-byte.
 *
 * Consumed by roster.provision (T3.3 wiring).
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMcpServersForRole } from './role-tools';
import type { AgentRole } from './types';

export interface CanonicalMcpServersFile {
  mcpServers: Record<string, unknown>;
}

export interface ComputeAgentMcpConfigInput {
  roleMcpServers: string[];
  canonicalConfigs: Record<string, unknown> | null;
  existingSettingsLocal: Record<string, unknown> | null;
}

export interface ComputeAgentMcpConfigResult {
  projectMcpJson: { mcpServers: Record<string, unknown> };
  settingsLocalJson: Record<string, unknown>;
  resolvedServers: string[];
  unresolvedServers: string[];
}

/**
 * Pure helper. No I/O. Given a role's mcpServers list + a canonical command
 * config map + optional existing settings.local.json contents, compute the
 * files to write.
 */
export function computeAgentMcpConfig(
  input: ComputeAgentMcpConfigInput,
): ComputeAgentMcpConfigResult {
  const { roleMcpServers, canonicalConfigs, existingSettingsLocal } = input;

  // Apply the universal default when the role has no explicit list.
  // Reuses the role-tools helper so the default definition lives in one place.
  const effectiveServers = resolveMcpServersForRole({ mcpServers: roleMcpServers });

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const orderedServers: string[] = [];
  for (const s of effectiveServers) {
    if (!seen.has(s)) {
      seen.add(s);
      orderedServers.push(s);
    }
  }

  const resolvedServers: string[] = [];
  const unresolvedServers: string[] = [];
  const projectMcp: Record<string, unknown> = {};

  for (const name of orderedServers) {
    const cfg = canonicalConfigs?.[name];
    if (cfg && typeof cfg === 'object') {
      // Deep-copy the config so callers can't mutate the canonical input.
      projectMcp[name] = JSON.parse(JSON.stringify(cfg));
      resolvedServers.push(name);
    } else {
      unresolvedServers.push(name);
    }
  }

  // Merge with existing settings.local.json, preserving every key except
  // the two we own: enabledMcpjsonServers (role is source of truth) and
  // enableAllProjectMcpServers (always true so Claude Code auto-loads the
  // per-agent .mcp.json). Deep-copy via JSON roundtrip so callers can mutate
  // the result without touching the input.
  const mergedSettings: Record<string, unknown> = {
    ...(existingSettingsLocal ? JSON.parse(JSON.stringify(existingSettingsLocal)) : {}),
  };
  mergedSettings.enabledMcpjsonServers = [...orderedServers];
  mergedSettings.enableAllProjectMcpServers = true;

  return {
    projectMcpJson: { mcpServers: projectMcp },
    settingsLocalJson: mergedSettings,
    resolvedServers,
    unresolvedServers,
  };
}

export interface WriteAgentMcpConfigInput {
  agentDir: string;
  roleMcpServers: string[];
  canonicalMcpJsonPath: string;
}

export interface WriteAgentMcpConfigResult {
  resolvedServers: string[];
  unresolvedServers: string[];
  projectMcpJsonPath: string;
  settingsLocalJsonPath: string;
}

/**
 * Thin filesystem wrapper around `computeAgentMcpConfig`. Reads the canonical
 * source (best-effort — missing file is non-fatal), reads any existing
 * settings.local.json, computes the output, and writes both files.
 *
 * `agentDir` is created with mkdir -p if missing (safety net for provision
 * timing races — see caller in roster.provision). Only genuine I/O errors
 * on write will throw.
 */
export async function writeAgentMcpConfig(
  input: WriteAgentMcpConfigInput,
): Promise<WriteAgentMcpConfigResult> {
  const { agentDir, roleMcpServers, canonicalMcpJsonPath } = input;

  // Ensure the agent dir exists. In normal operation (roster.provision after
  // rollout + spawn) it already will; creating it here is a non-destructive
  // safety net for slightly-early calls or edge-case re-runs.
  await fs.mkdir(agentDir, { recursive: true });

  // Read canonical source best-effort.
  let canonicalConfigs: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(canonicalMcpJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as CanonicalMcpServersFile;
    if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null) {
      canonicalConfigs = parsed.mcpServers as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable canonical source — leave null so compute returns
    // all servers as unresolved but still writes the allow-list.
  }

  // Read existing agent settings.local.json if present.
  const claudeDir = join(agentDir, '.claude');
  const settingsLocalPath = join(claudeDir, 'settings.local.json');
  let existingSettingsLocal: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(settingsLocalPath, 'utf-8');
    existingSettingsLocal = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Missing / unreadable / malformed — start from scratch.
  }

  const result = computeAgentMcpConfig({
    roleMcpServers,
    canonicalConfigs,
    existingSettingsLocal,
  });

  // Write per-agent .mcp.json at the agent directory root (Claude Code's
  // native project-level config location).
  const projectMcpJsonPath = join(agentDir, '.mcp.json');
  await fs.mkdir(dirname(projectMcpJsonPath), { recursive: true });
  await fs.writeFile(
    projectMcpJsonPath,
    JSON.stringify(result.projectMcpJson, null, 2) + '\n',
    'utf-8',
  );

  // Write merged settings.local.json under .claude/.
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    settingsLocalPath,
    JSON.stringify(result.settingsLocalJson, null, 2) + '\n',
    'utf-8',
  );

  return {
    resolvedServers: result.resolvedServers,
    unresolvedServers: result.unresolvedServers,
    projectMcpJsonPath,
    settingsLocalJsonPath: settingsLocalPath,
  };
}

export interface ApplyRoleMcpConfigInput {
  agentDir: string;
  roleId: string | undefined;
  rolesJsonPath: string;
  canonicalMcpJsonPath: string;
}

export interface ApplyRoleMcpConfigResult {
  applied: boolean;
  reason?: string;
  result?: WriteAgentMcpConfigResult;
}

/**
 * Orchestration helper called from roster.provision. Looks up the role in
 * roles.json by id, extracts its mcpServers list (falling back to the
 * universal default if missing/empty), then calls writeAgentMcpConfig.
 *
 * Returns a structured result so the caller can log success/failure without
 * try/catching every branch. Does NOT throw for missing roleId or role-not-
 * found — those are expected cases during bootstrap or legacy provisions.
 * Genuine I/O errors on the write still surface as thrown exceptions.
 */
export async function applyRoleMcpConfigToAgentDir(
  input: ApplyRoleMcpConfigInput,
): Promise<ApplyRoleMcpConfigResult> {
  const { agentDir, roleId, rolesJsonPath, canonicalMcpJsonPath } = input;

  if (!roleId) {
    // P1.3 (Provisioning Hardening): roleless agents (e.g. role "Agent" / roleId
    // null, the default stamped at roster-ops.ts:88) still get the universal MCP
    // baseline via resolveMcpServersForRole, instead of NO .mcp.json. The empty-
    // .mcp.json gap (Worf had zero MCP tools) was exactly this skip-without-write.
    const result = await writeAgentMcpConfig({ agentDir, roleMcpServers: [], canonicalMcpJsonPath });
    return { applied: true, reason: 'universal default (no roleId)', result };
  }

  // Read roles.json and find the matching role.
  let roles: AgentRole[] = [];
  try {
    const raw = await fs.readFile(rolesJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { roles: AgentRole[] };
    roles = parsed.roles || [];
  } catch {
    return { applied: false, reason: `roles.json unreadable at ${rolesJsonPath}` };
  }

  const role = roles.find((r) => r.id === roleId);
  if (!role) {
    // P1.3: an unknown roleId still gets the universal MCP baseline, not empty.
    const result = await writeAgentMcpConfig({ agentDir, roleMcpServers: [], canonicalMcpJsonPath });
    return { applied: true, reason: `universal default (role ${roleId} not found)`, result };
  }

  // Universal default already baked into the role if mcpServers is absent,
  // courtesy of resolveMcpServersForRole inside computeAgentMcpConfig.
  const roleMcpServers = Array.isArray(role.mcpServers) ? role.mcpServers : [];

  const result = await writeAgentMcpConfig({
    agentDir,
    roleMcpServers,
    canonicalMcpJsonPath,
  });

  return { applied: true, result };
}
