/**
 * DevFlow Vault API
 *
 * Handles vault file storage on the server filesystem.
 * The server only sees encrypted data - never plaintext secrets.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { writeJsonFile } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

// Force dynamic to prevent caching
export const dynamic = 'force-dynamic';

// Vault file path
const VAULT_FILE_PATH = DataPaths.vault;

// Sprint 52 T3 — keep the most recent N backups; older ones get garbage-collected.
const VAULT_BACKUP_RETAIN = 10;

/**
 * Snapshot the existing vault file to vault.json.bak.<isoSafe-ts> before it
 * gets overwritten, then prune backups beyond VAULT_BACKUP_RETAIN. Idempotent:
 * a no-op when the source file doesn't exist (first setup).
 *
 * Filenames are sortable lexicographically because the timestamp is fixed-width
 * ISO-8601 (with `:` rewritten to `-` for cross-platform safety).
 *
 * Never reads or logs vault contents — only the path is referenced.
 */
async function rotateVaultBackup(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    // No current file → first setup, nothing to back up.
    return;
  }

  const ts = new Date().toISOString().replace(/:/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  const backupPath = `${filePath}.bak.${ts}-${rand}`;
  await fs.copyFile(filePath, backupPath);

  // Prune: list .bak.* siblings, sort newest-first, drop tail beyond retain.
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const entries = await fs.readdir(dir);
  const backups = entries
    .filter(name => name.startsWith(`${base}.bak.`))
    .sort()
    .reverse();
  const toDelete = backups.slice(VAULT_BACKUP_RETAIN);
  await Promise.all(toDelete.map(name => fs.unlink(path.join(dir, name)).catch(() => {})));
}

// ============================================================================
// GET - Retrieve vault file
// ============================================================================

export const GET = tracked('/api/vault', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    // Check if vault file exists
    try {
      await fs.access(VAULT_FILE_PATH);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Vault not found' },
        { status: 404 }
      );
    }

    // Read vault file
    const content = await fs.readFile(VAULT_FILE_PATH, 'utf-8');
    const vault = JSON.parse(content);

    return NextResponse.json({ success: true, vault });
  } catch (error) {
    console.error('Error reading vault:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read vault' },
      { status: 500 }
    );
  }
});

// ============================================================================
// HEAD - Check if vault exists
// ============================================================================

export async function HEAD(request: NextRequest) {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    await fs.access(VAULT_FILE_PATH);
    return new NextResponse(null, { status: 200 });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

// ============================================================================
// PUT - Save vault file
// ============================================================================

export const PUT = tracked('/api/vault', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const vault = await request.json();

    // Validate vault structure
    if (!vault || typeof vault !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Invalid vault data' },
        { status: 400 }
      );
    }

    if (vault.version !== 1) {
      return NextResponse.json(
        { success: false, error: 'Unsupported vault version' },
        { status: 400 }
      );
    }

    // Sprint 52 T2 — enforce a complete payload on every PUT.
    // A stub `{version:1}` PUT silently overwrote a populated vault on
    // 2026-03-25, wiping months of secrets. The four fields below MUST be
    // present (and the right shape) regardless of file state — no shortcuts.
    const missing: string[] = [];
    if (!vault.password || typeof vault.password !== 'object') missing.push('password');
    if (!Array.isArray(vault.passkeys)) missing.push('passkeys');
    if (!Array.isArray(vault.backupCodes)) missing.push('backupCodes');
    if (!vault.secrets || typeof vault.secrets !== 'object') missing.push('secrets');
    if (missing.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Missing required fields: ${missing.join(', ')}`,
          missing,
        },
        { status: 400 }
      );
    }

    // Ensure data directory exists
    const dataDir = path.dirname(VAULT_FILE_PATH);
    await fs.mkdir(dataDir, { recursive: true });

    // Sprint 52 T3 — snapshot the existing vault before overwriting so we can
    // recover if a future bad save slips past validation. No-op on first setup.
    await rotateVaultBackup(VAULT_FILE_PATH);

    // Write vault file (atomic)
    await writeJsonFile(VAULT_FILE_PATH, vault);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving vault:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to save vault' },
      { status: 500 }
    );
  }
});

// ============================================================================
// DELETE - Delete vault file
// ============================================================================

export const DELETE = tracked('/api/vault', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const { confirmationToken } = await request.json();

    // Require confirmation token to prevent accidental deletion
    if (confirmationToken !== 'DELETE_MY_VAULT') {
      return NextResponse.json(
        { success: false, error: 'Invalid confirmation token' },
        { status: 400 }
      );
    }

    // Check if vault exists
    try {
      await fs.access(VAULT_FILE_PATH);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Vault not found' },
        { status: 404 }
      );
    }

    // Delete vault file
    await fs.unlink(VAULT_FILE_PATH);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting vault:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete vault' },
      { status: 500 }
    );
  }
});
