/**
 * GET /api/kb?file=<relative-path>
 *
 * Reads a file from data/central-knowledge-base/ and returns its content.
 * The `file` param is a relative path without extension, e.g. "platform/devflow-systems-tab".
 * A ".md" extension is appended automatically.
 *
 * Security: path is resolved and validated to stay within the KB root.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';

const KB_ROOT = appPath('data', 'central-knowledge-base');

export const GET = tracked('/api/kb', async (req: NextRequest) => {
  const authDenied = await requireAuthOrLocal(req, 'read');
  if (authDenied) return authDenied;

  const file = req.nextUrl.searchParams.get('file');

  if (!file || typeof file !== 'string' || file.trim() === '') {
    return NextResponse.json({ success: false, error: 'file parameter is required' }, { status: 400 });
  }

  // Resolve to absolute path (appending .md if not already present)
  const withExt = file.endsWith('.md') ? file : `${file}.md`;
  const resolved = path.resolve(KB_ROOT, withExt);

  // Prevent path traversal — must stay within KB_ROOT
  if (!resolved.startsWith(KB_ROOT + path.sep) && resolved !== KB_ROOT) {
    return NextResponse.json({ success: false, error: 'Invalid file path' }, { status: 400 });
  }

  try {
    const content = await fs.readFile(resolved, 'utf-8');
    return NextResponse.json({ content });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return NextResponse.json({ success: false, error: `File not found: ${file}` }, { status: 404 });
    }
    console.error('[api/kb] Failed to read KB file:', resolved, err);
    return NextResponse.json({ success: false, error: 'Failed to read file' }, { status: 500 });
  }
});
