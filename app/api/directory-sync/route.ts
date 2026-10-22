/**
 * Directory Sync API
 *
 * Manages directory sync pairs — watch-based or periodic file synchronization
 * between source and destination directories.
 *
 * GET  /api/directory-sync                         — List all sync pairs + recent events
 * GET  /api/directory-sync?since=<iso-timestamp>    — Poll events since timestamp
 * POST /api/directory-sync                          — CRUD + run-now + dry-run
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { getSyncWatcher } from '@/lib/monitors/directory-sync';
import type {
  DirectorySyncPair,
  DirectorySyncData,
  DirectorySyncActionRequest,
  DirectorySyncActionResponse,
  DirectorySyncEventEntry,
} from '@/lib/types';

const DATA_PATH = DataPaths.directorySync;

const DEFAULT_DATA: DirectorySyncData = {
  pairs: [],
  lastUpdated: '',
};

// ============================================================================
// Path validation
// ============================================================================

/** Convert Windows UNC WSL paths to actual WSL paths.
 *  \\\\wsl.localhost\\Ubuntu\\home\\<user>\\foo → ~/foo
 *  \\\\wsl$\\Ubuntu\\home\\<user>\\foo → ~/foo
 */
function translateWslUnc(raw: string): string {
  const m = raw.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i);
  if (m) {
    return '/' + m[2].replace(/\\/g, '/');
  }
  return raw;
}

/** Convert Windows drive-letter paths to WSL /mnt/ paths.
 *  C:\\Users\\<windows-user>\\foo → /mnt/c/Users/<windows-user>/foo
 *  D:\\Projects\\bar  → /mnt/d/Projects/bar
 */
function translateWindowsPath(raw: string): string {
  const m = raw.match(/^([A-Z]):\\(.*)$/i);
  if (m) {
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }
  return raw;
}

/** Apply all path translations: Windows drive → /mnt/, UNC WSL → / */
function translatePath(raw: string): string {
  return translateWslUnc(translateWindowsPath(raw));
}

/** Reject traversals and non-existent paths. Set mustExist=false to allow
 *  destination paths that don't exist yet (will be created on first sync). */
async function validatePath(raw: string, mustExist = true): Promise<string> {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  // Translate all path formats before filesystem operations
  const translated = translatePath(raw);

  // Reject obvious traversal attempts before hitting the filesystem
  if (translated.includes('..')) {
    throw new Error('Path traversal not allowed');
  }

  try {
    const resolved = await fs.realpath(translated);
    // Double-check the resolved path doesn't contain .. after normalization
    if (resolved.includes('..')) {
      throw new Error('Path traversal detected in resolved path');
    }
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error('Path is not a directory');
    }
    return resolved;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Path')) {
      throw err; // Re-throw our own validation errors
    }
    // If destination doesn't exist yet, try to create it
    if (!mustExist && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await fs.mkdir(translated, { recursive: true });
        const resolved = await fs.realpath(translated);
        return resolved;
      } catch (mkErr) {
        throw new Error(`Cannot create destination directory: ${raw} → ${translated}`);
      }
    }
    throw new Error(`Path does not exist or is not accessible: ${raw}`);
  }
}

// ============================================
// GET — List pairs or poll events
// ============================================

export const GET = tracked('/api/directory-sync', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const { searchParams } = request.nextUrl;
  const since = searchParams.get('since');

  // Poll events since a timestamp
  if (since) {
    const watcher = getSyncWatcher();
    const events = watcher.getEventsSince(since);
    return NextResponse.json({ success: true, events });
  }

  const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);

  // Attach live status from the watcher for each pair
  const watcher = getSyncWatcher();
  const pairs = data.pairs.map(p => ({
    ...p,
    status: watcher.getPairStatus(p.id) ?? p.status,
  }));

  return NextResponse.json({
    success: true,
    pairs,
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// POST — CRUD + run-now + dry-run
// ============================================

export const POST = tracked('/api/directory-sync', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: DirectorySyncActionRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const { action } = body;

  switch (action) {
    case 'create':
      return handleCreate(body);
    case 'update':
      return handleUpdate(body);
    case 'delete':
      return handleDelete(body);
    case 'toggle':
      return handleToggle(body);
    case 'run-now':
      return handleRunNow(body);
    case 'dry-run':
      return handleDryRun(body);
    case 'events':
      return handleEvents(body);
    default:
      return NextResponse.json(
        { success: false, error: `Unknown action: ${action}` },
        { status: 400 }
      );
  }
});

// ============================================
// Action Handlers
// ============================================

async function handleCreate(
  body: DirectorySyncActionRequest
): Promise<NextResponse<DirectorySyncActionResponse>> {
  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
  }
  if (!body.sourcePath || !body.destPath) {
    return NextResponse.json({ success: false, error: 'sourcePath and destPath are required' }, { status: 400 });
  }

  // Validate paths exist
  let resolvedSource: string;
  let resolvedDest: string;
  try {
    resolvedSource = await validatePath(body.sourcePath, true);   // source must exist
    resolvedDest = await validatePath(body.destPath, false);      // dest can be created
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Invalid path' },
      { status: 400 }
    );
  }

  // Reject if source and dest resolve to the same directory
  if (resolvedSource === resolvedDest) {
    return NextResponse.json(
      { success: false, error: 'Source and destination must be different directories' },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const newPair: DirectorySyncPair = {
    id: randomUUID(),
    name: body.name,
    sourcePath: resolvedSource,
    destPath: resolvedDest,
    mode: body.mode === 'periodic' ? 'periodic' : 'watch',
    intervalMinutes: body.intervalMinutes && body.intervalMinutes >= 1 ? body.intervalMinutes : 15,
    enabled: body.enabled !== false,
    exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
    status: 'idle',
    lastSync: null,
    lastError: null,
    stats: { filesCopied: 0, filesDeleted: 0, bytesTransferred: 0, durationMs: 0 },
    createdAt: now,
    updatedAt: now,
  };

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
    data.pairs.push(newPair);
    data.lastUpdated = now;
    await writeJsonFile(DATA_PATH, data);
  });

  // Reload the watcher to pick up the new pair
  const watcher = getSyncWatcher();
  await watcher.reload();

  return NextResponse.json({ success: true, pair: newPair });
}

async function handleUpdate(
  body: DirectorySyncActionRequest
): Promise<NextResponse<DirectorySyncActionResponse>> {
  if (!body.id) {
    return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
  }

  let updatedPair: DirectorySyncPair | undefined;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
    const pair = data.pairs.find(p => p.id === body.id);
    if (!pair) return;

    if (body.name !== undefined && typeof body.name === 'string') pair.name = body.name;

    // Re-validate paths if they're being changed
    if (body.sourcePath !== undefined) {
      pair.sourcePath = await validatePath(body.sourcePath, true);   // source must exist
    }
    if (body.destPath !== undefined) {
      pair.destPath = await validatePath(body.destPath, false);      // dest can be created
    }

    // Reject if source and dest resolve to the same directory
    if (pair.sourcePath === pair.destPath) {
      throw new Error('Source and destination must be different directories');
    }

    if (body.mode !== undefined) pair.mode = body.mode;
    if (body.intervalMinutes !== undefined) {
      pair.intervalMinutes = Math.max(1, body.intervalMinutes);
    }
    if (body.enabled !== undefined) pair.enabled = body.enabled;
    if (body.exclusions !== undefined) pair.exclusions = body.exclusions;

    pair.updatedAt = new Date().toISOString();
    data.lastUpdated = pair.updatedAt;
    await writeJsonFile(DATA_PATH, data);
    updatedPair = pair;
  });

  if (!updatedPair) {
    return NextResponse.json({ success: false, error: 'Sync pair not found' }, { status: 404 });
  }

  // Reload the watcher with updated config
  const watcher = getSyncWatcher();
  await watcher.reload();

  return NextResponse.json({ success: true, pair: updatedPair });
}

async function handleDelete(
  body: DirectorySyncActionRequest
): Promise<NextResponse<DirectorySyncActionResponse>> {
  if (!body.id) {
    return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
  }

  let deleted = false;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
    const idx = data.pairs.findIndex(p => p.id === body.id);
    if (idx === -1) return;

    data.pairs.splice(idx, 1);
    data.lastUpdated = new Date().toISOString();
    await writeJsonFile(DATA_PATH, data);
    deleted = true;
  });

  if (!deleted) {
    return NextResponse.json({ success: false, error: 'Sync pair not found' }, { status: 404 });
  }

  // Reload the watcher to remove the pair
  const watcher = getSyncWatcher();
  await watcher.reload();

  return NextResponse.json({ success: true });
}

async function handleToggle(
  body: DirectorySyncActionRequest
): Promise<NextResponse<DirectorySyncActionResponse>> {
  if (!body.id) {
    return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
  }

  let toggledPair: DirectorySyncPair | undefined;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
    const pair = data.pairs.find(p => p.id === body.id);
    if (!pair) return;

    pair.enabled = !pair.enabled;
    pair.status = 'idle'; // Reset status on toggle
    pair.updatedAt = new Date().toISOString();
    data.lastUpdated = pair.updatedAt;
    await writeJsonFile(DATA_PATH, data);
    toggledPair = pair;
  });

  if (!toggledPair) {
    return NextResponse.json({ success: false, error: 'Sync pair not found' }, { status: 404 });
  }

  // Reload the watcher
  const watcher = getSyncWatcher();
  await watcher.reload();

  return NextResponse.json({ success: true, pair: toggledPair });
}

async function handleRunNow(
  body: DirectorySyncActionRequest
): Promise<NextResponse<DirectorySyncActionResponse>> {
  if (!body.id) {
    return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
  }

  const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
  const pair = data.pairs.find(p => p.id === body.id);
  if (!pair) {
    return NextResponse.json({ success: false, error: 'Sync pair not found' }, { status: 404 });
  }

  const watcher = getSyncWatcher();
  try {
    const stats = await watcher.runSyncNow(pair);
    return NextResponse.json({ success: true, pair: { ...pair, stats, lastSync: new Date().toISOString(), status: 'idle' } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 }
    );
  }
}

async function handleDryRun(
  body: DirectorySyncActionRequest
): Promise<NextResponse<DirectorySyncActionResponse>> {
  if (!body.id) {
    return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
  }

  const data = await readJsonFile<DirectorySyncData>(DATA_PATH, DEFAULT_DATA);
  const pair = data.pairs.find(p => p.id === body.id);
  if (!pair) {
    return NextResponse.json({ success: false, error: 'Sync pair not found' }, { status: 404 });
  }

  const watcher = getSyncWatcher();
  try {
    const result = await watcher.dryRun(pair);
    return NextResponse.json({ success: true, dryRunResult: result });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Dry run failed' },
      { status: 500 }
    );
  }
}

async function handleEvents(
  body: DirectorySyncActionRequest
): Promise<NextResponse<DirectorySyncActionResponse>> {
  const watcher = getSyncWatcher();
  const events = watcher.getEventsSince(body.since ?? new Date(0).toISOString());
  return NextResponse.json({ success: true, events });
}
