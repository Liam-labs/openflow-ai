/**
 * Tests for lib/open-in-windows.ts — full openInWindows logic.
 * P2-T3: wslpath translation + fire-and-forget spawn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';

// ─── Mock wslpath ───────────────────────────────────────────────────────
const mockTranslate = vi.fn<(p: string) => Promise<string>>();
vi.mock('@/lib/wsl-path', () => ({
  translateToWindows: (p: string) => mockTranslate(p),
}));

const mockResolveInterop = vi.fn<() => Promise<string>>();
const mockAssertWslService = vi.fn<(socketPath: string) => Promise<void>>();
vi.mock('@/lib/windows-interop', () => ({
  resolveWorkingWslInterop: () => mockResolveInterop(),
  assertWindowsWslServiceAvailable: (socketPath: string) => mockAssertWslService(socketPath),
}));

// ─── Mock child_process.spawn ───────────────────────────────────────────
const mockSpawn = vi.fn();
const mockUnref = vi.fn();
const mockOn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => {
    mockSpawn(...args);
    return { unref: mockUnref, on: mockOn };
  },
}));

// ─── Mock fs.stat for path existence check ──────────────────────────────
const mockStat = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    promises: {
      ...real.promises,
      stat: (...args: unknown[]) => mockStat(...args),
    },
  };
});

import { openInWindows } from '@/lib/open-in-windows';

beforeEach(() => {
  mockResolveInterop.mockReset().mockResolvedValue('/run/WSL/123_interop');
  mockAssertWslService.mockReset().mockResolvedValue(undefined);
});

// ─── Helpers ────────────────────────────────────────────────────────────

function setupHappy(winPath: string, isDir = false) {
  mockTranslate.mockResolvedValue(winPath);
  mockStat.mockResolvedValue({ isDirectory: () => isDir });
}

// ─── Open mode (file) ──────────────────────────────────────────────────

describe('openInWindows — open file', () => {
  beforeEach(() => {
    mockTranslate.mockReset();
    mockSpawn.mockReset();
    mockUnref.mockReset();
    mockOn.mockReset();
    mockStat.mockReset();
  });

  it('translates path via wslpath then spawns explorer.exe for files (shell-dispatches to default handler)', async () => {
    setupHappy('\\\\wsl.localhost\\Ubuntu\\home\\user\\test.md', false);
    const result = await openInWindows({ path: '/home/user/test.md', mode: 'open' });

    expect(result.success).toBe(true);
    expect(mockTranslate).toHaveBeenCalledWith('/home/user/test.md');
    expect(mockSpawn).toHaveBeenCalledWith(
      'explorer.exe',
      ['\\\\wsl.localhost\\Ubuntu\\home\\user\\test.md'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        shell: false,
        env: expect.objectContaining({ WSL_INTEROP: '/run/WSL/123_interop' }),
      }),
    );
    expect(mockUnref).toHaveBeenCalled();
  });

  it('spawns explorer.exe for directories', async () => {
    setupHappy('\\\\wsl.localhost\\Ubuntu\\home\\user\\docs', true);
    const result = await openInWindows({ path: '/home/user/docs', mode: 'open' });

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'explorer.exe',
      ['\\\\wsl.localhost\\Ubuntu\\home\\user\\docs'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        shell: false,
        env: expect.objectContaining({ WSL_INTEROP: '/run/WSL/123_interop' }),
      }),
    );
  });
});

// ─── Reveal mode ────────────────────────────────────────────────────────

describe('openInWindows — reveal', () => {
  beforeEach(() => {
    mockTranslate.mockReset();
    mockSpawn.mockReset();
    mockUnref.mockReset();
    mockOn.mockReset();
    mockStat.mockReset();
  });

  it('spawns explorer.exe /select for reveal mode', async () => {
    setupHappy('\\\\wsl.localhost\\Ubuntu\\home\\user\\test.md', false);
    const result = await openInWindows({ path: '/home/user/test.md', mode: 'reveal' });

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'explorer.exe',
      ['/select,', '\\\\wsl.localhost\\Ubuntu\\home\\user\\test.md'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        shell: false,
        env: expect.objectContaining({ WSL_INTEROP: '/run/WSL/123_interop' }),
      }),
    );
  });

  it('spawns explorer.exe (no /select) when revealing a directory', async () => {
    setupHappy('\\\\wsl.localhost\\Ubuntu\\home\\user\\docs', true);
    const result = await openInWindows({ path: '/home/user/docs', mode: 'reveal' });

    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'explorer.exe',
      ['\\\\wsl.localhost\\Ubuntu\\home\\user\\docs'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        shell: false,
        env: expect.objectContaining({ WSL_INTEROP: '/run/WSL/123_interop' }),
      }),
    );
  });
});

// ─── Error paths ────────────────────────────────────────────────────────

describe('openInWindows — errors', () => {
  beforeEach(() => {
    mockTranslate.mockReset();
    mockSpawn.mockReset();
    mockUnref.mockReset();
    mockOn.mockReset();
    mockStat.mockReset();
  });

  it('returns 404 when path does not exist', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await openInWindows({ path: '/nonexistent', mode: 'open' });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.error).toMatch(/not exist/i);
  });

  it('returns 500 when wslpath translation fails', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false });
    mockTranslate.mockRejectedValue(new Error('wslpath failed'));
    const result = await openInWindows({ path: '/home/user/test.md', mode: 'open' });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toMatch(/wslpath/i);
  });

  it('returns 500 when spawn throws', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false });
    mockTranslate.mockResolvedValue('C:\\test.md');
    mockSpawn.mockImplementation(() => { throw new Error('spawn failed'); });
    const result = await openInWindows({ path: '/test.md', mode: 'open' });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toMatch(/spawn/i);
  });

  it('returns 500 instead of false success when Windows cannot launch WSL', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false });
    mockTranslate.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\user\\test.md');
    mockAssertWslService.mockRejectedValue(new Error('Wsl/Service/E_UNEXPECTED'));

    const result = await openInWindows({ path: '/home/user/test.md', mode: 'open' });

    expect(result).toMatchObject({ success: false, statusCode: 500 });
    expect(result.error).toMatch(/E_UNEXPECTED/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ─── Fire-and-forget contract ───────────────────────────────────────────

describe('openInWindows — fire-and-forget', () => {
  beforeEach(() => {
    mockTranslate.mockReset();
    mockSpawn.mockReset();
    mockUnref.mockReset();
    mockOn.mockReset();
    mockStat.mockReset();
  });

  it('always calls unref() on the spawned process', async () => {
    setupHappy('C:\\test.md', false);
    await openInWindows({ path: '/test.md', mode: 'open' });
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('always passes detached:true and stdio:ignore', async () => {
    setupHappy('C:\\test.md', false);
    await openInWindows({ path: '/test.md', mode: 'open' });
    const spawnOpts = mockSpawn.mock.calls[0][2];
    expect(spawnOpts.detached).toBe(true);
    expect(spawnOpts.stdio).toBe('ignore');
    expect(spawnOpts.shell).toBe(false);
  });

  it("attaches an 'error' listener so spawn ENOENT is surfaced, not swallowed", async () => {
    setupHappy('C:\\test.md', false);
    await openInWindows({ path: '/test.md', mode: 'open' });
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it("attaches an 'error' listener on the reveal spawn too", async () => {
    setupHappy('\\\\wsl.localhost\\Ubuntu\\home\\user\\test.md', false);
    await openInWindows({ path: '/home/user/test.md', mode: 'reveal' });
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
