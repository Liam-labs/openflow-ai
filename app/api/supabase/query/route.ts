/**
 * POST /api/supabase/query
 *
 * Execute arbitrary SQL against a Supabase instance.
 * - Hosted instances: uses Supabase Management API
 * - Local instances: uses direct Postgres connection via `pg`
 *
 * Results are capped at 1000 rows.
 *
 * Body:
 *   instanceId   — registry instance ID (optional; uses SUPABASE_PROJECT_ID if omitted)
 *   sql          — SQL statement to execute
 *
 * Response:
 *   rows         — array of result objects
 *   columns      — ordered column names (derived from first row)
 *   rowCount     — number of rows returned
 *   truncated    — true if result was capped at 1000 rows
 *   timing       — execution time in milliseconds
 */

import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import type { SupabaseInstance } from '@/lib/supabase-types';

const MGMT_BASE = 'https://api.supabase.com/v1';
const ROW_LIMIT = 1000;
const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/**
 * Substitute $1, $2, … positional parameters into a SQL string for the hosted
 * Management API path (which does not support parameterized queries natively).
 * Values are quoted using standard Postgres escaping.
 */
function formatParams(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (match, idx) => {
    const val = params[parseInt(idx, 10) - 1];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

// Pool cache keyed by connection string — avoids recreating pools per request
const pgPools = new Map<string, Pool>();

function getPgPool(connStr: string): Pool {
  if (!pgPools.has(connStr)) {
    pgPools.set(connStr, new Pool({ connectionString: connStr, max: 5 }));
  }
  return pgPools.get(connStr)!;
}

function getLocalConnStr(instance: SupabaseInstance): string {
  const envVar = instance.connection.dbConnectionStringEnvVar;
  if (envVar) {
    const val = process.env[envVar];
    if (val) return val;
  }
  return DEFAULT_LOCAL_DB_URL;
}

function getAccessToken(): string {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN env var is not set');
  return token;
}

async function resolveInstance(instanceId: string | null): Promise<{
  instance: SupabaseInstance | null;
  projectRef: string | null;
  resolvedInstanceId: string | null;
}> {
  if (instanceId) {
    const instance = await supabaseInstanceStore.getInstance(instanceId);
    if (!instance) {
      throw Object.assign(new Error(`Instance not found: ${instanceId}`), { statusCode: 404 });
    }
    return {
      instance,
      projectRef: instance.connection.projectId ?? null,
      resolvedInstanceId: instance.id,
    };
  }
  // No instanceId — fall back to env var (assumes hosted)
  const projectRef = process.env.SUPABASE_PROJECT_ID ?? null;
  return { instance: null, projectRef, resolvedInstanceId: null };
}

export const POST = tracked('/api/supabase/query', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json() as { instanceId?: string; sql?: string; params?: unknown[] };
    const { instanceId = null, sql, params } = body;

    if (!sql || typeof sql !== 'string' || !sql.trim()) {
      return NextResponse.json({ success: false, error: 'sql is required' }, { status: 400 });
    }

    const { instance, projectRef, resolvedInstanceId } = await resolveInstance(instanceId);

    const t0 = Date.now();

    // Local instance — direct Postgres connection
    if (instance?.type === 'local') {
      const connStr = getLocalConnStr(instance);
      const pool = getPgPool(connStr);
      const client = await pool.connect();
      let rows: unknown[];
      try {
        const result = await client.query(sql.trim(), params ?? []);
        rows = result.rows;
      } catch (pgErr) {
        // Surface Postgres errors as 400 (user/SQL error)
        return NextResponse.json(
          { success: false, error: pgErr instanceof Error ? pgErr.message : 'Query failed' },
          { status: 400 }
        );
      } finally {
        client.release();
      }

      const timing = Date.now() - t0;
      const truncated = rows.length > ROW_LIMIT;
      const trimmedRows = truncated ? rows.slice(0, ROW_LIMIT) : rows;
      const columns = trimmedRows.length > 0 ? Object.keys(trimmedRows[0] as Record<string, unknown>) : [];

      return NextResponse.json({
        success: true,
        instanceId: resolvedInstanceId,
        projectRef: null,
        rows: trimmedRows,
        columns,
        rowCount: trimmedRows.length,
        truncated,
        timing,
      });
    }

    // Hosted instance — Management API
    if (!projectRef) {
      throw new Error(
        instance
          ? `Instance "${instance.name}" has no projectId — update the registry entry with the Supabase project ref`
          : 'No instanceId provided and SUPABASE_PROJECT_ID is not set'
      );
    }

    const token = getAccessToken();
    // Management API doesn't support positional parameters — format them into the SQL safely
    const finalSql = params && params.length > 0 ? formatParams(sql.trim(), params) : sql.trim();
    const resp = await fetchWithTimeout(
      `${MGMT_BASE}/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: finalSql }),
        cache: 'no-store',
      },
      30_000
    );
    const timing = Date.now() - t0;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const status = resp.status === 400 ? 400 : 502;
      return NextResponse.json(
        { success: false, error: `Query failed (${resp.status}): ${text}` },
        { status }
      );
    }

    const raw = (await resp.json()) as unknown[];
    const truncated = raw.length > ROW_LIMIT;
    const rows = truncated ? raw.slice(0, ROW_LIMIT) : raw;
    const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];

    return NextResponse.json({
      success: true,
      instanceId: resolvedInstanceId,
      projectRef,
      rows,
      columns,
      rowCount: rows.length,
      truncated,
      timing,
    });
  } catch (err) {
    console.error('[Supabase Query POST]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});
