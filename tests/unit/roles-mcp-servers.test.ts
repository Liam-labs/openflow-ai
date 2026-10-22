import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRole } from '@/lib/types';
import {
  resolveMcpServersForRole,
  UNIVERSAL_MCP_SERVERS,
} from '@/lib/role-tools';

const ROLES_JSON = resolve(process.cwd(), 'data/roles/roles.json');

function loadRoles(): AgentRole[] {
  const raw = readFileSync(ROLES_JSON, 'utf8');
  const parsed = JSON.parse(raw) as { roles: AgentRole[] };
  return parsed.roles;
}

function bySlug(roles: AgentRole[], slug: string): AgentRole | undefined {
  return roles.find((r) => r.slug === slug);
}

describe('UNIVERSAL_MCP_SERVERS', () => {
  it('exports qdrant + snapshot as the universal default', () => {
    expect(Array.isArray(UNIVERSAL_MCP_SERVERS)).toBe(true);
    expect([...UNIVERSAL_MCP_SERVERS]).toEqual(['qdrant', 'snapshot']);
  });
});

describe('resolveMcpServersForRole (pure helper)', () => {
  it('returns universal defaults when role is null', () => {
    expect(resolveMcpServersForRole(null)).toEqual(['qdrant', 'snapshot']);
  });

  it('returns universal defaults when role is undefined', () => {
    expect(resolveMcpServersForRole(undefined)).toEqual(['qdrant', 'snapshot']);
  });

  it('returns universal defaults when mcpServers field is missing', () => {
    expect(resolveMcpServersForRole({})).toEqual(['qdrant', 'snapshot']);
  });

  it('returns universal defaults when mcpServers is an empty array', () => {
    expect(resolveMcpServersForRole({ mcpServers: [] })).toEqual(['qdrant', 'snapshot']);
  });

  it('returns the role-specified list when present and non-empty', () => {
    expect(
      resolveMcpServersForRole({ mcpServers: ['qdrant', 'snapshot', 'claude_ai_Supabase'] }),
    ).toEqual(['qdrant', 'snapshot', 'claude_ai_Supabase']);
  });

  it('returns a copy, not a reference (caller mutation safe)', () => {
    const input = { mcpServers: ['qdrant', 'snapshot'] };
    const result = resolveMcpServersForRole(input);
    result.push('mutated');
    expect(input.mcpServers).toEqual(['qdrant', 'snapshot']);
  });

  it('returns a copy of the universal default (caller mutation safe)', () => {
    const a = resolveMcpServersForRole(null);
    a.push('x');
    const b = resolveMcpServersForRole(null);
    expect(b).toEqual(['qdrant', 'snapshot']);
  });
});

describe('roles.json mcpServers data population (Sprint 38 T3.2)', () => {
  it('roles.json is loadable and contains at least 8 roles (7 existing + operations)', () => {
    const roles = loadRoles();
    expect(roles.length).toBeGreaterThanOrEqual(8);
  });

  it('every existing role has an mcpServers field', () => {
    const roles = loadRoles();
    for (const role of roles) {
      expect(role.mcpServers, `role ${role.slug} is missing mcpServers`).toBeDefined();
      expect(Array.isArray(role.mcpServers), `role ${role.slug} mcpServers is not an array`).toBe(true);
    }
  });

  it('every role has qdrant in mcpServers (universal memory access)', () => {
    const roles = loadRoles();
    for (const role of roles) {
      expect(role.mcpServers, `role ${role.slug} missing mcpServers`).toContain('qdrant');
    }
  });

  it('every role has snapshot in mcpServers (universal default per T3.1 audit)', () => {
    const roles = loadRoles();
    for (const role of roles) {
      expect(role.mcpServers, `role ${role.slug} missing snapshot`).toContain('snapshot');
    }
  });

  it('every role has the model-neutral DevFlow gateway', () => {
    const roles = loadRoles();
    for (const role of roles) {
      expect(role.mcpServers, `role ${role.slug} missing devflow-gateway`).toContain('devflow-gateway');
    }
  });

  // Sprint 44 — outlook added fleet-wide; the later GitHub fleet rollout adds
  // github to implementation roles while browser-dev intentionally remains
  // browser-scoped and does not carry Outlook.
  it('backend-dev has its required data, mail, and GitHub servers', () => {
    const role = bySlug(loadRoles(), 'backend-dev');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'claude_ai_Supabase', 'outlook', 'github', 'devflow-gateway']);
  });

  it('team-lead has qdrant + snapshot + claude_ai_Supabase + outlook', () => {
    const role = bySlug(loadRoles(), 'team-lead');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'claude_ai_Supabase', 'outlook', 'github', 'devflow-gateway']);
  });

  it('frontend-dev has its implementation and model-neutral design gateway', () => {
    const role = bySlug(loadRoles(), 'frontend-dev');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'outlook', 'github', 'devflow-gateway']);
  });

  it('researcher has qdrant + snapshot + outlook', () => {
    const role = bySlug(loadRoles(), 'researcher');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'outlook', 'github', 'devflow-gateway']);
  });

  it('architect has qdrant + snapshot + outlook', () => {
    const role = bySlug(loadRoles(), 'architect');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'outlook', 'github', 'devflow-gateway']);
  });

  it('designer has its review and model-neutral design gateway', () => {
    const role = bySlug(loadRoles(), 'designer');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'outlook', 'github', 'devflow-gateway']);
  });

  it('axiom has qdrant + snapshot + outlook', () => {
    const role = bySlug(loadRoles(), 'axiom');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'outlook', 'github', 'devflow-gateway']);
  });

  it('every mail-enabled role has outlook in mcpServers (Sprint 44 fleet enablement)', () => {
    const scopeOnlyRoles = new Set(['browser-dev', 'pathfinder', 'resolver']);
    const roles = loadRoles().filter(role => !scopeOnlyRoles.has(role.slug));
    for (const role of roles) {
      expect(role.mcpServers, `role ${role.slug} missing outlook`).toContain('outlook');
    }
  });

  it('operations role exists (Decision 5 Option A) with qdrant + snapshot + outlook + pdf-editor', () => {
    const role = bySlug(loadRoles(), 'operations');
    expect(role).toBeDefined();
    expect(role!.mcpServers).toEqual(['qdrant', 'snapshot', 'outlook', 'pdf-editor', 'github', 'devflow-gateway']);
  });

  it('operations role has the expected id + name + mdPath', () => {
    const role = bySlug(loadRoles(), 'operations');
    expect(role).toBeDefined();
    expect(role!.name).toBe('Operations');
    expect(role!.slug).toBe('operations');
    expect(role!.mdPath).toBe('data/roles/operations.md');
    expect(typeof role!.id).toBe('string');
    expect(role!.id.length).toBeGreaterThan(0);
    expect(role!.createdAt).toBeDefined();
    expect(role!.updatedAt).toBeDefined();
  });

  it('operations.md file exists (placeholder role definition)', () => {
    const mdPath = resolve(process.cwd(), 'data/roles/operations.md');
    expect(existsSync(mdPath)).toBe(true);
  });

  it('no role has a duplicate slug', () => {
    const roles = loadRoles();
    const slugs = roles.map((r) => r.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });
});
