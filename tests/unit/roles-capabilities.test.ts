/**
 * T2.2 TDD — capabilities field on AgentRole
 *
 * Verifies:
 *   1. AgentRole type accepts capabilities[] (TS compile-time)
 *   2. The retired Browser Dev role is not reintroduced by stale fixtures
 *   3. roles.list preserves the optional capabilities field
 *   4. roles.get works for current roles without inventing capabilities
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import path from 'path';
import type { AgentRole, AgentApiRequest, AgentAuthContext } from '@/lib/types';

// Static import — roles.ts reads real roles.json from disk
import { list, get } from '@/app/api/agent/actions/roles';

const mockAuth: AgentAuthContext = {
  tokenId: 'test-token',
  tokenName: 'test',
  scope: 'write',
  createdBy: 'test',
  requestId: 'test-rid',
};

// ─── Type-level compile check ─────────────────────────────────────────────────

// If this compiles, capabilities is accepted by AgentRole
const _typeCheck: AgentRole = {
  id: 'x',
  name: 'X',
  slug: 'x',
  mdPath: 'data/roles/x.md',
  capabilities: ['browser', 'web'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
void _typeCheck;

// ─── roles.json integration tests ─────────────────────────────────────────────

describe('roles capabilities field', () => {
  describe('roles.json — current registry', () => {
    it('does not reintroduce the retired Browser Dev role', async () => {
      const raw = await readFile(
        path.join(process.cwd(), 'data', 'roles', 'roles.json'),
        'utf-8'
      );
      const { roles } = JSON.parse(raw) as { roles: AgentRole[] };
      expect(roles.some(r => r.slug === 'browser-dev')).toBe(false);
    });

    it('other roles do not have capabilities (clean baseline)', async () => {
      const raw = await readFile(
        path.join(process.cwd(), 'data', 'roles', 'roles.json'),
        'utf-8'
      );
      const { roles } = JSON.parse(raw) as { roles: AgentRole[] };
      const withCaps = roles.filter(r => r.capabilities !== undefined);
      expect(withCaps).toEqual([]);
    });
  });

  describe('roles.list API', () => {
    it('returns every current role without adding capabilities', async () => {
      const result = await list({} as unknown as AgentApiRequest, mockAuth);
      expect(result.roles.length).toBeGreaterThan(0);
      expect(result.roles.every(r => r.capabilities === undefined)).toBe(true);
    });

    it('returns undefined capabilities on roles without the field', async () => {
      const result = await list({} as unknown as AgentApiRequest, mockAuth);
      const backendDev = result.roles.find(r => r.slug === 'backend-dev');
      expect(backendDev).toBeDefined();
      expect(backendDev!.capabilities).toBeUndefined();
    });
  });

  describe('roles.get API', () => {
    it('returns undefined capabilities when fetching a current role by id', async () => {
      const result = await get(
        { roleId: '42ebd7dd-fa24-4ede-82a4-323c547cb3e9' } as unknown as AgentApiRequest,
        mockAuth
      );
      expect(result.role.capabilities).toBeUndefined();
    });

    it('returns undefined capabilities when fetching a current role by slug', async () => {
      const result = await get(
        { slug: 'backend-dev' } as unknown as AgentApiRequest,
        mockAuth
      );
      expect(result.role.capabilities).toBeUndefined();
    });

    it('returns undefined capabilities for roles without the field', async () => {
      const result = await get(
        { slug: 'backend-dev' } as unknown as AgentApiRequest,
        mockAuth
      );
      expect(result.role.capabilities).toBeUndefined();
    });
  });
});
