/**
 * Tests for POST / GET /api/settings/rebuild — Sprint 54 T1.
 *
 * The endpoint fires scripts/safe-build.sh as a DETACHED background process and
 * returns 200 immediately. safe-build.sh ends with a PM2 restart, so a
 * synchronous response would be killed before it could be delivered.
 *
 * Requirements verified here:
 *   - POST returns 200 {started: true} synchronously, without awaiting spawn
 *   - POST spawns bash with detached:true, stdio:'ignore' and unref()s the child
 *   - POST is guarded by requireAuthOrLocal(write) → 401 when denied
 *   - POST uses the same O_EXCL lock pattern as alpha-clone → 409 when locked
 *   - GET returns {inProgress, buildId} based on lock + .next/BUILD_ID
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';

// ── Per-suite tmpdir: the route resolves its lock file as
//    path.join(process.cwd(), '.AppData', 'rebuild.lock'). We cannot monkey-patch
//    process.cwd() per-test safely, so we instead drive it through a tmpdir
//    that we chdir into in beforeEach, and we point the route at that tmpdir.
//    Easiest approach: make the route expose a module-level dirs object and
//    mock it. vi.hoisted keeps the tmp dir stable across module imports.
const { appDataDir, buildIdPath, lockPath } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-route-'));
  const appData = path.join(root, '.AppData');
  fs.mkdirSync(appData, { recursive: true });
  const next = path.join(root, '.next');
  fs.mkdirSync(next, { recursive: true });
  return {
    appDataDir: appData,
    buildIdPath: path.join(next, 'BUILD_ID'),
    lockPath: path.join(appData, 'rebuild.lock'),
  };
});

// Mock auth — default allow; individual tests override to deny.
vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

// Passthrough tracking wrapper (same pattern as other route tests).
vi.mock('@/lib/api-tracking', () => ({
  tracked: (_p: string, handler: Function) => handler,
}));

// Mock node:child_process.spawn so we can assert on options/args without
// actually exec'ing safe-build.sh. Returning a fake process with unref().
const mockSpawn = vi.fn();
const mockUnref = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Expose our tmp paths to the route via a mocked helper. The route imports
// `getRebuildPaths()` from a colocated paths module so tests can redirect it.
vi.mock('@/app/api/settings/rebuild/paths', () => ({
  getRebuildPaths: () => ({
    appDataDir,
    lockPath,
    buildIdPath,
    scriptPath: '/tmp/fake-safe-build.sh',
  }),
}));

import { POST, GET } from '@/app/api/settings/rebuild/route';
import { requireAuthOrLocal } from '@/lib/api-auth';

function makePost(): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeGet(): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/rebuild', {
    method: 'GET',
  });
}

function clearState() {
  if (existsSync(lockPath)) rmSync(lockPath);
  if (existsSync(buildIdPath)) rmSync(buildIdPath);
}

beforeEach(() => {
  clearState();
  mockSpawn.mockReset();
  mockUnref.mockReset();
  mockSpawn.mockImplementation(() => ({ unref: mockUnref, pid: 9999 }));
  vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
});

afterEach(() => {
  clearState();
});

describe('POST /api/settings/rebuild', () => {
  it('returns 200 {started:true} immediately without awaiting the spawned script', async () => {
    const res = await POST(makePost());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ started: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Must have detached the child and called unref() — otherwise Node would
    // wait on the child and the PM2 restart at the end of safe-build.sh would
    // kill the API response before it could be flushed.
    const [, , opts] = mockSpawn.mock.calls[0];
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('spawns bash with the safe-build.sh script path', async () => {
    await POST(makePost());
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('bash');
    expect(Array.isArray(args)).toBe(true);
    expect(args[0]).toBe('/tmp/fake-safe-build.sh');
  });

  it('creates the O_EXCL lock file when starting a build', async () => {
    expect(existsSync(lockPath)).toBe(false);
    const res = await POST(makePost());
    expect(res.status).toBe(200);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('returns 409 when a rebuild is already in progress (lock exists)', async () => {
    // Pre-create the lock file to simulate an in-flight build.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1234, startedAt: new Date().toISOString() }),
    );

    const res = await POST(makePost());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/in progress|already/i);
    // Must NOT spawn a second build.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns 401 when requireAuthOrLocal denies the request', async () => {
    vi.mocked(requireAuthOrLocal).mockResolvedValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const res = await POST(makePost());
    expect(res.status).toBe(401);
    expect(mockSpawn).not.toHaveBeenCalled();
    // No lock file should be created when auth fails.
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('GET /api/settings/rebuild', () => {
  it('returns {inProgress:false, buildId:null} when no lock and no BUILD_ID', async () => {
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ inProgress: false, buildId: null });
  });

  it('returns {inProgress:true} when the lock file exists', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 4242 }));
    const res = await GET(makeGet());
    const body = await res.json();
    expect(body.inProgress).toBe(true);
  });

  it('returns buildId from .next/BUILD_ID when present', async () => {
    writeFileSync(buildIdPath, 'abc123xyz');
    const res = await GET(makeGet());
    const body = await res.json();
    expect(body.buildId).toBe('abc123xyz');
  });

  it('GET does not require write auth (read-only status)', async () => {
    // Auth is allowed by default; we just assert no 401 when mock is permissive.
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
  });
});
