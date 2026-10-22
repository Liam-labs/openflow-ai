import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

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

    // Security: restrict to safe roots.
    // Allowed: DevFlow project dir (process.cwd()) or non-hidden, non-sensitive home subdirs.
    // Blocked: hidden dirs, known-sensitive non-hidden dirs, anything outside HOME or cwd.
    const SENSITIVE_DIRS = new Set(['secrets', 'credentials', 'private', 'keys', 'certs', 'tokens', 'vault']);
    const HOME = getHomeDir();
    const isUnderCwd = resolvedPath.startsWith(appRoot() + path.sep) || resolvedPath === appRoot();
    const isUnderHome = resolvedPath.startsWith(HOME + path.sep);
    const topDirUnderHome = isUnderHome
      ? resolvedPath.slice(HOME.length + 1).split(path.sep)[0]
      : '';
    const isNonHiddenHomeSubdir = isUnderHome
      && topDirUnderHome !== ''
      && !topDirUnderHome.startsWith('.')
      && !SENSITIVE_DIRS.has(topDirUnderHome.toLowerCase());

    if (!isUnderCwd && !isNonHiddenHomeSubdir) {
      return NextResponse.json(
        { error: 'Access to this path is not allowed' },
        { status: 403 }
      );
    }

    // Check if file exists and get metadata
    let stats: Awaited<ReturnType<typeof fs.promises.stat>>;
    try {
      stats = await fs.promises.stat(resolvedPath);
    } catch {
      return NextResponse.json(
        { error: `File not found: ${resolvedPath}` },
        { status: 404 }
      );
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
    const ext = path.extname(resolvedPath).toLowerCase();
    const validExtensions = ['.md', '.txt', '.markdown'];
    if (!validExtensions.includes(ext)) {
      return NextResponse.json(
        { error: 'Invalid file type. Supported: .md, .txt, .markdown' },
        { status: 400 }
      );
    }

    // Read file content
    const content = await fs.promises.readFile(resolvedPath, 'utf-8');
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
