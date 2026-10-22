/**
 * T2.1.b — sweepStaleCollabFiles: Windows session files not swept when PID alive
 *
 * Verifies the platform-aware liveness check:
 *   - WSL session file for a dead /proc PID → deleted
 *   - Windows session file (platform='windows') for a live Windows PID → kept
 *   - Windows session file for a dead Windows PID → deleted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

const { mockReaddir, mockReadFile, mockUnlink, mockFsAccess, mockExec } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockUnlink: vi.fn(),
  mockFsAccess: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    promises: {
      ...real.promises,
      readdir: mockReaddir,
      readFile: mockReadFile,
      unlink: mockUnlink,
    },
  };
});

vi.mock('fs/promises', () => ({
  access: mockFsAccess,
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (fn: unknown) => {
      if (typeof fn === 'function' && fn.name === 'exec') return mockExec;
      return actual.promisify(fn as Parameters<typeof actual.promisify>[0]);
    },
  };
});

// ─── Import subject AFTER mocks ───────────────────────────────────────────────

const { sweepStaleCollabFiles } = await import('@/lib/collab-pty');

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('sweepStaleCollabFiles — platform-aware liveness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnlink.mockResolvedValue(undefined);
  });

  it('deletes a WSL session file when /proc PID does not exist', async () => {
    mockReaddir.mockResolvedValue(['collab-session-1111.json']);
    // Session JSON: no platform field → defaults to wsl
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 1111, name: 'Agent' }));
    // /proc/1111 does not exist → dead
    mockFsAccess.mockRejectedValue(new Error('ENOENT'));

    const cleaned = await sweepStaleCollabFiles();
    expect(cleaned).toBe(1);
    expect(mockUnlink).toHaveBeenCalledWith('/tmp/collab-session-1111.json');
  });

  it('keeps a Windows session file when tasklist.exe confirms PID is alive', async () => {
    mockReaddir.mockResolvedValue(['collab-session-5555.json']);
    // Session JSON: platform='windows'
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 5555, platform: 'windows', name: 'BrowserDev' }));
    // tasklist.exe returns a matching process
    mockExec.mockResolvedValue({
      stdout: '"claude.exe","5555","Console","1","50,000 K"\r\n',
      stderr: '',
    });

    const cleaned = await sweepStaleCollabFiles();
    expect(cleaned).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
    // /proc should NOT have been checked for a windows agent
    expect(mockFsAccess).not.toHaveBeenCalled();
  });

  it('deletes a Windows session file when tasklist.exe confirms PID is dead', async () => {
    mockReaddir.mockResolvedValue(['collab-session-7777.json']);
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 7777, platform: 'windows', name: 'BrowserDev' }));
    mockExec.mockResolvedValue({
      stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
      stderr: '',
    });

    const cleaned = await sweepStaleCollabFiles();
    expect(cleaned).toBe(1);
    expect(mockUnlink).toHaveBeenCalledWith('/tmp/collab-session-7777.json');
  });
});
