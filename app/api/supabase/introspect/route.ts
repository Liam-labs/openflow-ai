/**
 * GET /api/supabase/introspect
 *
 * Returns database structure for a Supabase instance.
 * Both hosted and local instances now use direct SQL queries against pg_catalog /
 * information_schema — hosted via the Management API /database/query endpoint,
 * local via direct pg connection.
 *
 * (The Management API /database/tables and /database/columns endpoints return 404
 * for many hosted projects; the query endpoint is more reliable.)
 *
 * Query params:
 *   instanceId   — registry instance ID (optional; uses SUPABASE_PROJECT_ID if omitted)
 *   schema       — schema(s) to introspect, comma-separated (default: public)
 *   type         — "tables" | "columns" | "indexes" | "schemas" (default: tables)
 *   tableId      — filter columns by table OID (only applies when type=columns)
 */

import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import type { SupabaseInstance } from '@/lib/supabase-types';

const MGMT_BASE = 'https://api.supabase.com/v1';
const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Regex for valid schema/identifier names (defense-in-depth before embedding in SQL) */
const SCHEMA_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Pool cache keyed by connection string
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

/** Validate schema names and reject any that could allow SQL injection */
function validateSchemas(schemas: string[]): string[] {
  for (const s of schemas) {
    if (!SCHEMA_NAME_RE.test(s)) {
      throw Object.assign(new Error(`Invalid schema name: ${s}`), { statusCode: 400 });
    }
  }
  return schemas;
}

/** Format a string array as a Postgres ARRAY literal (schemas must be pre-validated) */
function pgArrayLiteral(values: string[]): string {
  return `ARRAY[${values.map((v) => `'${v}'`).join(', ')}]`;
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
  const projectRef = process.env.SUPABASE_PROJECT_ID ?? null;
  return { instance: null, projectRef, resolvedInstanceId: null };
}

/** Execute SQL via the Management API /database/query endpoint */
async function mgmtRunQuery<T = unknown>(
  projectRef: string,
  token: string,
  sql: string
): Promise<T[]> {
  const resp = await fetchWithTimeout(
    `${MGMT_BASE}/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      cache: 'no-store',
    },
    30_000
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase Management API query error (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<T[]>;
}

/**
 * Introspect via local pg connection (parameterized queries).
 */
async function localIntrospect(
  connStr: string,
  type: string,
  schemas: string[],
  tableId: string | null
): Promise<Record<string, unknown>> {
  const pool = getPgPool(connStr);
  const client = await pool.connect();
  try {
    switch (type) {
      case 'schemas': {
        const result = await client.query<{ schema: string }>(
          `SELECT nspname AS schema
           FROM pg_namespace
           WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema'
           ORDER BY nspname`
        );
        return { schemas: result.rows.map((r) => r.schema) };
      }

      case 'columns': {
        const params: unknown[] = [schemas];
        let whereExtra = '';
        if (tableId) {
          params.push(parseInt(tableId, 10));
          whereExtra = ` AND c.oid::int = $2`;
        }
        const result = await client.query(
          `SELECT
             a.attnum AS id,
             n.nspname AS schema,
             c.oid::int AS table_id,
             c.relname AS table_name,
             a.attname AS name,
             a.attnum AS ordinal_position,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
             pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
             NOT a.attnotnull AS is_nullable,
             false AS is_identity,
             (a.attgenerated != '') AS is_generated,
             col_description(c.oid, a.attnum) AS comment
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
           WHERE a.attnum > 0
             AND NOT a.attisdropped
             AND c.relkind = 'r'
             AND n.nspname = ANY($1)${whereExtra}
           ORDER BY n.nspname, c.relname, a.attnum`,
          params
        );
        return { columns: result.rows };
      }

      case 'indexes': {
        const result = await client.query(
          `SELECT
             schemaname AS schema,
             tablename AS table_name,
             indexname AS name,
             indexdef AS definition
           FROM pg_indexes
           WHERE schemaname = ANY($1)
           ORDER BY schemaname, tablename, indexname`,
          [schemas]
        );
        return { indexes: result.rows };
      }

      case 'tables':
      default: {
        const result = await client.query(
          `SELECT
             c.oid::int AS id,
             n.nspname AS schema,
             c.relname AS name,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced,
             COALESCE(p.n_live_tup, 0)::int AS live_rows_estimate,
             COALESCE(p.n_dead_tup, 0)::int AS dead_rows_estimate,
             COALESCE(pg_relation_size(c.oid), 0)::int AS bytes,
             pg_size_pretty(COALESCE(pg_relation_size(c.oid), 0)) AS size,
             obj_description(c.oid, 'pg_class') AS comment
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_stat_user_tables p ON p.relid = c.oid
           WHERE c.relkind = 'r'
             AND n.nspname = ANY($1)
           ORDER BY n.nspname, c.relname`,
          [schemas]
        );
        return { tables: result.rows };
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Introspect via Management API /database/query endpoint (hosted instances).
 * Uses the same SQL as localIntrospect but with schemas embedded as a validated literal.
 */
async function hostedIntrospect(
  projectRef: string,
  token: string,
  type: string,
  schemas: string[], // pre-validated
  tableId: string | null
): Promise<Record<string, unknown>> {
  const schemaArr = pgArrayLiteral(schemas);

  switch (type) {
    case 'schemas': {
      const rows = await mgmtRunQuery<{ schema: string }>(
        projectRef,
        token,
        `SELECT nspname AS schema
         FROM pg_namespace
         WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema'
         ORDER BY nspname`
      );
      return { schemas: rows.map((r) => r.schema) };
    }

    case 'columns': {
      const tableFilter =
        tableId && /^\d+$/.test(tableId) ? ` AND c.oid::int = ${tableId}` : '';
      const rows = await mgmtRunQuery(
        projectRef,
        token,
        `SELECT
           a.attnum AS id,
           n.nspname AS schema,
           c.oid::int AS table_id,
           c.relname AS table_name,
           a.attname AS name,
           a.attnum AS ordinal_position,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
           NOT a.attnotnull AS is_nullable,
           false AS is_identity,
           (a.attgenerated != '') AS is_generated,
           col_description(c.oid, a.attnum) AS comment
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
         WHERE a.attnum > 0
           AND NOT a.attisdropped
           AND c.relkind = 'r'
           AND n.nspname = ANY(${schemaArr})${tableFilter}
         ORDER BY n.nspname, c.relname, a.attnum`
      );
      return { columns: rows };
    }

    case 'indexes': {
      const rows = await mgmtRunQuery(
        projectRef,
        token,
        `SELECT
           schemaname AS schema,
           tablename AS table_name,
           indexname AS name,
           indexdef AS definition
         FROM pg_indexes
         WHERE schemaname = ANY(${schemaArr})
         ORDER BY schemaname, tablename, indexname`
      );
      return { indexes: rows };
    }

    case 'tables':
    default: {
      const rows = await mgmtRunQuery(
        projectRef,
        token,
        `SELECT
           c.oid::int AS id,
           n.nspname AS schema,
           c.relname AS name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           COALESCE(p.n_live_tup, 0)::int AS live_rows_estimate,
           COALESCE(p.n_dead_tup, 0)::int AS dead_rows_estimate,
           COALESCE(pg_relation_size(c.oid), 0)::int AS bytes,
           pg_size_pretty(COALESCE(pg_relation_size(c.oid), 0)) AS size,
           obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables p ON p.relid = c.oid
         WHERE c.relkind = 'r'
           AND n.nspname = ANY(${schemaArr})
         ORDER BY n.nspname, c.relname`
      );
      return { tables: rows };
    }
  }
}

export const GET = tracked('/api/supabase/introspect', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = new URL(request.url);
    const instanceId = searchParams.get('instanceId');
    const schema = searchParams.get('schema') || 'public';
    const type = searchParams.get('type') || 'tables';
    const tableId = searchParams.get('tableId');

    const { instance, projectRef, resolvedInstanceId } = await resolveInstance(instanceId);
    const schemas = validateSchemas(schema.split(',').map((s) => s.trim()).filter(Boolean));

    // Local instance — direct Postgres connection
    if (instance?.type === 'local') {
      const connStr = getLocalConnStr(instance);
      const payload = await localIntrospect(connStr, type, schemas, tableId);
      return NextResponse.json({
        instanceId: resolvedInstanceId,
        projectRef: null,
        schema,
        ...payload,
      });
    }

    // Hosted instance — SQL via Management API query endpoint
    if (!projectRef) {
      throw new Error(
        instance
          ? `Instance has no projectId — update the registry entry with the Supabase project ref`
          : 'No instanceId provided and SUPABASE_PROJECT_ID is not set'
      );
    }

    const token = getAccessToken();
    const payload = await hostedIntrospect(projectRef, token, type, schemas, tableId);

    return NextResponse.json({
      instanceId: resolvedInstanceId,
      projectRef,
      schema,
      ...payload,
    });
  } catch (err) {
    console.error('[Supabase Introspect GET]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});
