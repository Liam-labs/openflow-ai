/**
 * Sprint 38 T3.6 — Fresh-provision MCP config integration test.
 *
 * Directly exercises `applyRoleMcpConfigToAgentDir` (the function roster.provision
 * calls during T3.3) against a throwaway agent directory + the REAL roles.json
 * + the REAL ~/.mcp.json. Verifies that a fresh provision for a given role
 * produces the correct .mcp.json (resolved server configs) and
 * .claude/settings.local.json (enabledMcpjsonServers allow-list).
 *
 * Why this is a unit-integration rather than a full end-to-end test:
 * At the time this test was written, the running DevFlow build predated T3.3
 * (build timestamp 16:58, T3.3 code committed 21:00). A full roster.provision
 * API call therefore runs the OLD provisioning path that does NOT invoke
 * applyRoleMcpConfigToAgentDir. This test validates Alice's function in
 * isolation against real inputs; the full production path will be covered by
 * the nightly rebuild at 03:00 + a re-run of this test against the new build.
 *
 * Scenarios:
 *  1. Backend Dev role → qdrant+snapshot resolved into .mcp.json,
 *     claude_ai_Supabase in allow-list only, enableAllProjectMcpServers=true
 *  2. Researcher role → qdrant+snapshot only (no unresolved servers)
 *  3. Team Lead role → qdrant+snapshot+claude_ai_Supabase same as Backend Dev
 *  4. Unknown roleId → applied=false, reason set, no files written
 *  5. No roleId → applied=false, reason set
 *  6. Idempotency — second call produces byte-identical files
 *  7. settings.local.json merge — existing custom keys preserved
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { applyRoleMcpConfigToAgentDir } from '@/lib/agent-mcp-config';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const ROLES_JSON = join(REPO, 'data', 'roles', 'roles.json');
const CANONICAL_MCP_JSON = join(homedir(), '.mcp.json');

// Role IDs from data/roles/roles.json
const BACKEND_DEV_ID = '42ebd7dd-fa24-4ede-82a4-323c547cb3e9';
const RESEARCHER_ID = 'e6134857-4657-42e8-894c-7bf3fd1330db';
const TEAM_LEAD_ID = '04eecdef-cc15-44f6-9d8c-366774c2a466';

interface Fx {
  baseDir: string;
  agentDir: string;
  mcpJsonPath: string;
  settingsLocalPath: string;
}

function makeFx(): Fx {
  const baseDir = mkdtempSync(join(tmpdir(), 't36-prov-'));
  const agentDir = join(baseDir, 'TestAgent');
  mkdirSync(agentDir, { recursive: true });
  return {
    baseDir,
    agentDir,
    mcpJsonPath: join(agentDir, '.mcp.json'),
    settingsLocalPath: join(agentDir, '.claude', 'settings.local.json'),
  };
}

describe('Sprint 38 T3.6 — applyRoleMcpConfigToAgentDir (real roles.json + canonical MCP)', () => {
  let fx: Fx;

  beforeEach(() => {
    fx = makeFx();
  });

  afterEach(() => {
    rmSync(fx.baseDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Backend Dev — resolved + unresolved split ───────────────
  it('Backend Dev role produces correct .mcp.json + settings.local.json', async () => {
    const result = await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: BACKEND_DEV_ID,
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });

    expect(result.applied).toBe(true);
    expect(result.result).toBeDefined();

    // Resolved servers (snapshot + qdrant are in ~/.mcp.json)
    expect(result.result?.resolvedServers).toEqual(expect.arrayContaining(['qdrant', 'snapshot', 'outlook', 'devflow-gateway']));
    // Unresolved: claude_ai_Supabase + github are user-level Claude config,
    // they appear in the allow-list only.
    expect(result.result?.unresolvedServers.sort()).toEqual(['claude_ai_Supabase', 'github']);

    // .mcp.json file
    expect(existsSync(fx.mcpJsonPath)).toBe(true);
    const mcp = JSON.parse(readFileSync(fx.mcpJsonPath, 'utf8'));
    const mcpKeys = Object.keys(mcp.mcpServers);
    expect(mcpKeys).toContain('qdrant');
    expect(mcpKeys).toContain('snapshot');
    expect(mcpKeys).toContain('outlook');
    expect(mcpKeys).toContain('devflow-gateway');
    expect(mcpKeys).not.toContain('claude_ai_Supabase');
    // Each server entry must be an object (deep-copied, non-empty)
    for (const k of mcpKeys) {
      expect(typeof mcp.mcpServers[k]).toBe('object');
      expect(Object.keys(mcp.mcpServers[k]).length).toBeGreaterThan(0);
    }

    // settings.local.json file — full role list including unresolved servers.
    // Sprint 44 regression: outlook MUST appear here so Claude Code surfaces it.
    expect(existsSync(fx.settingsLocalPath)).toBe(true);
    const settings = JSON.parse(readFileSync(fx.settingsLocalPath, 'utf8'));
    expect(settings.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot', 'claude_ai_Supabase', 'outlook', 'github', 'devflow-gateway']);
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  // ── Scenario 2: Researcher — qdrant+snapshot resolved, outlook unresolved ─
  it('Researcher role produces qdrant+snapshot resolved + outlook in allow-list', async () => {
    const result = await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: RESEARCHER_ID,
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });

    expect(result.applied).toBe(true);
    expect(result.result?.resolvedServers.sort()).toEqual(['devflow-gateway', 'outlook', 'qdrant', 'snapshot']);
    expect(result.result?.unresolvedServers).toEqual(['github']);

    // Sprint 44 regression: outlook MUST appear in allow-list for non-backend roles too.
    const settings = JSON.parse(readFileSync(fx.settingsLocalPath, 'utf8'));
    expect(settings.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot', 'outlook', 'github', 'devflow-gateway']);
    expect(settings.enableAllProjectMcpServers).toBe(true);

    const mcp = JSON.parse(readFileSync(fx.mcpJsonPath, 'utf8'));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['devflow-gateway', 'outlook', 'qdrant', 'snapshot']);
  });

  // ── Scenario 3: Team Lead — same as Backend Dev ─────────────────────────
  it('Team Lead role produces qdrant+snapshot+claude_ai_Supabase+outlook allow-list', async () => {
    const result = await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: TEAM_LEAD_ID,
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });

    expect(result.applied).toBe(true);
    const settings = JSON.parse(readFileSync(fx.settingsLocalPath, 'utf8'));
    // Sprint 44 regression: full role list including outlook + supabase.
    expect(settings.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot', 'claude_ai_Supabase', 'outlook', 'github', 'devflow-gateway']);
  });

  // ── Scenario 4: Unknown roleId — P1.3: universal-default baseline written ─
  it('Unknown roleId returns applied=true and writes the universal-default baseline', async () => {
    const result = await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: '00000000-0000-0000-0000-000000000000',
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });

    expect(result.applied).toBe(true);
    expect(result.reason).toContain('not found');
    // P1.3: unknown role still gets the universal MCP baseline, not an empty file.
    expect(existsSync(fx.mcpJsonPath)).toBe(true);
    expect(existsSync(fx.settingsLocalPath)).toBe(true);
  });

  // ── Scenario 5: No roleId — P1.3: universal-default baseline written ─────
  it('Missing roleId returns applied=true and writes the universal-default baseline', async () => {
    const result = await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: undefined,
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });

    expect(result.applied).toBe(true);
    expect(result.reason).toContain('no roleId');
    expect(existsSync(fx.mcpJsonPath)).toBe(true);
  });

  // ── Scenario 6: Idempotency — second call produces byte-identical output ─
  it('applied twice produces byte-identical files', async () => {
    await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: BACKEND_DEV_ID,
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });
    const mcp1 = readFileSync(fx.mcpJsonPath);
    const settings1 = readFileSync(fx.settingsLocalPath);

    await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: BACKEND_DEV_ID,
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });
    const mcp2 = readFileSync(fx.mcpJsonPath);
    const settings2 = readFileSync(fx.settingsLocalPath);

    expect(mcp2.equals(mcp1)).toBe(true);
    expect(settings2.equals(settings1)).toBe(true);
  });

  // ── Scenario 7: settings.local.json merge preserves custom keys ─────────
  it('existing settings.local.json custom keys are preserved on merge', async () => {
    // Seed an existing settings.local.json with a custom key
    mkdirSync(join(fx.agentDir, '.claude'), { recursive: true });
    writeFileSync(
      fx.settingsLocalPath,
      JSON.stringify({
        customKey: 'preserved',
        hooks: { SessionStart: [{ matcher: '*', hooks: [] }] },
        permissions: { allow: ['Read'] },
      }),
      'utf8'
    );

    await applyRoleMcpConfigToAgentDir({
      agentDir: fx.agentDir,
      roleId: BACKEND_DEV_ID,
      rolesJsonPath: ROLES_JSON,
      canonicalMcpJsonPath: CANONICAL_MCP_JSON,
    });

    const merged = JSON.parse(readFileSync(fx.settingsLocalPath, 'utf8'));
    // MCP fields overwritten by role (Sprint 44 regression — outlook included).
    expect(merged.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot', 'claude_ai_Supabase', 'outlook', 'github', 'devflow-gateway']);
    expect(merged.enableAllProjectMcpServers).toBe(true);
    // Custom keys preserved
    expect(merged.customKey).toBe('preserved');
    expect(merged.hooks).toBeDefined();
    expect(merged.permissions).toEqual({ allow: ['Read'] });
  });
});
