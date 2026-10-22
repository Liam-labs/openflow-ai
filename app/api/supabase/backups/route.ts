/**
 * GET /api/supabase/backups
 *
 * Returns backup history for a Supabase instance.
 * - Hosted: uses Supabase Management API (PITR + scheduled backups)
 * - Local: lists SQL dump files from .AppData/supabase-backups/
 *
 * POST /api/supabase/backups
 *
 * Hosted:
 *   { instanceId, action: 'restore', backupId } — restore from snapshot
 *   { instanceId, action: 'pitr', recovery_time_target_unix } — point-in-time restore
 * Local:
 *   { instanceId, action: 'dump' } — create a new SQL dump via supabase CLI
 *   { instanceId, action: 'restore', filename } — restore from a local dump file
 */

import { NextRequest, NextResponse } from 'next/server';
import { mkdir, readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import { isSafeBackupFilename, sanitizeBackupInstanceName } from '@/lib/supabase-backup-security';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import { DataPaths } from '@/lib/data-paths';
import type { SupabaseInstance } from '@/lib/supabase-types';
import {
  listRunningSupabaseContainers,
  resolveKnownLocalSupabaseProjects,
  scanLocalSupabaseBackups,
} from '@/lib/supabase-local-backups';
import {
  getActiveCustomRestore,
  getCustomRestoreStatus,
  initiateCustomRestore,
} from '@/lib/supabase-custom-restore';

const MGMT_BASE = 'https://api.supabase.com/v1';
const BACKUPS_DIR = path.join(DataPaths.appData, 'supabase-backups');

function getAccessToken(): string {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN env var is not set');
  return token;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
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

// ─── Hosted helpers ─────────────────────────────────────────────────────────

async function mgmtGet(apiPath: string, token: string): Promise<unknown> {
  const resp = await fetchWithTimeout(`${MGMT_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
  }, 30_000);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(
      new Error(`Supabase Management API error (${resp.status}): ${text}`),
      { statusCode: resp.status }
    );
  }
  return resp.json();
}

async function mgmtPost(apiPath: string, token: string, body: unknown): Promise<unknown> {
  const resp = await fetchWithTimeout(`${MGMT_BASE}${apiPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  }, 30_000);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(
      new Error(`Supabase Management API error (${resp.status}): ${text}`),
      { statusCode: resp.status }
    );
  }
  const contentType = resp.headers.get('content-type') ?? '';
  if (resp.status === 204 || !contentType.includes('application/json')) {
    return { ok: true };
  }
  return resp.json();
}

// ─── Local backup helpers ───────────────────────────────────────────────────

async function ensureBackupsDir(): Promise<void> {
  await mkdir(BACKUPS_DIR, { recursive: true });
}

async function listLocalBackups(instanceName: string): Promise<Array<{
  filename: string;
  sizeMb: number;
  createdAt: string;
}>> {
  await ensureBackupsDir();
  const prefix = sanitizeName(instanceName).toLowerCase();
  const files = await readdir(BACKUPS_DIR);
  // Case-insensitive match + require '-' separator to avoid 'seo' matching 'seoengine-*'
  const sqlFiles = files.filter(f => f.toLowerCase().startsWith(prefix + '-') && f.endsWith('.sql'));

  const backups = await Promise.all(
    sqlFiles.map(async (filename) => {
      const filePath = path.join(BACKUPS_DIR, filename);
      const info = await stat(filePath);
      return {
        filename,
        sizeMb: parseFloat((info.size / 1048576).toFixed(2)),
        createdAt: info.mtime.toISOString(),
      };
    })
  );

  // Most recent first
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return backups;
}

// ─── GET handler ────────────────────────────────────────────────────────────

export const GET = tracked('/api/supabase/backups', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const { searchParams } = new URL(request.url);
    const instanceId = searchParams.get('instanceId');
    const scope = searchParams.get('scope');
    const action = searchParams.get('action');

    if (scope === 'inventory') {
      await ensureBackupsDir();
      const [dockerInventory, activeRestore, instances] = await Promise.all([
        listRunningSupabaseContainers(),
        getActiveCustomRestore(BACKUPS_DIR),
        supabaseInstanceStore.listInstances(),
      ]);
      const knownProjects = resolveKnownLocalSupabaseProjects(
        instances,
        dockerInventory.apiPortSlugs ?? new Map(),
      );
      const inventory = await scanLocalSupabaseBackups({
        backupsRoot: BACKUPS_DIR,
        runningContainers: dockerInventory.containers,
        knownProjects,
        dockerAvailable: dockerInventory.available,
      });
      return NextResponse.json({
        success: true,
        ...inventory,
        restore: { active: activeRestore },
        diagnostics: {
          docker: {
            available: dockerInventory.available,
            error: dockerInventory.error,
          },
        },
      });
    }

    if (action === 'restore-status') {
      const restoreId = searchParams.get('restoreId');
      if (!restoreId) {
        return NextResponse.json({ error: 'restoreId is required' }, { status: 400 });
      }
      const status = await getCustomRestoreStatus(BACKUPS_DIR, restoreId);
      if (!status) {
        return NextResponse.json({ error: 'Restore job not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, status });
    }

    const { instance, projectRef, resolvedInstanceId } = await resolveInstance(instanceId);

    // Local instance — list dump files
    if (instance?.type === 'local') {
      const backups = await listLocalBackups(instance.name);
      return NextResponse.json({
        instanceId: resolvedInstanceId,
        instanceType: 'local',
        pitr_enabled: false,
        backups,
      });
    }

    // Hosted instance — Management API
    if (!projectRef) {
      throw new Error(
        instance
          ? `Instance "${instance.name}" has no projectId`
          : 'No instanceId provided and SUPABASE_PROJECT_ID is not set'
      );
    }

    const token = getAccessToken();
    const data = await mgmtGet(`/projects/${projectRef}/database/backups`, token) as {
      pitr_enabled?: boolean;
      backups?: Array<{
        id: number;
        project_id?: string;
        status: string;
        inserted_at: string;
        updated_at: string;
        isPhysicalBackup?: boolean;
      }>;
    };

    return NextResponse.json({
      instanceId: resolvedInstanceId,
      instanceType: 'hosted',
      projectRef,
      pitr_enabled: data.pitr_enabled ?? false,
      backups: data.backups ?? [],
    });
  } catch (err) {
    console.error('[Supabase Backups GET]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Internal error',
        planLimited: statusCode === 403,
        notFound: statusCode === 404,
      },
      { status: statusCode }
    );
  }
});

// ─── POST handler ───────────────────────────────────────────────────────────

export const POST = tracked('/api/supabase/backups', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json() as {
      instanceId?: string;
      action?: string;
      backupId?: number;
      filename?: string;
      filenames?: string[];
      recovery_time_target_unix?: number;
      // S3.2 — restore-to-other: target instance for a cross-instance restore
      targetInstanceId?: string;
      sourceBackupFile?: string;
      confirmTargetName?: string;
      projectSlug?: string;
      confirmProjectSlug?: string;
    };

    const {
      instanceId, action, backupId, filename, filenames, recovery_time_target_unix,
      projectSlug, confirmProjectSlug,
    } = body;

    if (!action) {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    if (action === 'restore-custom') {
      if (!projectSlug || typeof projectSlug !== 'string') {
        return NextResponse.json({ error: 'projectSlug is required' }, { status: 400 });
      }
      if (!filename || typeof filename !== 'string') {
        return NextResponse.json({ error: 'filename is required' }, { status: 400 });
      }
      if (confirmProjectSlug !== projectSlug) {
        return NextResponse.json(
          {
            error: 'confirmProjectSlug must exactly match projectSlug',
            expected: projectSlug,
          },
          { status: 400 },
        );
      }
      const restore = await initiateCustomRestore({
        backupsRoot: BACKUPS_DIR,
        projectSlug,
        filename,
      });
      return NextResponse.json(
        { success: true, restoreId: restore.id },
        { status: 202 },
      );
    }

    const { instance, projectRef, resolvedInstanceId } = await resolveInstance(instanceId ?? null);

    // Local instance actions
    if (instance?.type === 'local') {
      if (action === 'dump' || action === 'restore' || action === 'restore-to-other') {
        const replacement = action === 'dump'
          ? 'custom-format scheduler backups'
          : 'restore-custom';
        return NextResponse.json(
          {
            error: action === 'dump'
              ? 'Legacy local SQL dumps are retired because they were schema-only'
              : 'Legacy synchronous SQL restores are retired',
            deprecated: true,
            replacement,
          },
          { status: 410 },
        );
      }

      if (action === 'delete') {
        if (!filenames || filenames.length === 0) {
          return NextResponse.json({ error: 'filenames array is required and must not be empty' }, { status: 400 });
        }
        // Strict filename validation — matches isSafeBackupFilename from download route
        const invalid = filenames.find(fn => !isSafeBackupFilename(fn));
        if (invalid) {
          return NextResponse.json({ error: `Invalid filename: ${invalid}` }, { status: 400 });
        }
        // Per-instance prefix check — caller may only delete files belonging to the requested instance
        const instancePrefix = sanitizeBackupInstanceName(instance.name).toLowerCase() + '-';
        const crossInstance = filenames.find(fn => !fn.toLowerCase().startsWith(instancePrefix));
        if (crossInstance) {
          return NextResponse.json(
            { error: `Filename does not belong to instance "${instance.name}": ${crossInstance}` },
            { status: 403 }
          );
        }
        const results = await Promise.allSettled(
          filenames.map(fn => unlink(path.join(BACKUPS_DIR, fn)))
        );
        const deleted = results.filter(r => r.status === 'fulfilled').length;
        return NextResponse.json({ success: true, deleted });
      }

      // PITR not available for local
      return NextResponse.json(
        { error: `Action "${action}" is not available for local instances. Use "restore-custom" or "delete".` },
        { status: 400 }
      );
    }

    // Hosted instance actions
    if (!projectRef) {
      throw new Error(
        instance
          ? `Instance "${instance.name}" has no projectId`
          : 'No instanceId provided and SUPABASE_PROJECT_ID is not set'
      );
    }

    const token = getAccessToken();

    if (action === 'restore') {
      if (!backupId) {
        return NextResponse.json({ error: 'backupId is required for restore' }, { status: 400 });
      }
      const result = await mgmtPost(
        `/projects/${projectRef}/database/backups/restore`,
        token,
        { backup_id: backupId }
      );
      return NextResponse.json({ instanceId: resolvedInstanceId, projectRef, ...result as object });
    }

    if (action === 'pitr') {
      if (!recovery_time_target_unix) {
        return NextResponse.json(
          { error: 'recovery_time_target_unix is required for PITR restore' },
          { status: 400 }
        );
      }
      const result = await mgmtPost(
        `/projects/${projectRef}/database/backups/restore`,
        token,
        { recovery_time_target_unix }
      );
      return NextResponse.json({ instanceId: resolvedInstanceId, projectRef, ...result as object });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error('[Supabase Backups POST]', err);
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: statusCode }
    );
  }
});
