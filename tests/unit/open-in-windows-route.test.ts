/**
 * Tests for POST /api/open-in-windows
 *
 * P2-T1: Route skeleton — auth, body validation, error shapes.
 * P2-T4: Error paths — 400/403/404/500 with meaningful bodies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth — allow all requests by default
vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

// Mock api-tracking — passthrough
vi.mock('@/lib/api-tracking', () => ({
  tracked: (_path: string, handler: Function) => handler,
}));

// Mock the open-in-windows lib (wslpath + spawn)
const mockOpenInWindows = vi.fn();
vi.mock('@/lib/open-in-windows', () => ({
  openInWindows: (...args: unknown[]) => mockOpenInWindows(...args),
}));

// Mock canonicalizeExistingPath + writeAuditEntry.
// Default (set in beforeEach below): every path exists.
const mockCanonicalize = vi.fn();
vi.mock('@/lib/path-linker-validate', () => ({
  canonicalizeExistingPath: (...args: unknown[]) => mockCanonicalize(...args),
}));

const mockWriteAuditEntry = vi.fn();
vi.mock('@/lib/path-linker-audit', () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
  resetAuditForTest: vi.fn(),
}));

import { POST } from '@/app/api/open-in-windows/route';
import { requireAuthOrLocal } from '@/lib/api-auth';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/open-in-windows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Auth ────────────────────────────────────────────────────────────────

describe('POST /api/open-in-windows — auth', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
    mockOpenInWindows.mockReset();
  });

  it('calls requireAuthOrLocal with write permission', async () => {
    mockOpenInWindows.mockResolvedValue({ success: true });
    const req = makeRequest({ path: '/home/user/test.md' });
    await POST(req);
    expect(requireAuthOrLocal).toHaveBeenCalledWith(req, 'write');
  });

  it('returns auth denial when requireAuthOrLocal denies', async () => {
    const { NextResponse } = await import('next/server');
    const denial = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(requireAuthOrLocal).mockResolvedValue(denial);

    const res = await POST(makeRequest({ path: '/home/user/test.md' }));
    expect(res.status).toBe(401);
  });
});

// ─── Body validation ────────────────────────────────────────────────────

describe('POST /api/open-in-windows — body validation', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
    mockOpenInWindows.mockReset();
  });

  it('returns 400 when body is not JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/open-in-windows', {
      method: 'POST',
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid|missing|path/i);
  });

  it('returns 400 when path is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/path.*required/i);
  });

  it('returns 400 when path is empty string', async () => {
    const res = await POST(makeRequest({ path: '' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/path.*required/i);
  });

  it('returns 400 when path is not a string', async () => {
    const res = await POST(makeRequest({ path: 123 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/path.*string/i);
  });

  it('returns 400 when mode is invalid', async () => {
    const res = await POST(makeRequest({ path: '/home/user/test.md', mode: 'delete' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/mode/i);
  });

  it('accepts mode: open', async () => {
    mockOpenInWindows.mockResolvedValue({ success: true });
    const res = await POST(makeRequest({ path: '/home/user/test.md', mode: 'open' }));
    expect(res.status).toBe(200);
  });

  it('accepts mode: reveal', async () => {
    mockOpenInWindows.mockResolvedValue({ success: true });
    const res = await POST(makeRequest({ path: '/home/user/test.md', mode: 'reveal' }));
    expect(res.status).toBe(200);
  });

  it('defaults mode to open when not provided', async () => {
    mockOpenInWindows.mockResolvedValue({ success: true });
    await POST(makeRequest({ path: '/home/user/test.md' }));
    expect(mockOpenInWindows).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'open' }),
    );
  });
});

// ─── Success path ───────────────────────────────────────────────────────

describe('POST /api/open-in-windows — success', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
    mockOpenInWindows.mockReset();
  });

  it('returns 200 with success:true on valid request', async () => {
    mockOpenInWindows.mockResolvedValue({ success: true });
    const res = await POST(makeRequest({ path: '/home/user/test.md' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('passes path and mode to openInWindows', async () => {
    mockOpenInWindows.mockResolvedValue({ success: true });
    await POST(makeRequest({ path: '/home/user/docs/readme.md', mode: 'reveal' }));
    expect(mockOpenInWindows).toHaveBeenCalledWith({
      path: '/home/user/docs/readme.md',
      mode: 'reveal',
    });
  });
});

// ─── Error propagation ──────────────────────────────────────────────────

describe('POST /api/open-in-windows — error propagation', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
    mockOpenInWindows.mockReset();
  });

  it('returns 403 when openInWindows returns forbidden', async () => {
    mockOpenInWindows.mockResolvedValue({
      success: false,
      error: 'Path not in allowlist',
      statusCode: 403,
    });
    const res = await POST(makeRequest({ path: '/etc/passwd' }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Path not in allowlist');
  });

  it('returns 404 when openInWindows returns not-found', async () => {
    mockOpenInWindows.mockResolvedValue({
      success: false,
      error: 'Path does not exist',
      statusCode: 404,
    });
    const res = await POST(makeRequest({ path: '/home/user/nonexistent.md' }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Path does not exist');
  });

  it('returns 500 when openInWindows throws', async () => {
    mockOpenInWindows.mockRejectedValue(new Error('wslpath failed'));
    const res = await POST(makeRequest({ path: '/home/user/test.md' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/wslpath failed/i);
  });

  it('returns 500 when openInWindows returns generic failure', async () => {
    mockOpenInWindows.mockResolvedValue({
      success: false,
      error: 'Spawn failed',
      statusCode: 500,
    });
    const res = await POST(makeRequest({ path: '/home/user/test.md' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Spawn failed');
  });
});

// ─── Path gate: any existing absolute path may be shown in Explorer ────────
//
// Explorer only displays a location on the local desktop, so there is no
// allowlist; the route still canonicalizes (resolving .. and symlinks) and
// refuses missing or relative paths before anything is spawned.

beforeEach(() => {
  mockCanonicalize.mockReset();
  mockCanonicalize.mockImplementation(async (p: string) => ({
    allowed: true,
    canonicalPath: p,
    isDirectory: false,
  }));
  mockWriteAuditEntry.mockReset();
  mockWriteAuditEntry.mockResolvedValue(undefined);
});

describe('POST /api/open-in-windows — path gate', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
    mockOpenInWindows.mockReset();
    mockOpenInWindows.mockResolvedValue({ success: true });
  });

  it('opens the canonical target of a symlink into a Windows drive', async () => {
    mockCanonicalize.mockResolvedValue({
      allowed: true,
      canonicalPath: '/mnt/e/GameDev/Costa-Vida/README.md',
      isDirectory: false,
    });

    const res = await POST(makeRequest({ path: '/home/user/Games/Costa-Vida/README.md', mode: 'reveal' }));

    expect(res.status).toBe(200);
    expect(mockOpenInWindows).toHaveBeenCalledWith({
      path: '/mnt/e/GameDev/Costa-Vida/README.md',
      mode: 'reveal',
    });
  });

  it('returns 403 and does NOT spawn for an invalid path', async () => {
    mockCanonicalize.mockResolvedValue({ allowed: false, reason: 'invalid path' });

    const res = await POST(makeRequest({ path: 'relative/file.md' }));

    expect(res.status).toBe(403);
    expect(mockOpenInWindows).not.toHaveBeenCalled();
  });

  it('calls canonicalizeExistingPath with the exact request path', async () => {
    await POST(makeRequest({ path: '/home/user/project/file.ts' }));

    expect(mockCanonicalize).toHaveBeenCalledWith('/home/user/project/file.ts');
  });

  it('writes a deny audit entry when path is rejected', async () => {
    mockCanonicalize.mockResolvedValue({ allowed: false, reason: 'invalid path' });

    await POST(makeRequest({ path: 'etc/shadow' }));

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        path: 'etc/shadow',
        decision: expect.stringMatching(/^denied:/),
      })
    );
  });

  it('allows a valid path and reaches spawn', async () => {
    const res = await POST(makeRequest({ path: '/home/user/SG-1/README.md' }));

    expect(res.status).toBe(200);
    expect(mockOpenInWindows).toHaveBeenCalled();
  });
});
