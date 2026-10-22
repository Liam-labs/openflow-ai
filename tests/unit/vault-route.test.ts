/**
 * Tests for PUT /api/vault — payload validation hardening.
 *
 * Sprint 52 T2: a stub `{version:1}` PUT silently overwrote a populated vault on
 * 2026-03-25, wiping months of secrets. The handler must reject any PUT that
 * lacks the four required fields (password, passkeys, backupCodes, secrets) plus
 * version, regardless of whether a populated vault file already exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';

// Per-suite tmp dir for the fake vault file. Created/destroyed in before/after.
// Uses vi.hoisted so the path is available inside the hoisted vi.mock factory —
// hoisted code runs BEFORE module imports, so we require() instead of import.
const { vaultPath } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-route-'));
  return { vaultPath: path.join(root, 'vault.json') };
});

vi.mock('@/lib/data-paths', () => ({
  DataPaths: { vault: vaultPath },
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/api-tracking', () => ({
  tracked: (_p: string, handler: Function) => handler,
}));

import { PUT } from '@/app/api/vault/route';
import { requireAuthOrLocal } from '@/lib/api-auth';

function makePut(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/vault', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const completeVault = {
  version: 1,
  password: { kdf: { algorithm: 'argon2id', salt: 'x', iterations: 4, memory: 1, parallelism: 1 }, encryptedDEK: { iv: 'y', ciphertext: 'z' } },
  passkeys: [],
  backupCodes: [{ id: 1, hash: 'h', encryptedDEK: { iv: 'a', ciphertext: 'b' }, used: false }],
  secrets: { iv: 'i', ciphertext: 'c' },
};

const populatedExisting = {
  version: 1,
  createdAt: '2026-01-04T00:00:00.000Z',
  updatedAt: '2026-03-08T00:00:00.000Z',
  password: completeVault.password,
  passkeys: [],
  backupCodes: completeVault.backupCodes,
  secrets: completeVault.secrets,
};

function clearVault() {
  // Wipe vault.json AND any vault.json.bak.* rotations from prior tests so
  // each case starts from a clean slate.
  const dir = dirname(vaultPath);
  const base = basename(vaultPath);
  for (const entry of readdirSync(dir)) {
    if (entry === base || entry.startsWith(`${base}.bak.`)) {
      rmSync(`${dir}/${entry}`);
    }
  }
}
function writeExisting(data: unknown) {
  writeFileSync(vaultPath, JSON.stringify(data, null, 2));
}
function listBackups(): string[] {
  const dir = dirname(vaultPath);
  const base = basename(vaultPath);
  return readdirSync(dir).filter(f => f.startsWith(`${base}.bak.`)).sort();
}

beforeEach(() => {
  vi.mocked(requireAuthOrLocal).mockResolvedValue(null);
  clearVault();
});

afterEach(() => {
  clearVault();
});

describe('PUT /api/vault — Sprint 52 T2 validation hardening', () => {
  it('REJECTS stub {version:1} when a populated vault exists (the 2026-03-25 bug)', async () => {
    writeExisting(populatedExisting);
    const before = readFileSync(vaultPath, 'utf-8');

    const res = await PUT(makePut({ version: 1 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/missing required fields|incomplete|invalid vault/i);

    // Critical: existing file must be untouched.
    expect(readFileSync(vaultPath, 'utf-8')).toBe(before);
  });

  it('ACCEPTS a complete PUT when a populated vault exists (overwrite ok)', async () => {
    writeExisting(populatedExisting);

    const updated = { ...completeVault, secrets: { iv: 'new-iv', ciphertext: 'new-ct' } };
    const res = await PUT(makePut(updated));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const written = JSON.parse(readFileSync(vaultPath, 'utf-8'));
    expect(written.secrets).toEqual({ iv: 'new-iv', ciphertext: 'new-ct' });
  });

  it('ACCEPTS a complete setup PUT when no vault file exists (first setup)', async () => {
    expect(existsSync(vaultPath)).toBe(false);

    const res = await PUT(makePut(completeVault));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    expect(existsSync(vaultPath)).toBe(true);
    const written = JSON.parse(readFileSync(vaultPath, 'utf-8'));
    expect(written.version).toBe(1);
    expect(written.password).toBeDefined();
    expect(Array.isArray(written.passkeys)).toBe(true);
    expect(Array.isArray(written.backupCodes)).toBe(true);
    expect(written.secrets).toBeDefined();
  });

  it('REJECTS stub {version:1} when no vault file exists (no shortcuts even on first setup)', async () => {
    expect(existsSync(vaultPath)).toBe(false);

    const res = await PUT(makePut({ version: 1 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/missing required fields|incomplete|invalid vault/i);

    // Nothing written.
    expect(existsSync(vaultPath)).toBe(false);
  });

  it('REJECTS each individual missing required field (password / passkeys / backupCodes / secrets)', async () => {
    writeExisting(populatedExisting);
    const required = ['password', 'passkeys', 'backupCodes', 'secrets'] as const;
    for (const field of required) {
      const partial: Record<string, unknown> = { ...completeVault };
      delete partial[field];
      const res = await PUT(makePut(partial));
      expect(res.status, `omitting "${field}" must yield 400`).toBe(400);
    }
  });

  it('REJECTS wrong-typed required fields (passkeys/backupCodes must be arrays; password/secrets must be objects)', async () => {
    writeExisting(populatedExisting);

    const cases: Array<Record<string, unknown>> = [
      { ...completeVault, passkeys: 'not-an-array' },
      { ...completeVault, backupCodes: 'not-an-array' },
      { ...completeVault, password: 'not-an-object' },
      { ...completeVault, secrets: null },
    ];

    for (const body of cases) {
      const res = await PUT(makePut(body));
      expect(res.status).toBe(400);
    }
  });

  it('REJECTS unsupported version even when other fields look complete', async () => {
    const res = await PUT(makePut({ ...completeVault, version: 2 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/version/i);
  });

  it('REJECTS non-object body', async () => {
    const res = await PUT(makePut(null));
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/vault — Sprint 52 T3 versioned backups', () => {
  it('CREATES a vault.json.bak.<ts> snapshot before overwriting an existing vault', async () => {
    writeExisting(populatedExisting);
    const before = readFileSync(vaultPath, 'utf-8');
    expect(listBackups()).toEqual([]);

    const updated = { ...completeVault, secrets: { iv: 'new', ciphertext: 'new' } };
    const res = await PUT(makePut(updated));
    expect(res.status).toBe(200);

    const backups = listBackups();
    expect(backups.length).toBe(1);
    // The backup must contain the PRE-PUT bytes, not the new payload —
    // otherwise it can't actually be used to recover from a bad save.
    const backupContent = readFileSync(`${dirname(vaultPath)}/${backups[0]}`, 'utf-8');
    expect(backupContent).toBe(before);
    // And the live vault is the new payload.
    expect(JSON.parse(readFileSync(vaultPath, 'utf-8')).secrets).toEqual({ iv: 'new', ciphertext: 'new' });
  });

  it('SKIPS backup when no vault file exists (first setup)', async () => {
    expect(existsSync(vaultPath)).toBe(false);

    const res = await PUT(makePut(completeVault));
    expect(res.status).toBe(200);

    expect(listBackups()).toEqual([]);
    expect(existsSync(vaultPath)).toBe(true);
  });

  it('SKIPS backup creation on a rejected PUT (validation 400 must not snapshot)', async () => {
    writeExisting(populatedExisting);
    expect(listBackups()).toEqual([]);

    const res = await PUT(makePut({ version: 1 }));
    expect(res.status).toBe(400);
    expect(listBackups()).toEqual([]);
  });

  it('ROTATES backups: keeps only the last 10 after 12 successful PUTs', async () => {
    writeExisting(populatedExisting);

    for (let i = 0; i < 12; i++) {
      const payload = { ...completeVault, secrets: { iv: `iv-${i}`, ciphertext: `ct-${i}` } };
      const res = await PUT(makePut(payload));
      expect(res.status).toBe(200);
    }

    const backups = listBackups();
    expect(backups.length).toBe(10);
  });

  it('Each backup filename uses the vault.json.bak.<isoSafe> naming convention', async () => {
    writeExisting(populatedExisting);
    await PUT(makePut(completeVault));

    const backups = listBackups();
    expect(backups.length).toBe(1);
    // ISO-8601 with `:` substituted for `-` to keep filenames cross-platform safe.
    expect(backups[0]).toMatch(/^vault\.json\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  });
});
