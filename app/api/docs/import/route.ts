import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';
import { importPathAllowed } from '@/lib/docs-import-path';

export const dynamic = 'force-dynamic';

/**
 * POST /api/docs/import - Read a file from filesystem path
 * Used for importing existing documents into the docs library
 */
export const POST = tracked('/api/docs/import', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const { path: filePath } = body as { path: string };

    if (!filePath) {
      return NextResponse.json(
        { error: 'File path is required' },
        { status: 400 }
      );
    }

    // Expand home directory if needed
    let resolvedPath = filePath;
    if (resolvedPath.startsWith('~')) {
      resolvedPath = resolvedPath.replace('~', getHomeDir());
    }

    // Resolve relative paths
    if (!path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(appRoot(), resolvedPath);
    }

    // Security: decide on the real path (symlinks and ".." followed), so a visible-looking path cannot reach a hidden folder.
    let realPath: string;
    let roots: { home: string; app: string };
    try {
      roots = { home: await fs.promises.realpath(getHomeDir()), app: await fs.promises.realpath(appRoot()) };
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    try {
      realPath = await fs.promises.realpath(resolvedPath);
    } catch {
      // Missing file: refuse a forbidden location the same way as an existing one, so the answer does not reveal what exists there.
      return importPathAllowed(path.resolve(resolvedPath), roots)
        ? NextResponse.json({ error: 'File not found' }, { status: 404 })
        : NextResponse.json({ error: 'Access to this path is not allowed' }, { status: 403 });
    }
    if (!importPathAllowed(realPath, roots)) {
      return NextResponse.json(
        { error: 'Access to this path is not allowed' },
        { status: 403 }
      );
    }

    // Check if the file exists and get its metadata
    let stats: Awaited<ReturnType<typeof fs.promises.stat>>;
    try {
      stats = await fs.promises.stat(realPath);
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Check if it's a file (not directory)
    if (!stats.isFile()) {
      return NextResponse.json(
        { error: 'Path is not a file' },
        { status: 400 }
      );
    }

    // Check file size (max 1MB)
    if (stats.size > 1024 * 1024) {
      return NextResponse.json(
        { error: 'File is too large (max 1MB)' },
        { status: 400 }
      );
    }

    // Check file extension
    const ext = path.extname(realPath).toLowerCase();
    const validExtensions = ['.md', '.txt', '.markdown'];
    if (!validExtensions.includes(ext)) {
      return NextResponse.json(
        { error: 'Invalid file type. Supported: .md, .txt, .markdown' },
        { status: 400 }
      );
    }

    // Read file content
    const content = await fs.promises.readFile(realPath, 'utf-8');
    const filename = path.basename(resolvedPath);

    // Try to parse frontmatter if it exists
    let parsedTitle = '';
    let parsedTags: string[] = [];
    let mainContent = content;

    try {
      const { data, content: bodyContent } = matter(content);
      if (data.title) parsedTitle = data.title;
      if (data.tags && Array.isArray(data.tags)) parsedTags = data.tags;
      mainContent = bodyContent;
    } catch {
      // If no frontmatter, use raw content
    }

    // Generate title from filename if not found in frontmatter
    if (!parsedTitle) {
      parsedTitle = filename
        .replace(/\.(md|txt|markdown)$/i, '')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }

    return NextResponse.json({
      success: true,
      filename,
      title: parsedTitle,
      tags: parsedTags,
      content: mainContent,
      originalPath: resolvedPath,
      size: stats.size
    });
  } catch (error) {
    console.error('Import error:', error);
    return NextResponse.json(
      { error: 'Failed to read file' },
      { status: 500 }
    );
  }
});
