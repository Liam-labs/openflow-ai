/**
 * Tests for lib/wsl-path.ts — wslpath translation helper.
 * P2-T2: execFile-based, no shell, handles spaces/unicode/quotes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execFile
type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
let execFileMock: (cmd: string, args: string[], cb: ExecFileCb) => void;

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], cb: ExecFileCb) => {
    execFileMock(cmd, args, cb);
  },
}));

import { translateToWindows } from '@/lib/wsl-path';

let execFileCalls: Array<{ cmd: string; args: string[] }> = [];

function setupSuccess(stdout: string) {
  execFileMock = (cmd, args, cb) => {
    execFileCalls.push({ cmd, args });
    cb(null, stdout, '');
  };
}

function setupFailure(stderr: string, exitCode: number | string = 1) {
  execFileMock = (cmd, args, cb) => {
    execFileCalls.push({ cmd, args });
    const err = new Error(stderr || 'wslpath failed') as Error & { code?: number | string };
    err.code = exitCode;
    cb(err, '', stderr);
  };
}

// ─── Happy paths ────────────────────────────────────────────────────────

describe('translateToWindows — happy paths', () => {
  beforeEach(() => { execFileCalls = []; });

  it('translates a simple Linux path to Windows UNC', async () => {
    setupSuccess('\\\\wsl.localhost\\Ubuntu\\home\\user\\DevFlow\n');
    const result = await translateToWindows('/home/user/DevFlow');
    expect(result).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\DevFlow');
  });

  it('strips trailing newline from wslpath output', async () => {
    setupSuccess('\\\\wsl.localhost\\Ubuntu\\test\n');
    const result = await translateToWindows('/test');
    expect(result).not.toMatch(/\n/);
  });

  it('strips trailing carriage return + newline', async () => {
    setupSuccess('\\\\wsl.localhost\\Ubuntu\\test\r\n');
    const result = await translateToWindows('/test');
    expect(result).toBe('\\\\wsl.localhost\\Ubuntu\\test');
  });

  it('calls execFile with wslpath -w and the path, no shell', async () => {
    setupSuccess('C:\\Users\\test\n');
    await translateToWindows('/mnt/c/Users/test');
    expect(execFileCalls[0].cmd).toBe('wslpath');
    expect(execFileCalls[0].args).toEqual(['-w', '/mnt/c/Users/test']);
  });

  it('handles path with spaces', async () => {
    setupSuccess('\\\\wsl.localhost\\Ubuntu\\home\\user\\My Documents\\file.md\n');
    const result = await translateToWindows('/home/user/My Documents/file.md');
    expect(result).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\My Documents\\file.md');
    // Verify no shell escaping — raw path passed to execFile args array
    expect(execFileCalls[0].args).toEqual(['-w', '/home/user/My Documents/file.md']);
  });

  it('handles path with unicode characters', async () => {
    setupSuccess('\\\\wsl.localhost\\Ubuntu\\home\\user\\données\\café.md\n');
    const result = await translateToWindows('/home/user/données/café.md');
    expect(result).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\données\\café.md');
  });

  it('handles path with single quotes', async () => {
    setupSuccess("\\\\wsl.localhost\\Ubuntu\\home\\user\\it's a file.md\n");
    const result = await translateToWindows("/home/user/it's a file.md");
    expect(result).toBe("\\\\wsl.localhost\\Ubuntu\\home\\user\\it's a file.md");
  });

  it('handles path with double quotes', async () => {
    setupSuccess('\\\\wsl.localhost\\Ubuntu\\home\\user\\"quoted".md\n');
    const result = await translateToWindows('/home/user/"quoted".md');
    expect(result).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\"quoted".md');
  });
});

// ─── Error paths ────────────────────────────────────────────────────────

describe('translateToWindows — error paths', () => {
  beforeEach(() => { execFileCalls = []; });

  it('rejects when wslpath exits non-zero', async () => {
    setupFailure('wslpath: /nonexistent: No such file or directory', 1);
    await expect(translateToWindows('/nonexistent')).rejects.toThrow(/wslpath/i);
  });

  it('rejects when execFile emits ENOENT (wslpath not found)', async () => {
    setupFailure('spawn wslpath ENOENT', 'ENOENT');
    await expect(translateToWindows('/test')).rejects.toThrow(/ENOENT/);
  });

  it('rejects when wslpath returns empty stdout', async () => {
    setupSuccess('');
    await expect(translateToWindows('/test')).rejects.toThrow(/empty/i);
  });

  it('rejects when wslpath returns only whitespace', async () => {
    setupSuccess('  \n\n  ');
    await expect(translateToWindows('/test')).rejects.toThrow(/empty/i);
  });
});
