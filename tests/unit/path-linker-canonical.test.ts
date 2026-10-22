/**
 * Unit tests for canonical path validation (realpath + allowlist check).
 * Sprint 37 P3-T2. Written TDD — RED first.
 *
 * Tests use real temp directories with symlinks and .. traversal to verify
 * that canonicalization actually defeats escape attempts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalizeExistingPath,
  validateAndCanonicalize,
  type ValidationResult,
} from '@/lib/path-linker-validate';
import { loadAllowlist, resetAllowlistForTest } from '@/lib/path-linker-allowlist';

let tempDir: string;
let allowedRoot: string;
let outsideDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'canonical-test-'));

  // Create an "allowed" root with some files
  allowedRoot = join(tempDir, 'allowed');
  mkdirSync(allowedRoot, { recursive: true });
  mkdirSync(join(allowedRoot, 'sub'), { recursive: true });
  writeFileSync(join(allowedRoot, 'file.ts'), 'content');
  writeFileSync(join(allowedRoot, 'sub', 'deep.md'), 'content');

  // Create an "outside" directory (not allowed)
  outsideDir = join(tempDir, 'outside');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret');

  // Create a .ssh directory inside allowed root (should be denied)
  mkdirSync(join(allowedRoot, '.ssh'), { recursive: true });
  writeFileSync(join(allowedRoot, '.ssh', 'id_rsa'), 'key');

  // Create node_modules inside allowed root
  mkdirSync(join(allowedRoot, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(allowedRoot, 'node_modules', 'pkg', 'index.js'), '');

  // Write allowlist config pointing at our temp allowed root
  configPath = join(tempDir, 'allowlist.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      roots: [allowedRoot],
      denyPatterns: ['/\\.ssh(/|$)', '/\\.secrets(/|$)', '/node_modules(/|$)'],
    })
  );

  resetAllowlistForTest();
  loadAllowlist(configPath);
});

afterEach(() => {
  resetAllowlistForTest();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Happy paths ───��─────────────────────────────────────────────────────────

describe('validateAndCanonicalize — allowed paths', () => {
  it('allows a file under the allowed root', async () => {
    const result = await validateAndCanonicalize(join(allowedRoot, 'file.ts'));
    expect(result.allowed).toBe(true);
    expect(result.canonicalPath).toBe(join(allowedRoot, 'file.ts'));
    expect(result.isDirectory).toBe(false);
  });

  it('allows a directory under the allowed root', async () => {
    const result = await validateAndCanonicalize(join(allowedRoot, 'sub'));
    expect(result.allowed).toBe(true);
    expect(result.isDirectory).toBe(true);
  });

  it('allows the root directory itself', async () => {
    const result = await validateAndCanonicalize(allowedRoot);
    expect(result.allowed).toBe(true);
    expect(result.isDirectory).toBe(true);
  });

  it('allows a deeply nested file', async () => {
    const result = await validateAndCanonicalize(
      join(allowedRoot, 'sub', 'deep.md')
    );
    expect(result.allowed).toBe(true);
    expect(result.canonicalPath).toBe(join(allowedRoot, 'sub', 'deep.md'));
  });
});

// ─── Traversal attacks ────────���──────────────────────────────────────────────

describe('validateAndCanonicalize — traversal attacks', () => {
  it('blocks .. traversal out of allowed root', async () => {
    // allowedRoot/../outside/secret.txt resolves to outsideDir/secret.txt
    const attackPath = join(allowedRoot, '..', 'outside', 'secret.txt');
    const result = await validateAndCanonicalize(attackPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowlist/i);
  });

  it('blocks double .. traversal', async () => {
    const attackPath = join(allowedRoot, 'sub', '..', '..', 'outside', 'secret.txt');
    const result = await validateAndCanonicalize(attackPath);
    expect(result.allowed).toBe(false);
  });

  it('blocks symlink escape from allowed to outside', async () => {
    // Create a symlink inside allowed root pointing outside
    const linkPath = join(allowedRoot, 'escape-link');
    symlinkSync(outsideDir, linkPath);

    const attackPath = join(linkPath, 'secret.txt');
    const result = await validateAndCanonicalize(attackPath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowlist/i);
  });

  it('blocks symlink to a specific file outside', async () => {
    const linkPath = join(allowedRoot, 'secret-link.txt');
    symlinkSync(join(outsideDir, 'secret.txt'), linkPath);

    const result = await validateAndCanonicalize(linkPath);
    expect(result.allowed).toBe(false);
  });
});

// ─── Deny patterns ──────────────────────────────────────────────────────────

describe('validateAndCanonicalize — deny patterns', () => {
  it('blocks .ssh even though it is under allowed root', async () => {
    const result = await validateAndCanonicalize(
      join(allowedRoot, '.ssh', 'id_rsa')
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowlist/i);
  });

  it('blocks node_modules even though under allowed root', async () => {
    const result = await validateAndCanonicalize(
      join(allowedRoot, 'node_modules', 'pkg', 'index.js')
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowlist/i);
  });
});

// ─── Non-existent paths ─────────────────────────────────────────────────────

describe('validateAndCanonicalize — non-existent paths', () => {
  it('returns not-found for a path that does not exist', async () => {
    const result = await validateAndCanonicalize(
      join(allowedRoot, 'nonexistent.ts')
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it('returns not-found for a deeply non-existent path', async () => {
    const result = await validateAndCanonicalize(
      join(allowedRoot, 'a', 'b', 'c', 'nope.ts')
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });
});

// ─── Edge cases ───────��──────────────────────────────────────────────────────

describe('validateAndCanonicalize — edge cases', () => {
  it('rejects empty string', async () => {
    const result = await validateAndCanonicalize('');
    expect(result.allowed).toBe(false);
  });

  it('rejects relative paths', async () => {
    const result = await validateAndCanonicalize('relative/path.ts');
    expect(result.allowed).toBe(false);
  });

  it('canonicalizes path with trailing slash', async () => {
    const result = await validateAndCanonicalize(allowedRoot + '/');
    expect(result.allowed).toBe(true);
    expect(result.canonicalPath).toBe(allowedRoot);
  });
});

describe('canonicalizeExistingPath (File Explorer: no allowlist)', () => {
  it('allows a symlink into a directory outside the allowlist', async () => {
    const link = join(allowedRoot, 'drive-link');
    symlinkSync(outsideDir, link);
    const result = await canonicalizeExistingPath(link);
    expect(result.allowed).toBe(true);
    expect(result.isDirectory).toBe(true);
    expect(result.canonicalPath).not.toContain('drive-link');
  });

  it('rejects relative and missing paths', async () => {
    expect((await canonicalizeExistingPath('relative/file.ts')).reason).toBe('invalid path');
    expect((await canonicalizeExistingPath(join(tempDir, 'missing.md'))).reason).toBe('not found');
  });
});
