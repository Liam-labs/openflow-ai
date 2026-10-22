/**
 * GET /api/supabase/overview
 *
 * Returns aggregated overview data for a Supabase instance:
 * - Database size (MB)
 * - Total auth users
 * - Service health (REST, Auth, Realtime, Storage)
 * - API requests today + hourly history (zeros if no log source)
 * - Errors today (zeros if no log source)
 *
 * Query params:
 *   instanceId — registry instance ID (required)
 *
 * Response: { success: true, data: OverviewData }
 */

import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import type { SupabaseInstance } from '@/lib/supabase-types';

const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const MGMT_BASE = 'https://api.supabase.com/v1';
const HEALTH_TIMEOUT_MS = 5_000;

// Pool cache keyed by connection string
const pgPools = new Map<string, Pool>();

function getPgPool(connStr: string): Pool {
  if (!pgPools.has(connStr)) {
    pgPools.set(connStr, new Pool({ connectionString: connStr, max: 3 }));
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

interface ServiceHealth {
  name: string;
  status: 'up' | 'degraded' | 'down' | 'unknown';
  latencyMs: number;
}

interface OverviewData {
  dbSizeMb: number;
  apiRequestsToday: number;
  usersTotal: number;
  errorsToday: number;
  apiRequestsHistory: number[];
  services: ServiceHealth[];
}

/** Check a single service endpoint health */
async function checkServiceHealth(
  name: string,
  url: string,
  headers: Record<string, string>
): Promise<ServiceHealth> {
  const t0 = Date.now();
  try {
    const resp = await fetchWithTimeout(url, { headers }, HEALTH_TIMEOUT_MS);
    const latencyMs = Date.now() - t0;
    const status = resp.ok ? 'up' : 'degraded';
    return { name, status, latencyMs };
  } catch {
    return { name, status: 'down', latencyMs: Date.now() - t0 };
  }
}

/** Check all 4 Supabase services */
async function checkServices(
  baseUrl: string,
  serviceRoleKey: string
): Promise<ServiceHealth[]> {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  const checks = await Promise.all([
    checkServiceHealth('REST', `${baseUrl}/rest/v1/`, headers),
    checkServiceHealth('Auth', `${baseUrl}/auth/v1/health`, headers),
    checkServiceHealth('Realtime', `${baseUrl}/realtime/v1/`, headers),
    checkServiceHealth('Storage', `${baseUrl}/storage/v1/bucket`, headers),
  ]);

  return checks;
}

/** Get DB size and user count via local Postgres */
async function getLocalStats(connStr: string): Promise<{ dbSizeMb: number; usersTotal: number }> {
  const pool = getPgPool(connStr);
  const client = await pool.connect();
  try {
    const sizeResult = await client.query<{ size_mb: number }>(
      `SELECT round(pg_database_size(current_database()) / 1048576.0, 1) AS size_mb`
    );
    const dbSizeMb = parseFloat(String(sizeResult.rows[0]?.size_mb ?? 0));

    let usersTotal = 0;
    try {
      const usersResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM auth.users`
      );
      usersTotal = parseInt(usersResult.rows[0]?.count ?? '0', 10);
    } catch {
      // auth.users may not exist in all setups
    }

    return { dbSizeMb, usersTotal };
  } finally {
    client.release();
  }
}

/** Get DB size and user count via Management API */
async function getHostedStats(
  projectRef: string,
  token: string
): Promise<{ dbSizeMb: number; usersTotal: number }> {
  let dbSizeMb = 0;
  let usersTotal = 0;

  try {
    const resp = await fetchWithTimeout(
      `${MGMT_BASE}/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `SELECT round(pg_database_size(current_database()) / 1048576.0, 1) AS size_mb`,
        }),
        cache: 'no-store',
      },
      15_000
    );
    if (resp.ok) {
      const rows = (await resp.json()) as { size_mb: number }[];
      dbSizeMb = parseFloat(String(rows[0]?.size_mb ?? 0));
    }
  } catch { /* non-fatal */ }

  try {
    const resp = await fetchWithTimeout(
      `${MGMT_BASE}/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `SELECT count(*)::text AS count FROM auth.users` }),
        cache: 'no-store',
      },
      15_000
    );
    if (resp.ok) {
      const rows = (await resp.json()) as { count: string }[];
      usersTotal = parseInt(rows[0]?.count ?? '0', 10);
    }
  } catch { /* non-fatal */ }

  return { dbSizeMb, usersTotal };
}

export const GET = tracked('/api/supabase/overview', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = new URL(request.url);
    const instanceId = searchParams.get('instanceId');

    if (!instanceId) {
      return NextResponse.json(
        { success: false, error: 'instanceId query parameter is required' },
        { status: 400 }
      );
    }

    const instance = await supabaseInstanceStore.getInstance(instanceId);
    if (!instance) {
      return NextResponse.json(
        { success: false, error: `Instance not found: ${instanceId}` },
        { status: 404 }
      );
    }

    // Resolve service role key for health checks
    const serviceRoleKey = process.env[instance.connection.serviceRoleKeyEnvVar] ?? '';

    // Gather stats + health in parallel
    let dbSizeMb = 0;
    let usersTotal = 0;

    if (instance.type === 'local') {
      const connStr = getLocalConnStr(instance);
      const stats = await getLocalStats(connStr);
      dbSizeMb = stats.dbSizeMb;
      usersTotal = stats.usersTotal;
    } else {
      const projectRef = instance.connection.projectId;
      if (projectRef) {
        const token = getAccessToken();
        const stats = await getHostedStats(projectRef, token);
        dbSizeMb = stats.dbSizeMb;
        usersTotal = stats.usersTotal;
      }
    }

    const services = await checkServices(instance.connection.url, serviceRoleKey);

    // No log source available — return sensible defaults
    const apiRequestsToday = 0;
    const errorsToday = 0;
    const apiRequestsHistory = new Array(24).fill(0);

    const data: OverviewData = {
      dbSizeMb,
      apiRequestsToday,
      usersTotal,
      errorsToday,
      apiRequestsHistory,
      services,
    };

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[Supabase Overview GET]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});
