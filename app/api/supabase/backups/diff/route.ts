/**
 * GET /api/supabase/backups/diff?instanceId=<uuid>&fileA=<name.sql>&fileB=<name.sql>
 *
 * Returns a structured schema-level diff between two local backup dumps for
 * a single instance. Powers the backup diff viewer (S3.3).
 *
 * Security:
 *   1. `requireAuthOrLocal('read')` gate
 *   2. Both filenames validated via `isSafeBackupFilename` (S3.1)
 *   3. Per-instance prefix check (reuses the S3.1/S3.2 safety layer) —
 *      a caller can only diff files that belong to the same instance they
 *      control, preventing cross-instance schema snooping
 *   4. Canonical-path containment via realpath — belt-and-braces against
 *      symlink escapes
 *   5. Local-only (hosted returns 400)
 *
 * Response shape (on success):
 *   {
 *     instanceId, fileA, fileB,
 *     diff: { addedTables, removedTables, modifiedTables }
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { stat, readFile, realpath } from 'fs/promises';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { DataPaths } from '@/lib/data-paths';
import { isSafeBackupFilename, sanitizeBackupInstanceName } from '@/lib/supabase-backup-security';
import { diffSqlDumps } from '@/lib/supabase-backup-diff';

const BACKUPS_DIR = path.join(DataPaths.appData, 'supabase-backups');

async function canonicalizeInsideBackups(filename: string): Promise<string | null> {
  try {
    const canonicalBackupsDir = await realpath(BACKUPS_DIR);
    const canonical = await realpath(path.join(BACKUPS_DIR, filename));
    const dirWithSep = canonicalBackupsDir.endsWith(path.sep)
      ? canonicalBackupsDir
      : canonicalBackupsDir + path.sep;
    if (!canonical.startsWith(dirWithSep)) return null;
    return canonical;
  } catch {
    return null;
  }
}

export const GET = tracked('/api/supabase/backups/diff', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const { searchParams } = request.nextUrl;
  const instanceId = searchParams.get('instanceId');
  const fileA = searchParams.get('fileA');
  const fileB = searchParams.get('fileB');

  if (!instanceId) {
    return NextResponse.json({ error: 'instanceId is required' }, { status: 400 });
  }
  if (!fileA || !fileB) {
    return NextResponse.json({ error: 'fileA and fileB are required' }, { status: 400 });
  }
  if (!isSafeBackupFilename(fileA) || !isSafeBackupFilename(fileB)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }
  if (fileA === fileB) {
    return NextResponse.json({ error: 'fileA and fileB must be different' }, { status: 400 });
  }

  const instance = await supabaseInstanceStore.getInstance(instanceId);
  if (!instance) {
    return NextResponse.json({ error: `Instance not found: ${instanceId}` }, { status: 404 });
  }
  if (instance.type !== 'local') {
    return NextResponse.json(
      { error: 'Diff endpoint only supports local instances.' },
      { status: 400 },
    );
  }

  // Per-instance prefix check (matches S3.1/S3.2)
  const prefix = sanitizeBackupInstanceName(instance.name).toLowerCase() + '-';
  if (!fileA.toLowerCase().startsWith(prefix) || !fileB.toLowerCase().startsWith(prefix)) {
    return NextResponse.json(
      { error: `One or both filenames do not belong to instance "${instance.name}"` },
      { status: 403 },
    );
  }

  // Canonical containment + file existence
  const canonA = await canonicalizeInsideBackups(fileA);
  const canonB = await canonicalizeInsideBackups(fileB);
  if (!canonA || !canonB) {
    return NextResponse.json({ error: 'One or both backup files not found' }, { status: 404 });
  }
  try {
    const [sA, sB] = await Promise.all([stat(canonA), stat(canonB)]);
    if (!sA.isFile() || !sB.isFile()) {
      return NextResponse.json({ error: 'Backup target is not a regular file' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'One or both backup files not found' }, { status: 404 });
  }

  // Read + diff. Dumps are plain text SQL — readFile is fine for the sizes
  // we see in practice (local dumps typically <100MB). If this grows, swap
  // to line-streaming; not worth the complexity yet.
  const [sqlA, sqlB] = await Promise.all([
    readFile(canonA, 'utf-8'),
    readFile(canonB, 'utf-8'),
  ]);

  const diff = diffSqlDumps(sqlA, sqlB);

  return NextResponse.json({
    success: true,
    instanceId,
    fileA,
    fileB,
    diff,
  });
});
