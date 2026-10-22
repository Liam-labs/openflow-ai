/**
 * GET /api/supabase/migrations
 *
 * Returns migration status for a Supabase instance.
 * Queries supabase_migrations.schema_migrations via the Management API raw SQL endpoint.
 *
 * Applied migrations are stored in the DB. Pending count requires a local project path
 * containing supabase/migrations/*.sql files.
 *
 * Query params:
 *   instanceId   — registry instance ID (optional; uses SUPABASE_PROJECT_ID if omitted)
 *   projectPath  — absolute path to a local project with supabase/migrations/ (optional, for pending count)
 *   limit        — max migrations to return (default: 50)
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import { getHomeDir } from '@/lib/home-dir';

const MGMT_BASE = 'https://api.supabase.com/v1';

function getAccessToken(): string {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN env var is not set');
  return token;
}

async function resolveProjectRef(instanceId: string | null): Promise<{
  projectRef: string;
  instanceId: string | null;
}> {
  if (instanceId) {
    const instance = await supabaseInstanceStore.getInstance(instanceId);
    if (!instance) {
      throw Object.assign(new Error(`Instance not found: ${instanceId}`), { statusCode: 404 });
    }
    const projectRef = instance.connection.projectId;
    if (!projectRef) {
      throw new Error(
        `Instance "${instance.name}" has no projectId — update the registry entry with the Supabase project ref`
      );
    }
    return { projectRef, instanceId: instance.id };
  }
  const projectRef = process.env.SUPABASE_PROJECT_ID;
  if (!projectRef) {
    throw new Error('No instanceId provided and SUPABASE_PROJECT_ID is not set');
  }
  return { projectRef, instanceId: null };
}

/** Run raw SQL via the Supabase Management API database/query endpoint */
async function runQuery(
  projectRef: string,
  token: string,
  query: string
): Promise<unknown[]> {
  const resp = await fetchWithTimeout(`${MGMT_BASE}/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  }, 30_000);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase Management API query error (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<unknown[]>;
}

/**
 * Parse a Supabase migration version string (YYYYMMDDHHMMSS) into an ISO date.
 * Returns null if unparseable.
 */
function versionToDate(version: string): string | null {
  const match = version.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, min, sec] = match;
  return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
}

/**
 * Validate a user-supplied projectPath against path traversal and base-dir restrictions.
 * Returns the resolved absolute path if valid, throws 400 otherwise.
 */
async function validateProjectPath(rawPath: string): Promise<string> {
  if (rawPath.includes('..')) {
    throw Object.assign(new Error('Invalid projectPath: path traversal not allowed'), { statusCode: 400 });
  }
  const home = process.env.HOME ?? getHomeDir();
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    throw Object.assign(new Error('Invalid projectPath: must be within $HOME'), { statusCode: 400 });
  }
  // Verify it is actually a Supabase project directory
  const configPath = path.join(resolved, 'supabase', 'config.toml');
  try {
    await fs.access(configPath);
  } catch {
    throw Object.assign(
      new Error(`Invalid projectPath: supabase/config.toml not found`),
      { statusCode: 400 }
    );
  }
  return resolved;
}

/** Scan a local project's supabase/migrations/ directory for .sql filenames */
async function getLocalMigrationVersions(projectPath: string): Promise<string[]> {
  const migrationsDir = path.join(projectPath, 'supabase', 'migrations');
  try {
    const files = await fs.readdir(migrationsDir);
    return files
      .filter((f) => f.endsWith('.sql'))
      .map((f) => {
        // Filename format: <version>_<name>.sql or <version>.sql
        const base = f.replace(/\.sql$/, '');
        const versionMatch = base.match(/^(\d{14})/);
        return versionMatch ? versionMatch[1] : base;
      })
      .sort();
  } catch {
    return [];
  }
}

export const GET = tracked('/api/supabase/migrations', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = new URL(request.url);
    const instanceId = searchParams.get('instanceId');
    const projectPath = searchParams.get('projectPath');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);

    const token = getAccessToken();
    const { projectRef, instanceId: resolvedInstanceId } = await resolveProjectRef(instanceId);

    // Fetch applied migrations from the DB
    const rows = (await runQuery(
      projectRef,
      token,
      `SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT ${limit}`
    )) as Array<{ version: string; name: string | null }>;

    const applied = rows.length;

    // Derive last-applied date from the most recent version string
    const lastAppliedAt = rows[0] ? versionToDate(rows[0].version) : null;

    // Count pending by comparing local migration files vs applied versions
    let pending: number | null = null;
    if (projectPath) {
      const safePath = await validateProjectPath(projectPath);
      const localVersions = await getLocalMigrationVersions(safePath);
      const appliedVersionSet = new Set(rows.map((r) => r.version));
      pending = localVersions.filter((v) => !appliedVersionSet.has(v)).length;
    }

    return NextResponse.json({
      instanceId: resolvedInstanceId,
      projectRef,
      applied,
      pending,
      lastAppliedAt,
      migrations: rows.map((r) => ({
        version: r.version,
        name: r.name ?? null,
        appliedAt: versionToDate(r.version),
      })),
    });
  } catch (err) {
    console.error('[Supabase Migrations GET]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});
