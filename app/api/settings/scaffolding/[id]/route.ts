/**
 * Scaffolding File Content — Read + Write
 *
 * GET /api/settings/scaffolding/[id]   — returns file content
 * PUT /api/settings/scaffolding/[id]   — saves file content
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

export const dynamic = 'force-dynamic';

const DEVFLOW_DIR = appRoot();
const MASTERS_DIR = path.join(DEVFLOW_DIR, 'data', 'scaffolding', 'masters');
const MANIFEST_PATH = path.join(DEVFLOW_DIR, 'data', 'scaffolding', 'manifest.json');
const HOME = getHomeDir();

/** Hardcoded global-rules ID → absolute path map (must match route.ts) */
const GLOBAL_RULES_MAP: Record<string, string> = {
  'user-claude-md':       `${HOME}/.claude/CLAUDE.md`,
  'devflow-claude-md':    `${DEVFLOW_DIR}/CLAUDE.md`,
};

async function resolveIdToPath(id: string): Promise<string | null> {
  // Check global-rules first
  if (GLOBAL_RULES_MAP[id]) return GLOBAL_RULES_MAP[id];

  // Check manifest
  try {
    const manifest: { files: Array<{ id: string; master: string }> } =
      JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf-8'));
    const entry = manifest.files.find(f => f.id === id);
    if (entry) return path.join(MASTERS_DIR, entry.master);
  } catch { /* manifest missing */ }

  return null;
}

function isAllowedPath(p: string): boolean {
  return p.startsWith('/home/') || p.startsWith(DEVFLOW_DIR);
}

export const GET = tracked('/api/settings/scaffolding/:id', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { id } = await params;
    const filePath = await resolveIdToPath(id);
    if (!filePath) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }
    if (!isAllowedPath(filePath)) {
      return NextResponse.json({ success: false, error: 'Access restricted' }, { status: 403 });
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      content = '';
    }

    return NextResponse.json({ success: true, content });
  } catch (error) {
    console.error('[settings/scaffolding/[id]] GET error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});

export const PUT = tracked('/api/settings/scaffolding/:id', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const { id } = await params;
    const filePath = await resolveIdToPath(id);
    if (!filePath) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }
    if (!isAllowedPath(filePath)) {
      return NextResponse.json({ success: false, error: 'Access restricted' }, { status: 403 });
    }

    const body = await request.json() as { content?: string };
    if (typeof body.content !== 'string') {
      return NextResponse.json({ success: false, error: 'content is required' }, { status: 400 });
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body.content, 'utf-8');

    const stat = await fs.stat(filePath);
    return NextResponse.json({
      success: true,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  } catch (error) {
    console.error('[settings/scaffolding/[id]] PUT error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
});
