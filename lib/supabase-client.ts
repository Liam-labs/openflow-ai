/**
 * Supabase Client Library for DevFlow
 *
 * Creates server-side Supabase clients using service role key.
 * Clients are cached per instance URL to avoid re-creation overhead.
 *
 * Usage:
 *   import { getSupabaseClient, getDefaultClient } from '@/lib/supabase-client';
 *
 *   // Default instance (from env vars)
 *   const supabase = getDefaultClient();
 *
 *   // Specific instance (from registry)
 *   const supabase = getSupabaseClient(url, serviceRoleKey);
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import { PRODUCT_NAME } from '@/lib/brand';

/** Cache of clients keyed by URL */
const clientCache = new Map<string, SupabaseClient>();

/**
 * Get or create a Supabase client for a given URL + service role key.
 * Clients are cached by URL — subsequent calls with the same URL return the cached client.
 */
export function getSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  const existing = clientCache.get(url);
  if (existing) return existing;

  const client = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: 'public',
    },
  });

  clientCache.set(url, client);
  return client;
}

/**
 * Get a client for the default Supabase instance (from env vars).
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY in environment.
 * Throws if env vars are missing.
 */
export function getDefaultClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables. ' +
      `Ensure ~/.secrets is sourced in the ${PRODUCT_NAME} ecosystem config.`
    );
  }

  return getSupabaseClient(url, key);
}

/**
 * Get a client for a registered instance by resolving its env var references.
 * Used by the instance registry to create clients dynamically.
 */
export function getClientForInstance(
  url: string,
  serviceRoleKeyEnvVar: string
): SupabaseClient {
  const key = process.env[serviceRoleKeyEnvVar];
  if (!key) {
    throw new Error(
      `Environment variable ${serviceRoleKeyEnvVar} is not set. ` +
      'Check ~/.secrets and ecosystem.config.js.'
    );
  }
  return getSupabaseClient(url, key);
}

/**
 * Remove a cached client (e.g. when instance credentials change).
 */
export function invalidateClient(url: string): void {
  clientCache.delete(url);
}

/**
 * Clear all cached clients.
 */
export function clearClientCache(): void {
  clientCache.clear();
}

/**
 * Test connectivity to a Supabase instance via PostgREST.
 * Works for local instances where the service role key matches the URL.
 */
export async function testConnection(url: string, serviceRoleKey: string): Promise<{
  ok: boolean;
  error?: string;
  version?: string;
}> {
  try {
    const client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Simple query to check connectivity — list schemas via pg_catalog
    const { error } = await client
      .from('pg_catalog.pg_tables')
      .select('schemaname')
      .limit(1);

    if (error) {
      // pg_catalog might not be exposed via PostgREST, try a simpler check
      const resp = await fetchWithTimeout(`${url}/rest/v1/`, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      }, 10_000);

      if (resp.ok || resp.status === 200) {
        return { ok: true };
      }
      return { ok: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test a hosted Supabase instance via the Management API.
 * Uses SUPABASE_ACCESS_TOKEN to query project status — works for all projects
 * under the account regardless of per-project service role keys.
 *
 * Management API status values: ACTIVE_HEALTHY, INACTIVE, COMING_UP, etc.
 */
export async function testHostedInstance(projectRef: string, accessToken: string): Promise<{
  ok: boolean;
  status: string;
  error?: string;
}> {
  try {
    const resp = await fetchWithTimeout(
      `https://api.supabase.com/v1/projects/${projectRef}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      15_000
    );

    if (!resp.ok) {
      return { ok: false, status: 'error', error: `Management API ${resp.status}: ${resp.statusText}` };
    }

    const project = await resp.json() as { status: string; name?: string };
    const apiStatus = project.status || 'UNKNOWN';

    // Map Management API status to our status
    const isOnline = apiStatus === 'ACTIVE_HEALTHY';
    return {
      ok: isOnline,
      status: apiStatus,
      error: isOnline ? undefined : `Project status: ${apiStatus}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
