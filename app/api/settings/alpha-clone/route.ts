/**
 * POST /api/settings/alpha-clone — Clone production DevFlow to a new versioned alpha
 * GET  /api/settings/alpha-clone — List existing alpha versions
 *
 * POST runs ~/DevFlow/scripts/clone-to-alpha.sh and returns the output.
 * npm install can take a couple of minutes so timeout is generous (5 min).
 */

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

export const dynamic = 'force-dynamic';

const SCRIPT_PATH = path.join(getHomeDir(), 'DevFlow/scripts/clone-to-alpha.sh');
const HOME = getHomeDir();
const APPDATA_DIR = appPath('.AppData');
const LOCK_FILE = path.join(APPDATA_DIR, 'alpha-clone.lock');
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Acquire a file-based lock for the clone operation.
 * Uses O_EXCL (exclusive create) which is atomic on POSIX filesystems.
 * Returns true if lock acquired, false if already locked.
 */
async function acquireLock(): Promise<boolean> {
  try {
    const lockData = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    // O_EXCL fails if file already exists — atomic check-and-set
    const handle = await fs.open(LOCK_FILE, 'wx');
    await handle.writeFile(lockData);
    await handle.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(LOCK_FILE);
  } catch {
    // Ignore — lock may already be gone
  }
}

async function isLocked(): Promise<boolean> {
  try {
    await fs.access(LOCK_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * GET — List existing alpha versions
 */
export const GET = tracked('/api/settings/alpha-clone', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const entries = await fs.readdir(HOME);
    const alphaVersions = await Promise.all(
      entries
        .filter(name => /^DevFlow_Alpha(_v\d+)?$/.test(name))
        .map(async name => {
          const fullPath = path.join(HOME, name);
          const stats = await fs.stat(fullPath);
          const versionMatch = name.match(/_v(\d+)$/);
          return {
            name,
            path: fullPath,
            version: versionMatch ? parseInt(versionMatch[1]) : 0,
            createdAt: stats.birthtime.toISOString(),
            modifiedAt: stats.mtime.toISOString(),
          };
        })
    );

    const sorted = alphaVersions.sort((a, b) => b.version - a.version);
    const latestVersion = sorted.length > 0 ? sorted[0].version : 0;
    const cloneInProgress = await isLocked();

    return NextResponse.json({
      success: true,
      versions: sorted,
      latestVersion,
      nextVersion: latestVersion + 1,
      cloneInProgress,
    });
  } catch (error) {
    console.error('[alpha-clone] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to list alpha versions' },
      { status: 500 }
    );
  }
});

/**
 * POST — Run the clone script
 */
export const POST = tracked('/api/settings/alpha-clone', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  const locked = await acquireLock();
  if (!locked) {
    return NextResponse.json(
      { success: false, error: 'A clone operation is already in progress' },
      { status: 409 }
    );
  }

  // Determine next version dir before running (for cleanup on failure)
  let targetDir: string | null = null;
  try {
    const entries = await fs.readdir(HOME);
    const versions = entries
      .filter(name => /^DevFlow_Alpha(_v\d+)?$/.test(name))
      .map(name => {
        const m = name.match(/_v(\d+)$/);
        return m ? parseInt(m[1]) : 0;
      });
    const next = versions.length > 0 ? Math.max(...versions) + 1 : 1;
    targetDir = path.join(HOME, `DevFlow_Alpha_v${next}`);
  } catch {
    // Best-effort — cleanup will also be best-effort
  }

  try {
    const result = await runCloneScript();

    if (result.exitCode !== 0 && targetDir) {
      // Clean up orphaned directory on failure
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }

    return NextResponse.json({
      success: result.exitCode === 0,
      output: result.stdout,
      errors: result.stderr,
      exitCode: result.exitCode,
    });
  } catch (error) {
    console.error('[alpha-clone] POST error:', error);
    if (targetDir) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }
    return NextResponse.json(
      { success: false, error: 'Clone script failed' },
      { status: 500 }
    );
  } finally {
    await releaseLock();
  }
});

function runCloneScript(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('bash', [SCRIPT_PATH], {
      env: { ...process.env, HOME },
      timeout: TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr: stderr + '\nTimed out after 5 minutes', exitCode: 124 });
    }, TIMEOUT_MS);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
