/**
 * T2.1 TDD — isAgentAlive helper
 *
 * Covers:
 *   1. Linux /proc check for WSL agents (default platform)
 *   2. Windows platform — delegates to tasklist.exe, /proc skipped
 *   3. Invalid / zero PIDs return false without throwing
 *   4. Dead PID returns false (Linux)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockFsAccess, mockExec } = vi.hoisted(() => ({
  mockFsAccess: vi.fn(),
  mockExec: vi.fn(),
}));

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

const { isAgentAlive } = await import('@/lib/agent-liveness');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('isAgentAlive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Linux / WSL platform (default)', () => {
    it('returns true when /proc/<pid> exists', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      expect(await isAgentAlive(12345)).toBe(true);
      expect(mockFsAccess).toHaveBeenCalledWith('/proc/12345');
    });

    it('returns false when /proc/<pid> does not exist', async () => {
      mockFsAccess.mockRejectedValue(new Error('ENOENT'));
      expect(await isAgentAlive(99999)).toBe(false);
    });

    it('returns false for pid 0', async () => {
      expect(await isAgentAlive(0)).toBe(false);
      expect(mockFsAccess).not.toHaveBeenCalled();
    });

    it('returns false for NaN pid', async () => {
      expect(await isAgentAlive(NaN)).toBe(false);
      expect(mockFsAccess).not.toHaveBeenCalled();
    });

    it('explicit platform="wsl" also uses /proc check', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      expect(await isAgentAlive(5000, 'wsl')).toBe(true);
      expect(mockFsAccess).toHaveBeenCalledWith('/proc/5000');
    });
  });

  describe('Windows platform', () => {
    it('returns true when tasklist.exe finds the PID', async () => {
      mockExec.mockResolvedValue({
        stdout: '"claude.exe","1234","Console","1","50,000 K"\r\n',
        stderr: '',
      });
      expect(await isAgentAlive(1234, 'windows')).toBe(true);
      // should NOT touch /proc
      expect(mockFsAccess).not.toHaveBeenCalled();
    });

    it('returns false when tasklist.exe reports no matching task', async () => {
      mockExec.mockResolvedValue({
        stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
        stderr: '',
      });
      expect(await isAgentAlive(9999, 'windows')).toBe(false);
      expect(mockFsAccess).not.toHaveBeenCalled();
    });

    it('returns false when tasklist.exe throws (e.g., interop unavailable)', async () => {
      mockExec.mockRejectedValue(new Error('spawn tasklist.exe ENOENT'));
      expect(await isAgentAlive(1234, 'windows')).toBe(false);
    });
  });
});
