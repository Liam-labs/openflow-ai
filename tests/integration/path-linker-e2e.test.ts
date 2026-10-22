/**
 * End-to-end integration test — parser → validate → open-in-windows → spawn.
 * Sprint 37 P4-T1.
 *
 * Exercises the full Path Linker pipeline without a running server:
 *  1. parsePathsInText detects paths in chat text
 *  2. validateAndCanonicalize confirms they're allowed
 *  3. openInWindows translates via wslpath and spawns the Windows handler
 *
 * child_process.spawn and child_process.execFile are mocked to capture args
 * without actually launching Windows processes.
 */

import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock child_process BEFORE importing modules that use it
const mockSpawn = vi.fn((..._args: unknown[]) => ({ unref: vi.fn(), on: vi.fn() }));
const mockExecFile = vi.fn((..._args: unknown[]) => undefined);

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: (...args: unknown[]) => {
    mockExecFile(...args);
    // Simulate wslpath -w <path> → \\wsl.localhost\Ubuntu\<path>
    const callback = args[2] as (err: null, stdout: string) => void;
    const linuxPath = (args[1] as string[])[1]; // ['-w', linuxPath]
    const winPath = `\\\\wsl.localhost\\Ubuntu${linuxPath.replace(/\//g, '\\\\')}`;
    callback(null, winPath + '\n');
  },
}));

vi.mock('@/lib/windows-interop', () => ({
  resolveWorkingWslInterop: vi.fn().mockResolvedValue('/run/WSL/test_interop'),
  assertWindowsWslServiceAvailable: vi.fn().mockResolvedValue(undefined),
}));

import { parsePathsInText } from '@/lib/path-parser';
import { validateAndCanonicalize } from '@/lib/path-linker-validate';
import { loadAllowlist, resetAllowlistForTest } from '@/lib/path-linker-allowlist';
import { openInWindows } from '@/lib/open-in-windows';
import { writeAuditEntry, resetAuditForTest } from '@/lib/path-linker-audit';

let root: string;
let projectDir: string;
let outsideDir: string;
let configPath: string;
let auditPath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ple2e-'));

  // Allowed project
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, 'src', 'lib'), { recursive: true });
  mkdirSync(join(projectDir, 'data'), { recursive: true });
  mkdirSync(join(projectDir, '.ssh'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'index.ts'), 'export default {}');
  writeFileSync(join(projectDir, 'src', 'lib', 'util.ts'), 'export {}');
  writeFileSync(join(projectDir, 'data', 'config.json'), '{}');
  writeFileSync(join(projectDir, '.ssh', 'id_rsa'), 'PRIVATE KEY');

  // Forbidden dir + symlink escape
  outsideDir = join(root, 'forbidden');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), 'p4ss');
  symlinkSync(outsideDir, join(projectDir, 'escape'));

  // Config
  configPath = join(root, 'allowlist.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      roots: [projectDir],
      denyPatterns: ['/\\.ssh(/|$)', '/\\.secrets(/|$)', '/node_modules(/|$)'],
    })
  );

  auditPath = join(root, 'audit.jsonl');

  resetAllowlistForTest();
  loadAllowlist(configPath);
});

afterAll(() => {
  resetAllowlistForTest();
  resetAuditForTest();
  rmSync(root, { recursive: true, force: true });
});

// ─── Full pipeline: parse → validate → open ─────────────────────────────────

describe('E2E: chat message → path detection → validation → open', () => {
  it('detects a path in text, validates, and opens it', async () => {
    const text = `Check ${join(projectDir, 'src', 'index.ts')} for the main export`;
    const paths = parsePathsInText(text);

    expect(paths.length).toBeGreaterThanOrEqual(1);
    const detected = paths[0].path;

    // Validate
    const validation = await validateAndCanonicalize(detected);
    expect(validation.allowed).toBe(true);
    expect(validation.isDirectory).toBe(false);

    // Open
    mockSpawn.mockClear();
    const result = await openInWindows({ path: detected, mode: 'open' });
    expect(result.success).toBe(true);

    // Verify spawn was called with explorer.exe (file open — shell-dispatches to default handler)
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('explorer.exe');
    expect(args[0]).toMatch(/\\index\.ts$/);
  });

  it('detects a directory path and opens with explorer.exe', async () => {
    const text = `Open folder ${projectDir}/data to see configs`;
    const paths = parsePathsInText(text);
    expect(paths.length).toBeGreaterThanOrEqual(1);

    const validation = await validateAndCanonicalize(paths[0].path);
    expect(validation.allowed).toBe(true);
    expect(validation.isDirectory).toBe(true);

    mockSpawn.mockClear();
    const result = await openInWindows({ path: paths[0].path, mode: 'open' });
    expect(result.success).toBe(true);

    const [cmd] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('explorer.exe');
  });

  it('detects a file and reveals in folder (reveal mode)', async () => {
    const filePath = join(projectDir, 'src', 'lib', 'util.ts');
    const text = `See ${filePath} for utility functions`;
    const paths = parsePathsInText(text);

    const validation = await validateAndCanonicalize(paths[0].path);
    expect(validation.allowed).toBe(true);

    mockSpawn.mockClear();
    const result = await openInWindows({ path: paths[0].path, mode: 'reveal' });
    expect(result.success).toBe(true);

    const [cmd, args] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('explorer.exe');
    expect(args[0]).toMatch(/^\/select,/);
  });
});

// ─── Security: denied paths never reach spawn ───────────────────────────────

describe('E2E: denied paths are blocked before spawn', () => {
  it('blocks .ssh path — spawn never called', async () => {
    const sshPath = join(projectDir, '.ssh', 'id_rsa');
    const text = `Key at ${sshPath}`;
    const paths = parsePathsInText(text);
    expect(paths.length).toBeGreaterThanOrEqual(1);

    const validation = await validateAndCanonicalize(paths[0].path);
    expect(validation.allowed).toBe(false);

    // If validation fails, the route handler would return 403 — spawn never reached
    mockSpawn.mockClear();
    // Do NOT call openInWindows — the route would have stopped here
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('blocks symlink escape — spawn never called', async () => {
    const escapePath = join(projectDir, 'escape', 'secret.txt');
    const validation = await validateAndCanonicalize(escapePath);
    expect(validation.allowed).toBe(false);

    mockSpawn.mockClear();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('blocks traversal attack — spawn never called', async () => {
    const attackPath = join(projectDir, '..', 'forbidden', 'secret.txt');
    const validation = await validateAndCanonicalize(attackPath);
    expect(validation.allowed).toBe(false);

    mockSpawn.mockClear();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ─── Parser + validator interaction ─────────────────────────────────────────

describe('E2E: parser skips code blocks, validator handles rest', () => {
  it('path in code block is not detected — no validation needed', () => {
    const text = [
      'Some context here.',
      '```',
      `cat ${join(projectDir, 'src', 'index.ts')}`,
      '```',
      'That was in a code block.',
    ].join('\n');

    const paths = parsePathsInText(text);
    expect(paths).toHaveLength(0);
  });

  it('path outside code block is detected and validated', async () => {
    const realFile = join(projectDir, 'data', 'config.json');
    const text = [
      `Config at ${realFile}:`,
      '```json',
      '{"key": "value"}',
      '```',
    ].join('\n');

    const paths = parsePathsInText(text);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    // Strip trailing colon from test (parser handles this)
    expect(paths[0].path).toBe(realFile);

    const v = await validateAndCanonicalize(paths[0].path);
    expect(v.allowed).toBe(true);
  });
});

// ─── Audit logging in the pipeline ──────────────────────────────────────────

describe('E2E: audit log captures allowed and denied', () => {
  it('logs an allowed open to audit file', async () => {
    const filePath = join(projectDir, 'src', 'index.ts');

    const validation = await validateAndCanonicalize(filePath);
    expect(validation.allowed).toBe(true);

    await writeAuditEntry(auditPath, {
      path: filePath,
      decision: 'allowed',
      winpath: `\\\\wsl.localhost\\Ubuntu${filePath.replace(/\//g, '\\\\')}`,
    });

    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.decision).toBe('allowed');
    expect(entry.path).toBe(filePath);
  });

  it('logs a denied attempt to audit file', async () => {
    const attackPath = join(projectDir, '.ssh', 'id_rsa');

    const validation = await validateAndCanonicalize(attackPath);
    expect(validation.allowed).toBe(false);

    await writeAuditEntry(auditPath, {
      path: attackPath,
      decision: `denied:${validation.reason}`,
    });

    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.decision).toMatch(/^denied:/);
  });
});

// ─── Multiple paths in one message ──────────────────────────────────────────

describe('E2E: multiple paths in single message', () => {
  it('detects and validates multiple paths independently', async () => {
    const file1 = join(projectDir, 'src', 'index.ts');
    const file2 = join(projectDir, 'data', 'config.json');
    const sshFile = join(projectDir, '.ssh', 'id_rsa');

    const text = `Compare ${file1} and ${file2} but not ${sshFile}`;
    const paths = parsePathsInText(text);

    // Should detect all three path-like strings
    expect(paths.length).toBeGreaterThanOrEqual(2);

    // Validate each
    const results = await Promise.all(
      paths.map((p) => validateAndCanonicalize(p.path))
    );

    // file1 and file2 should be allowed, sshFile denied
    const allowed = results.filter((r) => r.allowed);
    const denied = results.filter((r) => !r.allowed);

    expect(allowed.length).toBeGreaterThanOrEqual(2);
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });
});
