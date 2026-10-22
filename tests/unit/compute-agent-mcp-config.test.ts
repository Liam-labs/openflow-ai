import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeAgentMcpConfig,
  writeAgentMcpConfig,
  applyRoleMcpConfigToAgentDir,
} from '@/lib/agent-mcp-config';

describe('computeAgentMcpConfig (pure helper)', () => {
  const canonical = {
    snapshot: { command: 'node', args: ['/opt/snapshot/index.js'] },
    qdrant: { command: '/venv/bin/python', args: ['/srv/mcp.py'] },
    'pdf-editor': { command: '/pdf/.venv/bin/python', args: ['-m', 'pdf_editor'] },
  };

  it('returns empty project mcp.json when role has no servers (falls back to universal defaults)', () => {
    const result = computeAgentMcpConfig({
      roleMcpServers: [],
      canonicalConfigs: canonical,
      existingSettingsLocal: null,
    });
    // Universal fallback: qdrant + snapshot
    expect(result.resolvedServers).toEqual(['qdrant', 'snapshot']);
    expect(result.unresolvedServers).toEqual([]);
    expect(Object.keys(result.projectMcpJson.mcpServers).sort()).toEqual(['qdrant', 'snapshot']);
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
  });

  it('filters canonical configs by the role mcpServers list (backend-dev pattern)', () => {
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot', 'claude_ai_Supabase'],
      canonicalConfigs: canonical,
      existingSettingsLocal: null,
    });
    // qdrant + snapshot resolved from canonical; claude_ai_Supabase is unresolved
    expect(result.resolvedServers).toEqual(['qdrant', 'snapshot']);
    expect(result.unresolvedServers).toEqual(['claude_ai_Supabase']);
    expect(Object.keys(result.projectMcpJson.mcpServers).sort()).toEqual(['qdrant', 'snapshot']);
    // All 3 go in the allow-list (claude_ai_Supabase lives elsewhere but should still be enabled)
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual([
      'qdrant',
      'snapshot',
      'claude_ai_Supabase',
    ]);
  });

  it('preserves full canonical config blocks (command + args + env)', () => {
    const richCanonical = {
      snapshot: {
        command: 'node',
        args: ['/opt/snapshot/index.js'],
        env: { SCREENSHOT_DIR: '/tmp/shots' },
      },
    };
    const result = computeAgentMcpConfig({
      roleMcpServers: ['snapshot'],
      canonicalConfigs: richCanonical,
      existingSettingsLocal: null,
    });
    expect(result.projectMcpJson.mcpServers.snapshot).toEqual({
      command: 'node',
      args: ['/opt/snapshot/index.js'],
      env: { SCREENSHOT_DIR: '/tmp/shots' },
    });
  });

  it('preserves existing settings.local.json fields other than enabledMcpjsonServers', () => {
    const existing = {
      enabledMcpjsonServers: ['qdrant', 'davinci-resolve'],
      enableAllProjectMcpServers: true,
      someOtherSetting: 'keep-me',
      otherObj: { nested: 'value' },
    };
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalConfigs: canonical,
      existingSettingsLocal: existing,
    });
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
    expect(result.settingsLocalJson.enableAllProjectMcpServers).toBe(true);
    expect(result.settingsLocalJson.someOtherSetting).toBe('keep-me');
    expect(result.settingsLocalJson.otherObj).toEqual({ nested: 'value' });
  });

  it('replaces enabledMcpjsonServers rather than merging (role is source of truth)', () => {
    const existing = {
      enabledMcpjsonServers: ['davinci-resolve', 'random-old-server'],
    };
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalConfigs: canonical,
      existingSettingsLocal: existing,
    });
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
    expect(result.settingsLocalJson.enabledMcpjsonServers).not.toContain('davinci-resolve');
    expect(result.settingsLocalJson.enabledMcpjsonServers).not.toContain('random-old-server');
  });

  it('order of enabledMcpjsonServers matches order in role mcpServers list', () => {
    const result = computeAgentMcpConfig({
      roleMcpServers: ['snapshot', 'qdrant'],
      canonicalConfigs: canonical,
      existingSettingsLocal: null,
    });
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual(['snapshot', 'qdrant']);
  });

  it('handles operations role mcpServers (qdrant + snapshot + outlook + pdf-editor)', () => {
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot', 'outlook', 'pdf-editor'],
      canonicalConfigs: canonical,
      existingSettingsLocal: null,
    });
    expect(result.resolvedServers.sort()).toEqual(['pdf-editor', 'qdrant', 'snapshot']);
    expect(result.unresolvedServers).toEqual(['outlook']);
    expect(Object.keys(result.projectMcpJson.mcpServers).sort()).toEqual([
      'pdf-editor',
      'qdrant',
      'snapshot',
    ]);
    // All 4 in the allow-list, in role order
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual([
      'qdrant',
      'snapshot',
      'outlook',
      'pdf-editor',
    ]);
  });

  it('deduplicates the enabledMcpjsonServers if the role list has dupes', () => {
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot', 'qdrant'],
      canonicalConfigs: canonical,
      existingSettingsLocal: null,
    });
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
  });

  it('null canonical source → all servers are unresolved, enabledMcpjsonServers still populated', () => {
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot', 'claude_ai_Supabase'],
      canonicalConfigs: null,
      existingSettingsLocal: null,
    });
    expect(result.resolvedServers).toEqual([]);
    expect(result.unresolvedServers).toEqual(['qdrant', 'snapshot', 'claude_ai_Supabase']);
    expect(result.projectMcpJson.mcpServers).toEqual({});
    expect(result.settingsLocalJson.enabledMcpjsonServers).toEqual([
      'qdrant',
      'snapshot',
      'claude_ai_Supabase',
    ]);
  });

  it('always sets enableAllProjectMcpServers: true (Jack R1 — makes Claude Code auto-load the per-agent .mcp.json)', () => {
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalConfigs: canonical,
      existingSettingsLocal: null,
    });
    expect(result.settingsLocalJson.enableAllProjectMcpServers).toBe(true);
  });

  it('sets enableAllProjectMcpServers: true even when existing settings had it false', () => {
    const existing = {
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: ['old'],
      someOtherKey: 'keep',
    };
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant'],
      canonicalConfigs: canonical,
      existingSettingsLocal: existing,
    });
    expect(result.settingsLocalJson.enableAllProjectMcpServers).toBe(true);
    expect(result.settingsLocalJson.someOtherKey).toBe('keep');
  });

  it('enabledMcpjsonServers is ALWAYS a superset of per-agent .mcp.json keys (invariant)', () => {
    // Partial resolution: some servers in canonical, some not.
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant', 'snapshot', 'claude_ai_Supabase', 'outlook', 'pdf-editor'],
      canonicalConfigs: canonical,
      existingSettingsLocal: null,
    });
    const allowList = result.settingsLocalJson.enabledMcpjsonServers as string[];
    const mcpKeys = Object.keys(result.projectMcpJson.mcpServers);
    for (const key of mcpKeys) {
      expect(allowList, `${key} in .mcp.json must also appear in allow-list`).toContain(key);
    }
  });

  it('returned objects are independent copies (no shared references with inputs)', () => {
    const existing = { enabledMcpjsonServers: ['old'], flag: true };
    const result = computeAgentMcpConfig({
      roleMcpServers: ['qdrant'],
      canonicalConfigs: canonical,
      existingSettingsLocal: existing,
    });
    // Mutate result — existing input must be unchanged
    (result.settingsLocalJson.enabledMcpjsonServers as string[]).push('mutated');
    expect(existing.enabledMcpjsonServers).toEqual(['old']);
    // Mutate the project mcp.json — canonical must be unchanged
    delete result.projectMcpJson.mcpServers.qdrant;
    expect(canonical.qdrant).toBeDefined();
  });
});

describe('writeAgentMcpConfig (thin I/O wrapper)', () => {
  let sandbox: string;
  let agentDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-mcp-config-'));
    agentDir = join(sandbox, 'Agent');
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes both .mcp.json and .claude/settings.local.json to the agent directory', async () => {
    const canonicalPath = join(sandbox, 'mcp.json');
    writeFileSync(
      canonicalPath,
      JSON.stringify({
        mcpServers: {
          qdrant: { command: 'python', args: ['/srv/qdrant.py'] },
          snapshot: { command: 'node', args: ['/srv/snapshot.js'] },
        },
      }),
    );
    const result = await writeAgentMcpConfig({
      agentDir,
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalMcpJsonPath: canonicalPath,
    });
    expect(result.resolvedServers).toEqual(['qdrant', 'snapshot']);
    expect(result.unresolvedServers).toEqual([]);

    const projMcp = JSON.parse(readFileSync(join(agentDir, '.mcp.json'), 'utf8'));
    expect(Object.keys(projMcp.mcpServers).sort()).toEqual(['qdrant', 'snapshot']);

    const settingsLocal = JSON.parse(
      readFileSync(join(agentDir, '.claude', 'settings.local.json'), 'utf8'),
    );
    expect(settingsLocal.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
  });

  it('creates .claude/ directory if missing', async () => {
    const canonicalPath = join(sandbox, 'mcp.json');
    writeFileSync(
      canonicalPath,
      JSON.stringify({ mcpServers: { qdrant: { command: 'x', args: [] } } }),
    );
    // Don't pre-create .claude/
    await writeAgentMcpConfig({
      agentDir,
      roleMcpServers: ['qdrant'],
      canonicalMcpJsonPath: canonicalPath,
    });
    expect(existsSync(join(agentDir, '.claude', 'settings.local.json'))).toBe(true);
  });

  it('preserves non-MCP fields in existing settings.local.json', async () => {
    const claudeDir = join(agentDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        enabledMcpjsonServers: ['old-server'],
        hasSeenTasksHint: true,
        someCustomKey: 'keep-me',
      }),
    );
    const canonicalPath = join(sandbox, 'mcp.json');
    writeFileSync(
      canonicalPath,
      JSON.stringify({
        mcpServers: {
          qdrant: { command: 'x', args: [] },
          snapshot: { command: 'y', args: [] },
        },
      }),
    );
    await writeAgentMcpConfig({
      agentDir,
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalMcpJsonPath: canonicalPath,
    });
    const settings = JSON.parse(
      readFileSync(join(claudeDir, 'settings.local.json'), 'utf8'),
    );
    expect(settings.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
    expect(settings.hasSeenTasksHint).toBe(true);
    expect(settings.someCustomKey).toBe('keep-me');
    expect(settings.enabledMcpjsonServers).not.toContain('old-server');
  });

  it('handles missing canonical mcp.json gracefully (all unresolved, still writes allow-list)', async () => {
    const result = await writeAgentMcpConfig({
      agentDir,
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalMcpJsonPath: '/nonexistent/mcp.json',
    });
    expect(result.resolvedServers).toEqual([]);
    expect(result.unresolvedServers).toEqual(['qdrant', 'snapshot']);
    const projMcp = JSON.parse(readFileSync(join(agentDir, '.mcp.json'), 'utf8'));
    expect(projMcp.mcpServers).toEqual({});
    const settings = JSON.parse(
      readFileSync(join(agentDir, '.claude', 'settings.local.json'), 'utf8'),
    );
    expect(settings.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
  });

  it('is idempotent — running twice produces the same output', async () => {
    const canonicalPath = join(sandbox, 'mcp.json');
    writeFileSync(
      canonicalPath,
      JSON.stringify({ mcpServers: { qdrant: { command: 'x', args: [] } } }),
    );
    await writeAgentMcpConfig({
      agentDir,
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalMcpJsonPath: canonicalPath,
    });
    const firstMcp = readFileSync(join(agentDir, '.mcp.json'), 'utf8');
    const firstSettings = readFileSync(join(agentDir, '.claude', 'settings.local.json'), 'utf8');
    await writeAgentMcpConfig({
      agentDir,
      roleMcpServers: ['qdrant', 'snapshot'],
      canonicalMcpJsonPath: canonicalPath,
    });
    expect(readFileSync(join(agentDir, '.mcp.json'), 'utf8')).toBe(firstMcp);
    expect(readFileSync(join(agentDir, '.claude', 'settings.local.json'), 'utf8')).toBe(firstSettings);
  });

  it('creates agentDir if missing (mkdir -p safety net for provision races)', async () => {
    const canonicalPath = join(sandbox, 'mcp.json');
    writeFileSync(
      canonicalPath,
      JSON.stringify({ mcpServers: { qdrant: { command: 'x', args: [] } } }),
    );
    const fresh = join(sandbox, 'nested', 'newly-created-agent-dir');
    expect(existsSync(fresh)).toBe(false);
    await writeAgentMcpConfig({
      agentDir: fresh,
      roleMcpServers: ['qdrant'],
      canonicalMcpJsonPath: canonicalPath,
    });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(fresh, '.mcp.json'))).toBe(true);
    expect(existsSync(join(fresh, '.claude', 'settings.local.json'))).toBe(true);
  });
});

describe('applyRoleMcpConfigToAgentDir (roster.provision orchestration)', () => {
  let sandbox: string;
  let agentDir: string;
  let rolesJsonPath: string;
  let canonicalMcpJsonPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'apply-role-mcp-'));
    agentDir = join(sandbox, 'Agent');
    mkdirSync(agentDir, { recursive: true });
    rolesJsonPath = join(sandbox, 'roles.json');
    canonicalMcpJsonPath = join(sandbox, 'mcp.json');

    writeFileSync(
      rolesJsonPath,
      JSON.stringify({
        roles: [
          {
            id: 'role-backend-1',
            name: 'Backend Dev',
            slug: 'backend-dev',
            mdPath: 'x.md',
            mcpServers: ['qdrant', 'snapshot', 'claude_ai_Supabase'],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'role-no-mcp',
            name: 'Empty',
            slug: 'empty',
            mdPath: 'x.md',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    writeFileSync(
      canonicalMcpJsonPath,
      JSON.stringify({
        mcpServers: {
          qdrant: { command: 'python', args: ['/srv/qdrant.py'] },
          snapshot: { command: 'node', args: ['/srv/snapshot.js'] },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('no roleId → applied=true, universal-default .mcp.json written (P1.3)', async () => {
    const r = await applyRoleMcpConfigToAgentDir({
      agentDir,
      roleId: undefined,
      rolesJsonPath,
      canonicalMcpJsonPath,
    });
    expect(r.applied).toBe(true);
    expect(r.reason).toMatch(/no roleId/i);
    // P1.3: roleless agents get the universal MCP baseline, not an empty/absent file.
    expect(existsSync(join(agentDir, '.mcp.json'))).toBe(true);
    expect((r.result?.resolvedServers.length ?? 0) + (r.result?.unresolvedServers.length ?? 0)).toBeGreaterThan(0);
  });

  it('unknown roleId → applied=true, universal-default .mcp.json written (P1.3)', async () => {
    const r = await applyRoleMcpConfigToAgentDir({
      agentDir,
      roleId: 'does-not-exist',
      rolesJsonPath,
      canonicalMcpJsonPath,
    });
    expect(r.applied).toBe(true);
    expect(r.reason).toMatch(/not found/i);
    expect(existsSync(join(agentDir, '.mcp.json'))).toBe(true);
    expect((r.result?.resolvedServers.length ?? 0) + (r.result?.unresolvedServers.length ?? 0)).toBeGreaterThan(0);
  });

  it('missing roles.json → applied=false with reason', async () => {
    const r = await applyRoleMcpConfigToAgentDir({
      agentDir,
      roleId: 'role-backend-1',
      rolesJsonPath: join(sandbox, 'nonexistent-roles.json'),
      canonicalMcpJsonPath,
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/roles\.json/i);
  });

  it('valid roleId → writes .mcp.json + settings.local.json per role mcpServers', async () => {
    const r = await applyRoleMcpConfigToAgentDir({
      agentDir,
      roleId: 'role-backend-1',
      rolesJsonPath,
      canonicalMcpJsonPath,
    });
    expect(r.applied).toBe(true);
    expect(r.result?.resolvedServers).toEqual(['qdrant', 'snapshot']);
    expect(r.result?.unresolvedServers).toEqual(['claude_ai_Supabase']);
    const projMcp = JSON.parse(readFileSync(join(agentDir, '.mcp.json'), 'utf8'));
    expect(Object.keys(projMcp.mcpServers).sort()).toEqual(['qdrant', 'snapshot']);
    const settings = JSON.parse(
      readFileSync(join(agentDir, '.claude', 'settings.local.json'), 'utf8'),
    );
    expect(settings.enabledMcpjsonServers).toEqual([
      'qdrant',
      'snapshot',
      'claude_ai_Supabase',
    ]);
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  it('role with no mcpServers field → falls back to universal default', async () => {
    const r = await applyRoleMcpConfigToAgentDir({
      agentDir,
      roleId: 'role-no-mcp',
      rolesJsonPath,
      canonicalMcpJsonPath,
    });
    expect(r.applied).toBe(true);
    expect(r.result?.resolvedServers).toEqual(['qdrant', 'snapshot']);
    const settings = JSON.parse(
      readFileSync(join(agentDir, '.claude', 'settings.local.json'), 'utf8'),
    );
    expect(settings.enabledMcpjsonServers).toEqual(['qdrant', 'snapshot']);
  });

  it('preserves pre-existing settings.local.json fields (R2: no clobber)', async () => {
    const claudeDir = join(agentDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        enabledMcpjsonServers: ['old'],
        enableAllProjectMcpServers: false,
        permissions: { allow: ['Read', 'Edit'] },
        customField: 'keep',
      }),
    );
    await applyRoleMcpConfigToAgentDir({
      agentDir,
      roleId: 'role-backend-1',
      rolesJsonPath,
      canonicalMcpJsonPath,
    });
    const settings = JSON.parse(
      readFileSync(join(claudeDir, 'settings.local.json'), 'utf8'),
    );
    expect(settings.permissions).toEqual({ allow: ['Read', 'Edit'] });
    expect(settings.customField).toBe('keep');
    expect(settings.enabledMcpjsonServers).toEqual([
      'qdrant',
      'snapshot',
      'claude_ai_Supabase',
    ]);
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });
});
