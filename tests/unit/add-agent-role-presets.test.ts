import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

interface RolePreset {
  name: string;
  slug: string;
  characterIds?: string[];
  defaultCharacterId?: string;
  recommendedModelId?: string;
}

const rolesPath = path.join(process.cwd(), 'data', 'roles', 'roles.json');
const roles = (JSON.parse(readFileSync(rolesPath, 'utf-8')) as { roles: RolePreset[] }).roles;

describe('role-first Add Agent presets', () => {
  it('exposes the canonical role-to-character choices', () => {
    const expected: Record<string, string[]> = {
      'team-lead': ['Jack', 'Weir'],
      'frontend-dev': ['Vala', 'Heimdall', 'Daniel'],
      'backend-dev': ['Builder', 'Zelenka'],
      architect: ['Architect'],
      researcher: ['Data', 'Beckett'],
      designer: ['Morpheus'],
      axiom: ['Tealc'],
      operations: ['Weir'],
      overseer: ['Weir'],
    };

    expect(Object.fromEntries(roles.map(role => [role.slug, role.characterIds]))).toEqual(expected);
  });

  it('keeps Operations with Weir and removes the unused Pathfinder and Resolver roles', () => {
    const operations = roles.find(role => role.slug === 'operations');
    expect(operations?.defaultCharacterId).toBe('Weir');
    expect(roles.some(role => role.slug === 'pathfinder')).toBe(false);
    expect(roles.some(role => role.slug === 'resolver')).toBe(false);
  });

  it('uses valid defaults and personality catalogue entries', () => {
    for (const role of roles) {
      expect(role.characterIds).toContain(role.defaultCharacterId);
      expect(role.recommendedModelId).toBeTruthy();
      for (const characterId of role.characterIds || []) {
        expect(existsSync(path.join(process.cwd(), 'data', 'roles', 'personalities', `${characterId}.md`))).toBe(true);
      }
    }
  });
});
