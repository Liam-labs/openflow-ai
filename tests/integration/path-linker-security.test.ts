/**
 * Security test suite for Path Linker — adversarial input battery.
 * Sprint 37 P3-T3.
 *
 * Exercises the full validation pipeline (canonicalize + allowlist + deny)
 * with attack vectors a malicious agent or crafted message could attempt.
 * All tests use real filesystem fixtures (symlinks, directories, files).
 *
 * Target: ≥15 adversarial inputs. This file covers the attack surface.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateAndCanonicalize } from '@/lib/path-linker-validate';
import { loadAllowlist, resetAllowlistForTest } from '@/lib/path-linker-allowlist';

let root: string;
let allowed: string;
let forbidden: string;
let etcDir: string;
let configPath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'plsec-'));

  // Allowed project root
  allowed = join(root, 'project');
  mkdirSync(join(allowed, 'src', 'lib'), { recursive: true });
  mkdirSync(join(allowed, '.ssh'), { recursive: true });
  mkdirSync(join(allowed, '.secrets'), { recursive: true });
  mkdirSync(join(allowed, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(allowed, 'data'), { recursive: true });
  writeFileSync(join(allowed, 'src', 'index.ts'), 'export default {}');
  writeFileSync(join(allowed, 'src', 'lib', 'util.ts'), 'export {}');
  writeFileSync(join(allowed, '.ssh', 'id_rsa'), 'PRIVATE KEY');
  writeFileSync(join(allowed, '.ssh', 'authorized_keys'), '');
  writeFileSync(join(allowed, '.secrets', 'api-key.env'), 'KEY=secret');
  writeFileSync(join(allowed, 'node_modules', 'pkg', 'index.js'), '');
  writeFileSync(join(allowed, 'data', 'config.json'), '{}');

  // Forbidden directory (outside allowed root)
  forbidden = join(root, 'forbidden');
  mkdirSync(join(forbidden, 'sensitive'), { recursive: true });
  writeFileSync(join(forbidden, 'sensitive', 'passwords.txt'), 'p4ss');
  writeFileSync(join(forbidden, 'exploit.sh'), '#!/bin/bash');

  // Fake /etc directory
  etcDir = join(root, 'etc');
  mkdirSync(etcDir, { recursive: true });
  writeFileSync(join(etcDir, 'passwd'), 'root:x:0:0:root:/root:/bin/bash');
  writeFileSync(join(etcDir, 'shadow'), 'root:$6$...:');

  // Symlinks for escape testing
  symlinkSync(forbidden, join(allowed, 'escape-dir'));
  symlinkSync(
    join(forbidden, 'sensitive', 'passwords.txt'),
    join(allowed, 'escape-file.txt')
  );
  symlinkSync(etcDir, join(allowed, 'etc-link'));
  // Chained symlink: link → link → forbidden
  symlinkSync(join(allowed, 'escape-dir'), join(allowed, 'chain-link'));

  // Config
  configPath = join(root, 'allowlist.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      roots: [allowed],
      denyPatterns: ['/\\.ssh(/|$)', '/\\.secrets(/|$)', '/node_modules(/|$)'],
    })
  );

  resetAllowlistForTest();
  loadAllowlist(configPath);
});

afterAll(() => {
  resetAllowlistForTest();
  rmSync(root, { recursive: true, force: true });
});

// ─── CATEGORY 1: Dot-dot traversal ──────────────────────────────────────────

describe('Traversal: .. attacks', () => {
  it('ATK-01: basic ../forbidden escape', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, '..', 'forbidden', 'exploit.sh')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-02: deep ../../../ escape', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, 'src', 'lib', '..', '..', '..', 'forbidden', 'exploit.sh')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-03: .. to /etc/passwd equivalent', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, '..', 'etc', 'passwd')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-04: .. to /etc/shadow equivalent', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, '..', 'etc', 'shadow')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-05: .. then back into allowed (should still resolve correctly)', async () => {
    // project/../project/src/index.ts resolves to project/src/index.ts — allowed
    const r = await validateAndCanonicalize(
      join(allowed, '..', 'project', 'src', 'index.ts')
    );
    expect(r.allowed).toBe(true);
    expect(r.canonicalPath).toBe(join(allowed, 'src', 'index.ts'));
  });
});

// ─── CATEGORY 2: Symlink escapes ─────────────────────────────────────���──────

describe('Traversal: symlink escapes', () => {
  it('ATK-06: symlink directory → forbidden dir', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, 'escape-dir', 'sensitive', 'passwords.txt')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-07: symlink file → forbidden file', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, 'escape-file.txt')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-08: symlink to /etc equivalent', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, 'etc-link', 'passwd')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-09: chained symlink (link → link → forbidden)', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, 'chain-link', 'exploit.sh')
    );
    // chain-link → escape-dir → forbidden/exploit.sh
    expect(r.allowed).toBe(false);
  });
});

// ─── CATEGORY 3: Deny pattern bypass attempts ──────────────────────────────

describe('Traversal: deny pattern bypass', () => {
  it('ATK-10: direct .ssh access', async () => {
    const r = await validateAndCanonicalize(join(allowed, '.ssh', 'id_rsa'));
    expect(r.allowed).toBe(false);
  });

  it('ATK-11: .ssh directory itself', async () => {
    const r = await validateAndCanonicalize(join(allowed, '.ssh'));
    expect(r.allowed).toBe(false);
  });

  it('ATK-12: .secrets access', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, '.secrets', 'api-key.env')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-13: node_modules deep path', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, 'node_modules', 'pkg', 'index.js')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-14: .. into .ssh from adjacent dir', async () => {
    // src/../.ssh/id_rsa resolves to .ssh/id_rsa — still denied
    const r = await validateAndCanonicalize(
      join(allowed, 'src', '..', '.ssh', 'id_rsa')
    );
    expect(r.allowed).toBe(false);
  });
});

// ─── CATEGORY 4: Non-existent & edge case attacks ──────────────────────────

describe('Traversal: non-existent & edge cases', () => {
  it('ATK-15: non-existent path (cannot realpath)', async () => {
    const r = await validateAndCanonicalize(
      join(allowed, 'totally', 'made', 'up', 'path.ts')
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('ATK-16: empty string', async () => {
    const r = await validateAndCanonicalize('');
    expect(r.allowed).toBe(false);
  });

  it('ATK-17: relative path attack', async () => {
    const r = await validateAndCanonicalize('../../../etc/passwd');
    expect(r.allowed).toBe(false);
  });

  it('ATK-18: null bytes (path with \\0)', async () => {
    // Node's fs functions reject null bytes — should get "not found" or error
    const r = await validateAndCanonicalize(
      join(allowed, 'src\0', '..', 'forbidden')
    );
    expect(r.allowed).toBe(false);
  });

  it('ATK-19: path with spaces (legitimate but tricky)', async () => {
    // Not an attack — just verifying paths with spaces work correctly
    mkdirSync(join(allowed, 'my dir'), { recursive: true });
    writeFileSync(join(allowed, 'my dir', 'file.txt'), 'ok');
    const r = await validateAndCanonicalize(
      join(allowed, 'my dir', 'file.txt')
    );
    expect(r.allowed).toBe(true);
  });

  it('ATK-20: path ending with /.', async () => {
    // project/. resolves to project — should be allowed
    const r = await validateAndCanonicalize(join(allowed, '.'));
    expect(r.allowed).toBe(true);
  });
});
