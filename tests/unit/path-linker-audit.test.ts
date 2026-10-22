/**
 * Unit tests for path-linker audit log writer.
 * Sprint 37 P3-T4. Written TDD — RED first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeAuditEntry,
  resetAuditForTest,
  type AuditEntry,
} from '@/lib/path-linker-audit';

let tempDir: string;
let logPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  logPath = join(tempDir, 'path-linker.jsonl');
  resetAuditForTest();
});

afterEach(() => {
  resetAuditForTest();
  rmSync(tempDir, { recursive: true, force: true });
});

function readEntries(): AuditEntry[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

// ─── Basic writes ────────────────────────────────────────────────────────────

describe('writeAuditEntry', () => {
  it('writes an allowed entry to the log file', async () => {
    await writeAuditEntry(logPath, {
      path: '/home/user/SG-1/plan.md',
      decision: 'allowed',
      winpath: '\\\\wsl.localhost\\Ubuntu\\home\\user\\SG-1\\plan.md',
    });

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('/home/user/SG-1/plan.md');
    expect(entries[0].decision).toBe('allowed');
    expect(entries[0].winpath).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\user\\SG-1\\plan.md'
    );
  });

  it('writes a denied entry to the log file', async () => {
    await writeAuditEntry(logPath, {
      path: '/etc/passwd',
      decision: 'denied:not-in-allowlist',
    });

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe('denied:not-in-allowlist');
    expect(entries[0].winpath).toBeUndefined();
  });

  it('writes a denied:not-found entry', async () => {
    await writeAuditEntry(logPath, {
      path: '/home/user/SG-1/nonexistent.ts',
      decision: 'denied:not-found',
    });

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe('denied:not-found');
  });

  it('includes a timestamp in ISO format', async () => {
    await writeAuditEntry(logPath, {
      path: '/home/user/DevFlow/lib/foo.ts',
      decision: 'allowed',
    });

    const entries = readEntries();
    expect(entries[0].ts).toBeDefined();
    // Should be a valid ISO date
    expect(new Date(entries[0].ts).toISOString()).toBe(entries[0].ts);
  });

  it('includes actor field when provided', async () => {
    await writeAuditEntry(logPath, {
      path: '/home/user/DevFlow/lib/foo.ts',
      decision: 'allowed',
      actor: 'owner',
    });

    const entries = readEntries();
    expect(entries[0].actor).toBe('owner');
  });

  it('appends multiple entries (one per line)', async () => {
    await writeAuditEntry(logPath, {
      path: '/home/user/SG-1/a.ts',
      decision: 'allowed',
    });
    await writeAuditEntry(logPath, {
      path: '/etc/passwd',
      decision: 'denied:not-in-allowlist',
    });
    await writeAuditEntry(logPath, {
      path: '/home/user/SG-1/b.ts',
      decision: 'allowed',
    });

    const entries = readEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].path).toBe('/home/user/SG-1/a.ts');
    expect(entries[1].path).toBe('/etc/passwd');
    expect(entries[2].path).toBe('/home/user/SG-1/b.ts');
  });

  it('creates the log file if it does not exist', async () => {
    expect(existsSync(logPath)).toBe(false);

    await writeAuditEntry(logPath, {
      path: '/home/user/SG-1/plan.md',
      decision: 'allowed',
    });

    expect(existsSync(logPath)).toBe(true);
  });

  it('creates parent directory if it does not exist', async () => {
    const deepPath = join(tempDir, 'nested', 'dir', 'audit.jsonl');

    await writeAuditEntry(deepPath, {
      path: '/home/user/SG-1/plan.md',
      decision: 'allowed',
    });

    expect(existsSync(deepPath)).toBe(true);
  });

  it('each line is valid JSON (no corruption)', async () => {
    for (let i = 0; i < 5; i++) {
      await writeAuditEntry(logPath, {
        path: `/home/user/SG-1/file-${i}.ts`,
        decision: i % 2 === 0 ? 'allowed' : 'denied:not-in-allowlist',
      });
    }

    const raw = readFileSync(logPath, 'utf-8').trim();
    const lines = raw.split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
