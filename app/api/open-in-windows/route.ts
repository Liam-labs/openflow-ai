import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { openInWindows } from '@/lib/open-in-windows';
import { canonicalizeExistingPath } from '@/lib/path-linker-validate';
import { writeAuditEntry } from '@/lib/path-linker-audit';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appPath } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

const VALID_MODES = ['open', 'reveal'] as const;
const AUDIT_LOG = appPath('event-logs', 'path-linker.jsonl');

export const POST = tracked('/api/open-in-windows', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body — path is required' },
      { status: 400 },
    );
  }

  // Validate path
  const { path, mode: rawMode } = body;
  if (path !== undefined && typeof path !== 'string') {
    return NextResponse.json(
      { error: 'path must be a string' },
      { status: 400 },
    );
  }
  if (!path) {
    return NextResponse.json(
      { error: 'path is required' },
      { status: 400 },
    );
  }

  // Validate mode
  const mode = (rawMode ?? 'open') as string;
  if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
    return NextResponse.json(
      { error: `Invalid mode "${mode}" — must be one of: ${VALID_MODES.join(', ')}` },
      { status: 400 },
    );
  }

  // Canonicalize before any spawn: resolves .. and symlinks and confirms the
  // path exists. Any existing path may be shown in Explorer (no allowlist).
  let validation = await canonicalizeExistingPath(path as string);
  let effectivePath = path as string;

  // Fallback 1: strip one project-dir component and retry under HOME.
  // Handles paths like ~/<project>/DevFlow/data/... where the file
  // actually lives at ~/DevFlow/data/... (agent wrote a path relative
  // to home but the chip resolver joined it against the channel project root).
  if (!validation.allowed && validation.reason === 'not found') {
    const homeDir = getHomeDir();
    const prefix = homeDir + '/';
    if (effectivePath.startsWith(prefix)) {
      const afterHome = effectivePath.slice(prefix.length);
      const slashIdx = afterHome.indexOf('/');
      if (slashIdx > 0) {
        const fallbackPath = prefix + afterHome.slice(slashIdx + 1);
        const fallbackValidation = await canonicalizeExistingPath(fallbackPath);
        if (fallbackValidation.allowed) {
          validation = fallbackValidation;
          effectivePath = fallbackPath;
        }
      }
    }
  }

  // Fallback 2: search by filename within the parent directory tree, then
  // widen progressively. Handles files that exist but in a subdirectory not
  // mentioned in the path (e.g. searching for foo.md at project root when it
  // lives in .MD Files/foo.md) AND files mentioned by bare name in one
  // project's channel that actually live in a sibling project root (e.g.
  // `sync.py` mentioned in SG-1 channel but living under DevFlow/).
  if (!validation.allowed && validation.reason === 'not found') {
    const fileName = basename(effectivePath);
    if (fileName) {
      const homeDir = getHomeDir();
      const searchRoots = [
        dirname(effectivePath),  // 1st: the originally-resolved directory
        homeDir,                  // 2nd: widen to HOME (catches sibling projects)
      ].filter((r, i, arr) => r.startsWith('/home/') && arr.indexOf(r) === i);

      outer: for (const searchDir of searchRoots) {
        try {
          const { stdout } = await execFileAsync('find', [
            searchDir,
            '-name', fileName,
            '-maxdepth', '9',
            '-not', '-path', '*/node_modules/*',
            '-not', '-path', '*/.git/*',
            '-not', '-path', '*/.next/*',
            '-not', '-path', '*/.AppData/*',
          ], { timeout: 8000 });
          const candidates = stdout.trim().split('\n').filter(Boolean);
          for (const candidate of candidates) {
            const candidateValidation = await canonicalizeExistingPath(candidate);
            if (candidateValidation.allowed) {
              validation = candidateValidation;
              effectivePath = candidate;
              break outer;
            }
          }
        } catch {
          // find failed or timed out — try the next searchRoot
        }
      }
    }
  }

  await writeAuditEntry(AUDIT_LOG, {
    path: effectivePath,
    decision: validation.allowed
      ? 'allowed'
      : `denied:${validation.reason ?? 'unknown'}`,
  });
  if (!validation.allowed) {
    return NextResponse.json(
      { error: `Path not allowed: ${validation.reason ?? 'access denied'}` },
      { status: 403 },
    );
  }

  try {
    const result = await openInWindows({
      path: validation.canonicalPath ?? effectivePath,
      mode: mode as 'open' | 'reveal',
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? 'Unknown error' },
        { status: result.statusCode ?? 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
});
