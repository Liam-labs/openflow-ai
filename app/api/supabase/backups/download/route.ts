/**
 * GET /api/supabase/backups/download?instanceId=<uuid>&filename=<name.sql>
 *
 * Streams a local Supabase backup .sql file to the caller with a
 * Content-Disposition: attachment header so the browser saves it.
 *
 * Security:
 *   1. `requireAuthOrLocal` — same gate as the sibling backup endpoints
 *   2. Filename must not contain slashes, backslashes, '..', or null bytes
 *   3. Filename must end with .sql
 *   4. The canonical path (after realpath) must live inside the backups dir
 *   5. The filename prefix must match the instance's sanitized name —
 *      prevents downloading another instance's dump even if the caller knows
 *      a valid filename for a different instance
 *   6. Only `type === 'local'` instances expose this endpoint; hosted
 *      Supabase backups come from the Management API, not local disk
 *
 * Hosted instances: returns 400 — download-to-disk is local-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { stat, open, realpath } from 'fs/promises';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { DataPaths } from '@/lib/data-paths';
import { isSafeBackupFilename, sanitizeBackupInstanceName } from '@/lib/supabase-backup-security';

const BACKUPS_DIR = path.join(DataPaths.appData, 'supabase-backups');

export const GET = tracked('/api/supabase/backups/download', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const { searchParams } = request.nextUrl;
  const instanceId = searchParams.get('instanceId');
  const filename = searchParams.get('filename');

  if (!instanceId) {
    return NextResponse.json({ error: 'instanceId is required' }, { status: 400 });
  }
  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }
  if (!isSafeBackupFilename(filename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  const instance = await supabaseInstanceStore.getInstance(instanceId);
  if (!instance) {
    return NextResponse.json({ error: `Instance not found: ${instanceId}` }, { status: 404 });
  }
  if (instance.type !== 'local') {
    return NextResponse.json(
      { error: 'Download endpoint only supports local instances. Hosted backups come from the Management API.' },
      { status: 400 },
    );
  }

  // Prefix check — the filename must correspond to THIS instance's dumps.
  // Uses the same prefix rule as the parent route's listLocalBackups:
  // case-insensitive match on `<sanitized-name>-` (the '-' separator prevents
  // `seo-*` from matching `seoengine-*`).
  const prefix = sanitizeBackupInstanceName(instance.name).toLowerCase() + '-';
  if (!filename.toLowerCase().startsWith(prefix)) {
    return NextResponse.json(
      { error: `Filename does not belong to instance "${instance.name}"` },
      { status: 403 },
    );
  }

  const requestedPath = path.join(BACKUPS_DIR, filename);

  // Canonical-path containment check (belt-and-braces against symlinks).
  // BACKUPS_DIR itself should exist — realpath it so trailing slashes and
  // relative segments are normalized before the prefix compare.
  let canonicalBackupsDir: string;
  let canonicalPath: string;
  try {
    canonicalBackupsDir = await realpath(BACKUPS_DIR);
    canonicalPath = await realpath(requestedPath);
  } catch {
    return NextResponse.json({ error: 'Backup file not found' }, { status: 404 });
  }
  const backupsDirWithSep = canonicalBackupsDir.endsWith(path.sep)
    ? canonicalBackupsDir
    : canonicalBackupsDir + path.sep;
  if (!canonicalPath.startsWith(backupsDirWithSep)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  // Stat to get the size for Content-Length + to confirm it's a regular file.
  let fileSize: number;
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile()) {
      return NextResponse.json({ error: 'Backup is not a regular file' }, { status: 400 });
    }
    fileSize = info.size;
  } catch {
    return NextResponse.json({ error: 'Backup file not found' }, { status: 404 });
  }

  // Stream the file body instead of buffering the whole thing into memory —
  // dumps can be tens of MB and we want to avoid a heap spike.
  const fileHandle = await open(canonicalPath, 'r');
  const nodeReadable = fileHandle.createReadStream();
  // Convert Node Readable → Web ReadableStream for NextResponse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webStream = (require('stream').Readable as any).toWeb(nodeReadable) as ReadableStream;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/sql',
      'Content-Length': String(fileSize),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-cache, no-store, must-revalidate',
    },
  });
});
