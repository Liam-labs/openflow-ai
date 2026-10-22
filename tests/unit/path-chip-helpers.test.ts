/**
 * Unit tests for PathChip helper functions.
 * Sprint 37 P1-T2. TDD — RED first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDisplayName, isDirectoryPath, openInWindows } from '@/lib/path-chip-helpers';

// ─── getDisplayName ─────────────────────────────────────────────────────────

describe('getDisplayName', () => {
  it('extracts filename from an absolute path', () => {
    expect(getDisplayName('/home/user/DevFlow/lib/foo.ts')).toBe('foo.ts');
  });

  it('extracts directory name from a path ending in /', () => {
    expect(getDisplayName('/home/user/DevFlow/lib/')).toBe('lib');
  });

  it('extracts directory name from a path without extension', () => {
    expect(getDisplayName('/home/user/DevFlow/lib')).toBe('lib');
  });

  it('handles dotfiles', () => {
    expect(getDisplayName('/home/user/.claude/rules/startup.md')).toBe('startup.md');
  });

  it('handles root paths', () => {
    expect(getDisplayName('/home/user')).toBe('user');
  });

  it('handles path with spaces', () => {
    expect(getDisplayName('/mnt/c/Users/winuser/My Documents/report.pdf')).toBe('report.pdf');
  });
});

// ─── isDirectoryPath ────────────────────────────────────────────────────────

describe('isDirectoryPath', () => {
  it('returns true for path ending in /', () => {
    expect(isDirectoryPath('/home/user/DevFlow/lib/')).toBe(true);
  });

  it('returns true for path without any extension', () => {
    expect(isDirectoryPath('/home/user/DevFlow/lib')).toBe(true);
  });

  it('returns false for path with .ts extension', () => {
    expect(isDirectoryPath('/home/user/DevFlow/lib/foo.ts')).toBe(false);
  });

  it('returns false for path with .md extension', () => {
    expect(isDirectoryPath('/home/user/SG-1/README.md')).toBe(false);
  });

  it('returns false for dotfiles (they have a dot but no extension)', () => {
    // .claude is a directory, but .env is a file — heuristic: if last segment starts with dot
    // and has no further dot, treat as directory
    expect(isDirectoryPath('/home/user/.claude')).toBe(true);
  });

  it('returns false for .env files', () => {
    expect(isDirectoryPath('/home/user/.env')).toBe(false);
  });

  it('returns false for path with .json extension', () => {
    expect(isDirectoryPath('/home/user/DevFlow/package.json')).toBe(false);
  });

  it('returns true for deeply nested no-extension path', () => {
    expect(isDirectoryPath('/home/user/DevFlow/data/central-knowledge-base')).toBe(true);
  });
});

// ─── openInWindows ──────────────────────────────────────────────────────────

describe('openInWindows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends POST with path and open mode', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await openInWindows('/home/user/DevFlow/README.md', 'open');

    expect(mockFetch).toHaveBeenCalledWith('/api/open-in-windows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/home/user/DevFlow/README.md', mode: 'open' }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('sends POST with reveal mode', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await openInWindows('/home/user/DevFlow/lib/', 'reveal');

    expect(mockFetch).toHaveBeenCalledWith('/api/open-in-windows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/home/user/DevFlow/lib/', mode: 'reveal' }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns error message on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Path not in allowlist' }),
    }));

    const result = await openInWindows('/etc/shadow', 'open');
    expect(result).toEqual({ ok: false, error: 'Path not in allowlist' });
  });

  it('returns error message on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Path not found' }),
    }));

    const result = await openInWindows('/home/user/nonexistent.ts', 'open');
    expect(result).toEqual({ ok: false, error: 'Path not found' });
  });

  it('handles network failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await openInWindows('/home/user/DevFlow/README.md', 'open');
    expect(result).toEqual({ ok: false, error: 'Network error' });
  });
});
