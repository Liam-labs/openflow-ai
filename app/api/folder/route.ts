import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import { getProjectById, getProjects } from '@/lib/config';
import { tracked } from '@/lib/api-tracking';
import { requireTokenOrLocal } from '@/lib/api-auth';

import { getHomeDir } from '@/lib/home-dir';
const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

/**
 * GET /api/folder?path=~
 * Browse directories for the directory picker UI.
 * Also returns bookmark paths from config/projects.json.
 */
export const GET = tracked('/api/folder', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = new URL(request.url);
    const dirPath = searchParams.get('path') || getHomeDir();
    const includeBookmarks = searchParams.get('bookmarks') === 'true';

    // Security: restrict to /home/ paths to prevent arbitrary filesystem browsing
    const resolved = path.resolve(dirPath);
    if (!resolved.startsWith('/home/')) {
      return NextResponse.json({ error: 'Access restricted to /home/ paths' }, { status: 403 });
    }

    // Read directory entries
    let directories: string[] = [];
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      directories = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
    } catch (err) {
      return NextResponse.json({
        error: `Cannot read directory: ${resolved}`,
        path: resolved,
        directories: [],
      }, { status: 400 });
    }

    // Include project bookmarks if requested
    let bookmarks: Array<{ name: string; path: string }> = [];
    if (includeBookmarks) {
      try {
        const projects = await getProjects();
        bookmarks = projects
          .filter(p => p.path && p.path.startsWith('/'))
          .map(p => ({ name: p.name, path: p.path }));
      } catch { /* ignore */ }
    }

    return NextResponse.json({
      path: resolved,
      directories,
      bookmarks: includeBookmarks ? bookmarks : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to browse directory' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/folder
 * Open a folder in Windows Explorer from WSL.
 * Accepts either { projectId } to open a project folder,
 * or { path } to open any /home/ directory directly.
 */
export const POST = tracked('/api/folder', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { projectId, path: rawPath } = body as { projectId?: string; path?: string };

    let folderPath: string;
    let label: string;

    if (rawPath) {
      // Direct path mode — restricted to /home/ for security
      const resolved = path.resolve(rawPath);
      if (!resolved.startsWith('/home/')) {
        return NextResponse.json({ error: 'Access restricted to /home/ paths' }, { status: 403 });
      }
      folderPath = resolved;
      label = resolved;
    } else if (projectId) {
      // Project ID mode (original behavior)
      const project = await getProjectById(projectId);
      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      folderPath = project.path;
      label = project.name;
    } else {
      return NextResponse.json({ error: 'Either projectId or path is required' }, { status: 400 });
    }

    // Open folder in Windows Explorer from WSL (no shell — array args prevent injection)
    try {
      const { stdout: winPath } = await execFileAsync('wslpath', ['-w', folderPath]);
      execFile('explorer.exe', [winPath.trim()], (error) => {
        if (error) console.error('Error opening folder:', error);
      });
    } catch (err) {
      console.error('wslpath error:', err);
    }

    return NextResponse.json({
      success: true,
      message: `Opening ${label}`,
    });
  } catch (error) {
    console.error('Folder open error:', error);
    return NextResponse.json(
      { error: 'Failed to open folder' },
      { status: 500 }
    );
  }
});
