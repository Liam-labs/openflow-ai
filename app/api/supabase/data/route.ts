/**
 * GET  /api/supabase/data — Fetch rows with pagination
 * POST /api/supabase/data — Insert row(s)
 * PUT  /api/supabase/data — Update row(s) by primary key
 * DELETE /api/supabase/data — Delete row by primary key
 *
 * All operations use the Supabase JS client (service role key).
 *
 * GET params:
 *   instanceId   — registry instance ID (optional; falls back to env defaults)
 *   table        — table name (required)
 *   schema       — schema name (default: public)
 *   select       — comma-separated columns (default: *)
 *   page         — 0-based page number (default: 0)
 *   pageSize     — rows per page, max 100 (default: 50)
 *
 * POST/PUT/DELETE body:
 *   instanceId   — registry instance ID (optional)
 *   table        — table name (required)
 *   schema       — schema name (default: public)
 *
 * POST body also:
 *   rows         — array of row objects to insert (required)
 *
 * PUT body also:
 *   pkColumn     — primary key column name (required)
 *   pkValue      — primary key value to match (required)
 *   data         — object of fields to update (required)
 *
 * DELETE body also:
 *   pkColumn     — primary key column name (required)
 *   pkValue      — primary key value to match (required)
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { getClientForInstance, getDefaultClient } from '@/lib/supabase-client';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

async function resolveClient(instanceId: string | null): Promise<{
  client: SupabaseClient;
  instanceId: string | null;
}> {
  if (instanceId) {
    const instance = await supabaseInstanceStore.getInstance(instanceId);
    if (!instance) {
      throw Object.assign(new Error(`Instance not found: ${instanceId}`), { statusCode: 404 });
    }
    return {
      client: getClientForInstance(instance.connection.url, instance.connection.serviceRoleKeyEnvVar),
      instanceId: instance.id,
    };
  }
  return { client: getDefaultClient(), instanceId: null };
}

/** Validate table name — allow only alphanumeric, underscore, dot (for schema.table). */
function validateTableName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name);
}

/** Validate schema name */
function validateSchemaName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

// ---------------------------------------------------------------------------
// GET — fetch rows with pagination
// ---------------------------------------------------------------------------

export const GET = tracked('/api/supabase/data', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = request.nextUrl;
    const instanceId = searchParams.get('instanceId');
    const table = searchParams.get('table');
    const schema = searchParams.get('schema') || 'public';
    const select = searchParams.get('select') || '*';
    const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10)));

    if (!table) {
      return NextResponse.json({ success: false, error: 'table is required' }, { status: 400 });
    }
    if (!validateTableName(table)) {
      return NextResponse.json({ success: false, error: 'Invalid table name' }, { status: 400 });
    }
    if (!validateSchemaName(schema)) {
      return NextResponse.json({ success: false, error: 'Invalid schema name' }, { status: 400 });
    }

    const { client, instanceId: resolvedId } = await resolveClient(instanceId);

    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await client
      .schema(schema as 'public')
      .from(table)
      .select(select, { count: 'exact' })
      .range(from, to);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      instanceId: resolvedId,
      table,
      schema,
      rows: data ?? [],
      count: count ?? 0,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('[Supabase Data GET]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});

// ---------------------------------------------------------------------------
// POST — insert row(s)
// ---------------------------------------------------------------------------

export const POST = tracked('/api/supabase/data', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json() as {
      instanceId?: string;
      table?: string;
      schema?: string;
      rows?: Record<string, unknown>[];
    };

    const { instanceId = null, table, schema = 'public', rows } = body;

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ success: false, error: 'table is required' }, { status: 400 });
    }
    if (!validateTableName(table)) {
      return NextResponse.json({ success: false, error: 'Invalid table name' }, { status: 400 });
    }
    if (!validateSchemaName(schema)) {
      return NextResponse.json({ success: false, error: 'Invalid schema name' }, { status: 400 });
    }
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ success: false, error: 'rows array is required' }, { status: 400 });
    }

    const { client, instanceId: resolvedId } = await resolveClient(instanceId);

    const { data, error } = await client
      .schema(schema as 'public')
      .from(table)
      .insert(rows)
      .select();

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      instanceId: resolvedId,
      table,
      schema,
      rows: data ?? [],
    });
  } catch (err) {
    console.error('[Supabase Data POST]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});

// ---------------------------------------------------------------------------
// PUT — update row by primary key
// ---------------------------------------------------------------------------

export const PUT = tracked('/api/supabase/data', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json() as {
      instanceId?: string;
      table?: string;
      schema?: string;
      pkColumn?: string;
      pkValue?: unknown;
      data?: Record<string, unknown>;
    };

    const { instanceId = null, table, schema = 'public', pkColumn, pkValue, data: updateData } = body;

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ success: false, error: 'table is required' }, { status: 400 });
    }
    if (!validateTableName(table)) {
      return NextResponse.json({ success: false, error: 'Invalid table name' }, { status: 400 });
    }
    if (!validateSchemaName(schema)) {
      return NextResponse.json({ success: false, error: 'Invalid schema name' }, { status: 400 });
    }
    if (!pkColumn || typeof pkColumn !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pkColumn)) {
      return NextResponse.json({ success: false, error: 'pkColumn is required and must be a valid column name' }, { status: 400 });
    }
    if (pkValue === undefined || pkValue === null) {
      return NextResponse.json({ success: false, error: 'pkValue is required' }, { status: 400 });
    }
    if (!updateData || typeof updateData !== 'object' || Array.isArray(updateData)) {
      return NextResponse.json({ success: false, error: 'data object is required' }, { status: 400 });
    }

    const { client, instanceId: resolvedId } = await resolveClient(instanceId);

    const { data, error } = await client
      .schema(schema as 'public')
      .from(table)
      .update(updateData)
      .eq(pkColumn, pkValue as string)
      .select();

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      instanceId: resolvedId,
      table,
      schema,
      rows: data ?? [],
    });
  } catch (err) {
    console.error('[Supabase Data PUT]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});

// ---------------------------------------------------------------------------
// DELETE — delete row by primary key
// ---------------------------------------------------------------------------

export const DELETE = tracked('/api/supabase/data', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json() as {
      instanceId?: string;
      table?: string;
      schema?: string;
      pkColumn?: string;
      pkValue?: unknown;
    };

    const { instanceId = null, table, schema = 'public', pkColumn, pkValue } = body;

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ success: false, error: 'table is required' }, { status: 400 });
    }
    if (!validateTableName(table)) {
      return NextResponse.json({ success: false, error: 'Invalid table name' }, { status: 400 });
    }
    if (!validateSchemaName(schema)) {
      return NextResponse.json({ success: false, error: 'Invalid schema name' }, { status: 400 });
    }
    if (!pkColumn || typeof pkColumn !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pkColumn)) {
      return NextResponse.json({ success: false, error: 'pkColumn is required and must be a valid column name' }, { status: 400 });
    }
    if (pkValue === undefined || pkValue === null) {
      return NextResponse.json({ success: false, error: 'pkValue is required' }, { status: 400 });
    }

    const { client, instanceId: resolvedId } = await resolveClient(instanceId);

    const { error, count } = await client
      .schema(schema as 'public')
      .from(table)
      .delete({ count: 'exact' })
      .eq(pkColumn, pkValue as string);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      instanceId: resolvedId,
      table,
      schema,
      deleted: count ?? 0,
    });
  } catch (err) {
    console.error('[Supabase Data DELETE]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});
