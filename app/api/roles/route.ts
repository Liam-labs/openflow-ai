/**
 * Roles API
 *
 * POST /api/roles — actions: list, get, create, update, delete
 * GET  /api/roles — list all roles
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AgentRole } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';

const ROLES_JSON = appPath('data', 'roles', 'roles.json');
const ROLES_DIR = appPath('data', 'roles');

/**
 * Resolve a role's .md path and verify it stays within ROLES_DIR.
 * Prevents path traversal if slug in storage was tampered with.
 */
function resolveRoleMdPath(slug: string): string | null {
  const resolved = path.resolve(ROLES_DIR, `${slug}.md`);
  if (!resolved.startsWith(ROLES_DIR + path.sep)) return null;
  return resolved;
}

interface RolesData {
  roles: AgentRole[];
}

async function readRolesData(): Promise<RolesData> {
  try {
    const raw = await fs.readFile(ROLES_JSON, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { roles: [] };
  }
}

async function writeRolesData(data: RolesData): Promise<void> {
  await withFileLock(ROLES_JSON, async () => {
    await fs.writeFile(ROLES_JSON, JSON.stringify(data, null, 2), 'utf-8');
  });
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateDefaultMd(name: string): string {
  return `# ${name}

You are assigned the role of **${name}**.

## Responsibilities

- [Define key responsibilities for this role]

## Guidelines

- [Add role-specific guidelines, coding standards, or behavioral instructions]

## Tools & Patterns

- [List any preferred tools, frameworks, or patterns for this role]
`;
}

export const GET = tracked('/api/roles', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const data = await readRolesData();
    return NextResponse.json({ success: true, data: { roles: data.roles } }, { headers: { 'Cache-Control': 'public, max-age=60' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});

export const POST = tracked('/api/roles', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'list': {
        const data = await readRolesData();
        return NextResponse.json({ success: true, data: { roles: data.roles } });
      }

      case 'get': {
        if (!body.roleId) {
          return NextResponse.json({ success: false, error: 'roleId is required' }, { status: 400 });
        }
        const data = await readRolesData();
        const role = data.roles.find(r => r.id === body.roleId);
        if (!role) {
          return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
        }
        // Also read the .md content
        let mdContent = '';
        const getMdPath = resolveRoleMdPath(role.slug);
        if (getMdPath) {
          try {
            mdContent = await fs.readFile(getMdPath, 'utf-8');
          } catch { /* file may not exist yet */ }
        }
        return NextResponse.json({ success: true, data: { role, mdContent } });
      }

      case 'create': {
        if (!body.name) {
          return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
        }
        const data = await readRolesData();
        const slug = toSlug(body.name);

        // Check for duplicate slug
        if (data.roles.some(r => r.slug === slug)) {
          return NextResponse.json({ success: false, error: `Role "${body.name}" already exists` }, { status: 409 });
        }

        const now = new Date().toISOString();
        const mdPath = `data/roles/${slug}.md`;
        const role: AgentRole = {
          id: randomUUID(),
          name: body.name,
          slug,
          description: body.description || '',
          mdPath,
          createdAt: now,
          updatedAt: now,
        };

        // Write the .md file
        const mdContent = body.mdContent || generateDefaultMd(body.name);
        const createMdPath = resolveRoleMdPath(slug);
        if (!createMdPath) {
          return NextResponse.json({ success: false, error: 'Invalid role name' }, { status: 400 });
        }
        await fs.writeFile(createMdPath, mdContent, 'utf-8');

        data.roles.push(role);
        await writeRolesData(data);

        return NextResponse.json({ success: true, data: { role } });
      }

      case 'update': {
        if (!body.roleId) {
          return NextResponse.json({ success: false, error: 'roleId is required' }, { status: 400 });
        }
        const data = await readRolesData();
        const role = data.roles.find(r => r.id === body.roleId);
        if (!role) {
          return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
        }

        // Update name (and slug/filename if name changed)
        if (body.name && body.name !== role.name) {
          const oldSlug = role.slug;
          const newSlug = toSlug(body.name);
          if (data.roles.some(r => r.slug === newSlug && r.id !== role.id)) {
            return NextResponse.json({ success: false, error: `Role "${body.name}" already exists` }, { status: 409 });
          }
          // Rename .md file — guard both old and new paths
          const oldMdPath = resolveRoleMdPath(oldSlug);
          const newMdPath = resolveRoleMdPath(newSlug);
          if (!newMdPath) {
            return NextResponse.json({ success: false, error: 'Invalid role name' }, { status: 400 });
          }
          if (oldMdPath) {
            try {
              await fs.rename(oldMdPath, newMdPath);
            } catch { /* old file may not exist */ }
          }
          role.name = body.name;
          role.slug = newSlug;
          role.mdPath = `data/roles/${newSlug}.md`;
        }

        if (body.description !== undefined) role.description = body.description;

        // Update .md content if provided
        if (body.mdContent !== undefined) {
          const updateMdPath = resolveRoleMdPath(role.slug);
          if (!updateMdPath) {
            return NextResponse.json({ success: false, error: 'Invalid role slug' }, { status: 400 });
          }
          await fs.writeFile(updateMdPath, body.mdContent, 'utf-8');
        }

        role.updatedAt = new Date().toISOString();
        await writeRolesData(data);

        return NextResponse.json({ success: true, data: { role } });
      }

      case 'delete': {
        if (!body.roleId) {
          return NextResponse.json({ success: false, error: 'roleId is required' }, { status: 400 });
        }
        const data = await readRolesData();
        const idx = data.roles.findIndex(r => r.id === body.roleId);
        if (idx === -1) {
          return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
        }
        const role = data.roles[idx];

        // Prevent deletion of built-in roles
        if (role.builtIn) {
          return NextResponse.json({ success: false, error: 'Built-in roles cannot be deleted' }, { status: 403 });
        }

        // Delete .md file
        const deleteMdPath = resolveRoleMdPath(role.slug);
        if (deleteMdPath) {
          try {
            await fs.unlink(deleteMdPath);
          } catch { /* file may already be gone */ }
        }

        data.roles.splice(idx, 1);
        await writeRolesData(data);

        return NextResponse.json({ success: true, data: { message: 'Role deleted' } });
      }

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error('[Roles API] Error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});
