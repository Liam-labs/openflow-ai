/**
 * JsonSupabaseInstanceStore — JSON-file-backed implementation of SupabaseInstanceStore.
 *
 * Source of truth: .AppData/supabase-instances.json
 * Uses flock/readJsonFile/writeJsonFile pattern (same as catalog, projects).
 */

import path from 'path';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, access } from 'fs/promises';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import type {
  SupabaseInstanceStore,
  SupabaseInstance,
  SupabaseInstancesFile,
  SupabaseInstanceStatus,
  UpsertSupabaseInstanceInput,
} from './supabase-types';

const STORE_VERSION = '1.0.0';

const INSTANCES_PATH = path.join(DataPaths.appData, 'supabase-instances.json');

const DEFAULT_FILE: SupabaseInstancesFile = {
  version: STORE_VERSION,
  instances: [],
};

async function readStore(): Promise<SupabaseInstancesFile> {
  return readJsonFile<SupabaseInstancesFile>(INSTANCES_PATH, DEFAULT_FILE);
}

async function writeStore(data: SupabaseInstancesFile): Promise<void> {
  await writeJsonFile(INSTANCES_PATH, data);
}

class JsonSupabaseInstanceStore implements SupabaseInstanceStore {
  async listInstances(): Promise<SupabaseInstance[]> {
    const data = await readStore();
    return data.instances;
  }

  async getInstance(id: string): Promise<SupabaseInstance | null> {
    const data = await readStore();
    return data.instances.find((i) => i.id === id) ?? null;
  }

  async upsertInstance(input: UpsertSupabaseInstanceInput): Promise<SupabaseInstance> {
    return withFileLock(INSTANCES_PATH, async () => {
      const data = await readStore();
      const now = new Date().toISOString();
      const existingIdx = input.id
        ? data.instances.findIndex((i) => i.id === input.id)
        : -1;

      if (existingIdx >= 0) {
        // Update existing
        const existing = data.instances[existingIdx];
        const updated: SupabaseInstance = {
          ...existing,
          name: input.name,
          type: input.type,
          connection: input.connection,
          linkedProjects: input.linkedProjects ?? existing.linkedProjects,
          notes: input.notes ?? existing.notes,
          containerRef: input.containerRef ?? existing.containerRef,
          portMap: input.portMap ?? existing.portMap,
          projectDirectory: input.projectDirectory ?? existing.projectDirectory,
          startCommand: input.startCommand ?? existing.startCommand,
          stopCommand: input.stopCommand ?? existing.stopCommand,
          updatedAt: now,
        };
        data.instances[existingIdx] = updated;
        await writeStore(data);
        return updated;
      }

      // Create new
      const instance: SupabaseInstance = {
        id: input.id || randomUUID(),
        name: input.name,
        type: input.type,
        connection: input.connection,
        linkedProjects: input.linkedProjects ?? [],
        status: 'unknown',
        lastCheckedAt: null,
        createdAt: now,
        updatedAt: now,
        notes: input.notes,
        containerRef: input.containerRef,
        portMap: input.portMap,
        projectDirectory: input.projectDirectory,
        startCommand: input.startCommand,
        stopCommand: input.stopCommand,
      };
      data.instances.push(instance);
      await writeStore(data);

      // Auto-provision safety scripts for new local instances
      if (instance.type === 'local' && instance.projectDirectory) {
        provisionLocalSafety(instance).catch(err =>
          console.error('[SupabaseStore] Auto-provision failed (non-fatal):', err)
        );
      }

      return instance;
    });
  }

  async deleteInstance(id: string): Promise<void> {
    return withFileLock(INSTANCES_PATH, async () => {
      const data = await readStore();
      const idx = data.instances.findIndex((i) => i.id === id);
      if (idx < 0) {
        throw Object.assign(new Error(`Instance not found: ${id}`), { statusCode: 404 });
      }
      data.instances.splice(idx, 1);
      await writeStore(data);
    });
  }

  async updateStatus(id: string, status: SupabaseInstanceStatus): Promise<void> {
    return withFileLock(INSTANCES_PATH, async () => {
      const data = await readStore();
      const instance = data.instances.find((i) => i.id === id);
      if (!instance) {
        throw Object.assign(new Error(`Instance not found: ${id}`), { statusCode: 404 });
      }
      instance.status = status;
      instance.lastCheckedAt = new Date().toISOString();
      instance.updatedAt = new Date().toISOString();
      await writeStore(data);
    });
  }

  async linkProject(instanceId: string, projectId: string): Promise<void> {
    return withFileLock(INSTANCES_PATH, async () => {
      const data = await readStore();
      const instance = data.instances.find((i) => i.id === instanceId);
      if (!instance) {
        throw Object.assign(new Error(`Instance not found: ${instanceId}`), { statusCode: 404 });
      }
      if (!instance.linkedProjects.includes(projectId)) {
        instance.linkedProjects.push(projectId);
        instance.updatedAt = new Date().toISOString();
        await writeStore(data);
      }
    });
  }

  async unlinkProject(instanceId: string, projectId: string): Promise<void> {
    return withFileLock(INSTANCES_PATH, async () => {
      const data = await readStore();
      const instance = data.instances.find((i) => i.id === instanceId);
      if (!instance) {
        throw Object.assign(new Error(`Instance not found: ${instanceId}`), { statusCode: 404 });
      }
      instance.linkedProjects = instance.linkedProjects.filter((p) => p !== projectId);
      instance.updatedAt = new Date().toISOString();
      await writeStore(data);
    });
  }
}

/**
 * Auto-provision safety scripts for a new local Supabase instance.
 * Generates supabase-safe-reset.sh in the project's scripts/ directory.
 * Non-fatal — errors are logged but don't block instance creation.
 */
async function provisionLocalSafety(instance: SupabaseInstance): Promise<void> {
  if (!instance.projectDirectory) return;

  const scriptsDir = path.join(instance.projectDirectory, 'scripts');
  const scriptPath = path.join(scriptsDir, 'supabase-safe-reset.sh');

  // Don't overwrite if already exists
  try {
    await access(scriptPath);
    return; // already provisioned
  } catch { /* file doesn't exist — create it */ }

  await mkdir(scriptsDir, { recursive: true });

  const projectName = path.basename(instance.projectDirectory);
  const containerRef = instance.containerRef || '';
  const sbEnv = containerRef ? `SUPABASE_PROJECT_ID=${containerRef} ` : '';

  const script = `#!/usr/bin/env bash
# supabase-safe-reset.sh — Auto-generated by DevFlow on local instance registration.
# Safe wrapper for supabase db reset. Auto-backs up, shows row counts, requires RESET confirmation.
# Usage: bash scripts/supabase-safe-reset.sh

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="\${PROJECT_DIR}/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PROJECT_NAME="${projectName}"
SB_PROJECT_ID="${containerRef}"

if [[ -n "$SB_PROJECT_ID" ]]; then
  export SUPABASE_PROJECT_ID="$SB_PROJECT_ID"
fi

# Find DB container
DB_CONTAINER=""
for name in $(docker ps --format '{{.Names}}' 2>/dev/null | grep 'supabase_db_' || true); do
  if [[ -n "$SB_PROJECT_ID" && "$name" == *"$SB_PROJECT_ID"* ]]; then
    DB_CONTAINER="$name"
    break
  fi
done
if [[ -z "$DB_CONTAINER" ]]; then
  DB_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep 'supabase_db_' | head -1 || true)
fi
if [[ -z "$DB_CONTAINER" ]]; then
  echo "ERROR: Cannot find Supabase DB container. Is Supabase running?"
  echo "Try: ${sbEnv}supabase start"
  exit 1
fi

echo "============================================"
echo "  \${PROJECT_NAME} — Safe Database Reset"
echo "============================================"
echo ""
echo "DB container: \${DB_CONTAINER}"
echo ""
echo "Current database contents (public schema):"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tAc "
  SELECT '  ' || tablename || ': ' ||
    (xpath('/row/cnt/text()',
      query_to_xml(format('SELECT count(*) AS cnt FROM public.%I', tablename), false, true, ''))
    )[1]::text
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
" 2>/dev/null || echo "  (Could not query row counts)"
echo ""

mkdir -p "$BACKUP_DIR"
BACKUP_FILE="\${BACKUP_DIR}/\${PROJECT_NAME}-pre-reset-\${TIMESTAMP}.sql"

echo "Taking automatic backup..."
docker exec "$DB_CONTAINER" pg_dump -U postgres --no-owner --no-acl postgres > "$BACKUP_FILE" 2>/dev/null
BACKUP_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
echo "Backup saved: \${BACKUP_FILE} (\${BACKUP_SIZE})"
echo ""
echo "WARNING: supabase db reset will DESTROY all data"
echo "and re-run migrations from scratch."
echo "Scraped/imported data NOT in migrations will be PERMANENTLY LOST."
echo ""

read -p "Type 'RESET' to confirm database wipe: " CONFIRM
if [[ "$CONFIRM" != "RESET" ]]; then
  echo "Aborted. Database unchanged."
  exit 1
fi

echo ""
echo "Running supabase db reset..."
cd "$PROJECT_DIR"
supabase db reset

echo ""
echo "Reset complete. To restore from backup:"
echo "  docker exec -i \${DB_CONTAINER} psql -U postgres postgres < \${BACKUP_FILE}"
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  console.log(`[SupabaseStore] Provisioned safe-reset script: ${scriptPath}`);
}

/** Singleton store instance */
export const supabaseInstanceStore = new JsonSupabaseInstanceStore();
