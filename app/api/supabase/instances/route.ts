/**
 * GET    /api/supabase/instances       — list all registered instances
 * POST   /api/supabase/instances       — upsert (create or update), test, test-connection, delete
 * PATCH  /api/supabase/instances       — partial update (id required)
 * DELETE /api/supabase/instances?id=<id> — delete an instance
 *
 * Uses requireAuthOrLocal so the DevFlow dashboard can call it without a
 * Bearer token (same as every other dashboard-facing supabase route).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { testConnection, testHostedInstance, invalidateClient } from '@/lib/supabase-client';
import { requireAuthOrLocal, successResponse, errorResponse } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import type { SupabaseInstanceType, UpsertSupabaseInstanceInput } from '@/lib/supabase-types';

export const dynamic = 'force-dynamic';

/** Validate a URL string — must be http(s) with a valid hostname */
function isValidUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** GET /api/supabase/instances */
export const GET = tracked('/api/supabase/instances', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const instances = await supabaseInstanceStore.listInstances();
    return successResponse({ instances });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to list instances',
      'INTERNAL_ERROR',
      500
    );
  }
});

/** POST /api/supabase/instances — upsert, test, test-connection, delete */
export const POST = tracked('/api/supabase/instances', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 'INVALID_FIELD', 400);
  }

  // ── Test connectivity for an existing instance (by ID) ─────────────────
  if (body.action === 'test' && typeof body.id === 'string') {
    const instance = await supabaseInstanceStore.getInstance(body.id);
    if (!instance) return errorResponse(`Instance not found: ${body.id}`, 'NOT_FOUND', 404);

    // Hosted instances with projectId: use Management API
    if (instance.type === 'hosted' && instance.connection.projectId) {
      const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
      if (accessToken) {
        const result = await testHostedInstance(instance.connection.projectId, accessToken);
        const status = result.ok ? 'online' : (result.status === 'INACTIVE' ? 'offline' : 'error');
        await supabaseInstanceStore.updateStatus(body.id, status);
        return successResponse({ ...result, instanceId: body.id });
      }
    }

    // Local instances or fallback: PostgREST with service role key
    const key = process.env[instance.connection.serviceRoleKeyEnvVar];
    if (!key) {
      await supabaseInstanceStore.updateStatus(body.id, 'error');
      return errorResponse(`Env var ${instance.connection.serviceRoleKeyEnvVar} not set`, 'INTERNAL_ERROR', 500);
    }
    const result = await testConnection(instance.connection.url, key);
    await supabaseInstanceStore.updateStatus(body.id, result.ok ? 'online' : 'error');
    return successResponse({ ...result, instanceId: body.id });
  }

  // ── Test connectivity with raw fields (pre-save, no instance ID) ───────
  if (body.action === 'test-connection') {
    const url = body.url as string;
    const envVar = (body.serviceRoleKeyEnvVar as string) || 'SUPABASE_SECRET_KEY';
    if (!url) return errorResponse('url is required', 'INVALID_FIELD', 400);
    if (!isValidUrl(url)) return errorResponse('Invalid URL format', 'INVALID_FIELD', 400);
    const key = process.env[envVar];
    if (!key) return errorResponse(`Env var ${envVar} not set`, 'INTERNAL_ERROR', 500);
    const result = await testConnection(url, key);
    return successResponse(result);
  }

  // ── Delete via POST body (for clients that can't send DELETE) ──────────
  if (body.action === 'delete' && typeof body.id === 'string') {
    const instance = await supabaseInstanceStore.getInstance(body.id);
    if (instance) invalidateClient(instance.connection.url);
    await supabaseInstanceStore.deleteInstance(body.id);
    return successResponse({ deleted: body.id });
  }

  // ── Upsert (create or update) ──────────────────────────────────────────
  const url = body.url as string;
  if (!url || !isValidUrl(url)) {
    return errorResponse('Valid url is required (http or https)', 'INVALID_FIELD', 400);
  }

  const input: UpsertSupabaseInstanceInput = {
    id: body.id as string | undefined,
    name: body.name as string,
    type: (body.type as SupabaseInstanceType) || 'hosted',
    connection: {
      url,
      anonKeyEnvVar: (body.anonKeyEnvVar as string) || 'SUPABASE_PUBLISHABLE_KEY',
      serviceRoleKeyEnvVar: (body.serviceRoleKeyEnvVar as string) || 'SUPABASE_SECRET_KEY',
      dbPasswordEnvVar: body.dbPasswordEnvVar as string | undefined,
      dbConnectionStringEnvVar: body.dbConnectionStringEnvVar as string | undefined,
      projectId: body.projectId as string | undefined,
    },
    linkedProjects: body.linkedProjects as string[] | undefined,
    notes: body.notes as string | undefined,
  };

  if (!input.name) {
    return errorResponse('name is required', 'INVALID_FIELD', 400);
  }

  try {
    const instance = await supabaseInstanceStore.upsertInstance(input);
    return successResponse({ instance });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to save instance',
      'INTERNAL_ERROR',
      500
    );
  }
});

/** PATCH /api/supabase/instances — partial update */
export const PATCH = tracked('/api/supabase/instances', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 'INVALID_FIELD', 400);
  }

  const id = body.id as string;
  if (!id) return errorResponse('id is required', 'INVALID_FIELD', 400);

  const existing = await supabaseInstanceStore.getInstance(id);
  if (!existing) return errorResponse(`Instance not found: ${id}`, 'NOT_FOUND', 404);

  // Validate URL if provided
  if (body.url !== undefined) {
    if (!isValidUrl(body.url as string)) {
      return errorResponse('Invalid URL format', 'INVALID_FIELD', 400);
    }
  }

  // Merge partial fields onto existing instance
  const merged: UpsertSupabaseInstanceInput = {
    id,
    name: (body.name as string) ?? existing.name,
    type: (body.type as SupabaseInstanceType) ?? existing.type,
    connection: {
      url: (body.url as string) ?? existing.connection.url,
      anonKeyEnvVar: (body.anonKeyEnvVar as string) ?? existing.connection.anonKeyEnvVar,
      serviceRoleKeyEnvVar: (body.serviceRoleKeyEnvVar as string) ?? existing.connection.serviceRoleKeyEnvVar,
      dbPasswordEnvVar: (body.dbPasswordEnvVar as string) ?? existing.connection.dbPasswordEnvVar,
      dbConnectionStringEnvVar: (body.dbConnectionStringEnvVar as string) ?? existing.connection.dbConnectionStringEnvVar,
      projectId: (body.projectId as string) ?? existing.connection.projectId,
    },
    linkedProjects: (body.linkedProjects as string[]) ?? existing.linkedProjects,
    notes: (body.notes as string) ?? existing.notes,
  };

  // Invalidate cached client if URL changed
  if (body.url && body.url !== existing.connection.url) {
    invalidateClient(existing.connection.url);
  }

  try {
    const instance = await supabaseInstanceStore.upsertInstance(merged);
    return successResponse({ instance });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to update instance',
      'INTERNAL_ERROR',
      500
    );
  }
});

/** DELETE /api/supabase/instances?id=<id> */
export const DELETE = tracked('/api/supabase/instances', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return errorResponse('id is required', 'INVALID_FIELD', 400);

  try {
    const instance = await supabaseInstanceStore.getInstance(id);
    if (instance) invalidateClient(instance.connection.url);
    await supabaseInstanceStore.deleteInstance(id);
    return successResponse({ deleted: id });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to delete instance',
      'INTERNAL_ERROR',
      500
    );
  }
});
