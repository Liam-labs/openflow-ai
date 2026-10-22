/**
 * Roles Actions (Agent API)
 *
 * Provides programmatic access to agent roles.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { AgentApiRequest, AgentAuthContext, AgentRole } from '@/lib/types';
import { appPath } from '@/lib/app-paths';

const ROLES_JSON = appPath('data', 'roles', 'roles.json');

async function readRolesData(): Promise<{ roles: AgentRole[] }> {
  try {
    const raw = await fs.readFile(ROLES_JSON, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { roles: [] };
  }
}

/**
 * roles.list - List all available roles
 */
export async function list(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const data = await readRolesData();
  return { roles: data.roles, count: data.roles.length };
}

/**
 * roles.get - Get a specific role by ID or slug
 */
export async function get(body: AgentApiRequest, _auth: AgentAuthContext) {
  const roleId = body.roleId as string;
  const slug = body.slug as string;
  if (!roleId && !slug) throw new Error('roleId or slug is required');

  const data = await readRolesData();
  const role = data.roles.find(r =>
    (roleId && r.id === roleId) || (slug && r.slug === slug)
  );
  if (!role) throw new Error('Role not found');

  return { role };
}
