/**
 * Unit tests for path-linker-allowlist loader + validation.
 * Sprint 37 P3-T1. Written TDD — RED first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAllowlist,
  isPathAllowed,
  resetAllowlistForTest,
  type PathLinkerAllowlist,
} from '@/lib/path-linker-allowlist';

let tempDir: string;

function configPath(): string {
  return join(tempDir, 'allowlist.json');
}

function writeConfig(config: PathLinkerAllowlist) {
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

const DEFAULT_CONFIG: PathLinkerAllowlist = {
  roots: [
    '/home/user/SG-1',
    '/home/user/DevFlow',
    '/home/user/Pulse',
    '/home/user/rag-stack',
    '/home/user/.DevData',
    '/mnt/c/Users/winuser',
  ],
  denyPatterns: ['/\\.ssh(/|$)', '/\\.secrets(/|$)', '/node_modules(/|$)'],
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'allowlist-test-'));
  resetAllowlistForTest();
});

afterEach(() => {
  resetAllowlistForTest();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── loadAllowlist ───────────────────────────────────────────────────────────

describe('loadAllowlist', () => {
  it('loads a valid config file', () => {
    writeConfig(DEFAULT_CONFIG);
    const result = loadAllowlist(configPath());
    expect(result.roots).toEqual(DEFAULT_CONFIG.roots);
    expect(result.denyPatterns).toEqual(DEFAULT_CONFIG.denyPatterns);
  });

  it('returns default (empty roots, empty deny) when file is missing', () => {
    const result = loadAllowlist(join(tempDir, 'nonexistent.json'));
    expect(result.roots).toEqual([]);
    expect(result.denyPatterns).toEqual([]);
  });

  it('returns default when file contains invalid JSON', () => {
    writeFileSync(configPath(), 'not json {{{');
    const result = loadAllowlist(configPath());
    expect(result.roots).toEqual([]);
    expect(result.denyPatterns).toEqual([]);
  });

  it('returns default when roots is not an array', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ roots: 'not-array', denyPatterns: [] })
    );
    const result = loadAllowlist(configPath());
    expect(result.roots).toEqual([]);
  });

  it('caches on second call (same config returned)', () => {
    writeConfig(DEFAULT_CONFIG);
    const first = loadAllowlist(configPath());
    const second = loadAllowlist(configPath());
    expect(first).toBe(second); // Same reference = cached
  });

  it('reloads after resetAllowlistForTest', () => {
    writeConfig(DEFAULT_CONFIG);
    const first = loadAllowlist(configPath());

    resetAllowlistForTest();
    writeConfig({ roots: ['/tmp'], denyPatterns: [] });
    const second = loadAllowlist(configPath());

    expect(first.roots).toEqual(DEFAULT_CONFIG.roots);
    expect(second.roots).toEqual(['/tmp']);
  });

  it('filters out non-string entries in roots array', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ roots: ['/home/user', 42, null, '/tmp'], denyPatterns: [] })
    );
    const result = loadAllowlist(configPath());
    expect(result.roots).toEqual(['/home/user', '/tmp']);
  });

  it('filters out non-string entries in denyPatterns array', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ roots: ['/tmp'], denyPatterns: ['/\\.ssh(/|$)', 123] })
    );
    const result = loadAllowlist(configPath());
    expect(result.denyPatterns).toEqual(['/\\.ssh(/|$)']);
  });
});

// ─── isPathAllowed ───────────────────────────────────────────────────────────

describe('isPathAllowed', () => {
  beforeEach(() => {
    writeConfig(DEFAULT_CONFIG);
    loadAllowlist(configPath());
  });

  // ── Allowed ──

  it('allows a path under an allowlisted root', () => {
    expect(isPathAllowed('/home/user/SG-1/plan.md')).toBe(true);
  });

  it('allows a path under /home/user/DevFlow', () => {
    expect(isPathAllowed('/home/user/DevFlow/lib/foo.ts')).toBe(true);
  });

  it('allows a path under /mnt/c/Users/winuser', () => {
    expect(isPathAllowed('/mnt/c/Users/winuser/Documents/report.pdf')).toBe(true);
  });

  it('allows a deeply nested path', () => {
    expect(
      isPathAllowed(
        '/home/user/DevFlow/data/central-knowledge-base/platform/devflow.md'
      )
    ).toBe(true);
  });

  it('allows .DevData paths', () => {
    expect(isPathAllowed('/home/user/.DevData/docs/something.md')).toBe(true);
  });

  // ── Denied by root ──

  it('denies a path outside all roots', () => {
    expect(isPathAllowed('/etc/passwd')).toBe(false);
  });

  it('denies /root', () => {
    expect(isPathAllowed('/root/.bashrc')).toBe(false);
  });

  it('denies /home/otheruser', () => {
    expect(isPathAllowed('/home/otheruser/evil.sh')).toBe(false);
  });

  it('denies /usr paths', () => {
    expect(isPathAllowed('/usr/bin/node')).toBe(false);
  });

  it('denies a root that is a prefix but not a path boundary', () => {
    // /home/user/SG-1-evil should NOT match /home/user/SG-1
    expect(isPathAllowed('/home/user/SG-1-evil/exploit.sh')).toBe(false);
  });

  // ── Denied by deny pattern ──

  it('denies .ssh paths', () => {
    expect(isPathAllowed('/home/user/SG-1/.ssh/id_rsa')).toBe(false);
  });

  it('denies .secrets paths', () => {
    expect(isPathAllowed('/home/user/DevFlow/.secrets/api-key')).toBe(false);
  });

  it('denies node_modules paths', () => {
    expect(
      isPathAllowed('/home/user/DevFlow/node_modules/express/index.js')
    ).toBe(false);
  });

  it('denies .ssh directory itself', () => {
    expect(isPathAllowed('/home/user/SG-1/.ssh')).toBe(false);
  });

  it('denies .secrets directory itself', () => {
    expect(isPathAllowed('/home/user/DevFlow/.secrets')).toBe(false);
  });

  // ── Edge cases ──

  it('denies empty string', () => {
    expect(isPathAllowed('')).toBe(false);
  });

  it('allows root path exactly', () => {
    expect(isPathAllowed('/home/user/SG-1')).toBe(true);
  });

  it('allows root with trailing slash', () => {
    expect(isPathAllowed('/home/user/SG-1/')).toBe(true);
  });

  it('normalizes trailing slashes before matching', () => {
    expect(isPathAllowed('/home/user/DevFlow/')).toBe(true);
  });
});
