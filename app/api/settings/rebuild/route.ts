/**
 * POST /api/settings/rebuild — fire scripts/safe-build.sh in a detached
 * background process and return 200 immediately.
 *
 * The script ends with a PM2 restart, which would kill any synchronous HTTP
 * response still being held open. We spawn with {detached:true, stdio:'ignore'}
 * and call unref() so the child runs independently and the API can flush its
 * 200 response before PM2 tears the server down.
 *
 * GET returns {inProgress, buildId} so the UI can poll the current state —
 * `inProgress` is driven by .AppData/rebuild.lock (O_EXCL), `buildId` by
 * .next/BUILD_ID. Lock is released by the detached script itself via a
 * shell trap added in Sprint 54 T3 (separate task). For T1 we only create
 * the lock; the script owns cleanup.
 */
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { getRebuildPaths } from './paths';

export const dynamic = 'force-dynamic';

async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    const lockData = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(lockData);
    await handle.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function isLocked(lockPath: string): Promise<boolean> {
  try {
    await fs.access(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function readBuildId(buildIdPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(buildIdPath, 'utf-8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export const GET = tracked('/api/settings/rebuild', async (_request: NextRequest) => {
  const denied = await requireAuthOrLocal(_request, 'read');
  if (denied) return denied;

  const { lockPath, buildIdPath } = getRebuildPaths();
  const [inProgress, buildId] = await Promise.all([
    isLocked(lockPath),
    readBuildId(buildIdPath),
  ]);
  return NextResponse.json({ inProgress, buildId });
});

export const POST = tracked('/api/settings/rebuild', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  const { appDataDir, lockPath, scriptPath } = getRebuildPaths();
  // Ensure .AppData exists so O_EXCL open doesn't fail with ENOENT.
  await fs.mkdir(appDataDir, { recursive: true }).catch(() => {});

  const acquired = await acquireLock(lockPath);
  if (!acquired) {
    return NextResponse.json(
      { success: false, error: 'A rebuild is already in progress' },
      { status: 409 },
    );
  }

  // Detached + stdio:'ignore' + unref() so the parent (Node server) no longer
  // tracks this child. Without unref() the Next.js process would keep a
  // reference and the eventual PM2 restart inside safe-build.sh would kill
  // our response mid-flight.
  const child = spawn('bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return NextResponse.json({ started: true });
});
