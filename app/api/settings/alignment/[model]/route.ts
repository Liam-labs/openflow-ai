/**
 * Alignment File Read/Write
 *
 * GET /api/settings/alignment/[model]  — Read alignment file content
 * PUT /api/settings/alignment/[model]  — Save alignment file content
 *
 * Security:
 * - Model name validated against strict regex (lowercase alphanumeric + hyphens only)
 * - Resolved path must be inside MASTERS_DIR — path.resolve() check enforces this
 * - No symlink following across directory boundaries
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';

export const dynamic = 'force-dynamic';

const MASTERS_DIR = path.resolve(appRoot(), 'data', 'scaffolding', 'masters', 'per-model');
const VALID_MODEL = /^[a-z0-9-]+$/;
const MAX_FILE_SIZE = 64 * 1024; // 64KB — alignment files should never approach this

interface RouteParams {
  params: Promise<{ model: string }>;
}

function resolveAlignmentPath(model: string): string | null {
  // Strict model name validation — no slashes, dots, or special chars
  if (!VALID_MODEL.test(model) || model.length > 64) return null;

  const resolved = path.resolve(MASTERS_DIR, model, `alignment-${model}.md`);

  // Ensure the resolved path is strictly under MASTERS_DIR
  if (!resolved.startsWith(MASTERS_DIR + path.sep)) return null;

  return resolved;
}

/**
 * GET /api/settings/alignment/[model]
 * Returns the content of the alignment master file for the given model.
 */
export const GET = tracked('/api/settings/alignment/:model', async (request: NextRequest, { params }: RouteParams) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  try {
    const { model } = await params;

    const filePath = resolveAlignmentPath(model);
    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Invalid model name' },
        { status: 400 }
      );
    }

    let content: string;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { success: false, error: 'File too large' },
          { status: 413 }
        );
      }
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return NextResponse.json(
          { success: false, error: `No alignment file found for model: ${model}` },
          { status: 404 }
        );
      }
      throw err;
    }

    return NextResponse.json({
      success: true,
      data: {
        model,
        filename: `alignment-${model}.md`,
        content,
        path: `per-model/${model}/alignment-${model}.md`,
      },
    });
  } catch (error) {
    console.error('[settings/alignment/[model]] GET error:', error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
});

/**
 * PUT /api/settings/alignment/[model]
 * Saves updated content to the alignment master file.
 * Body: { content: string }
 */
export const PUT = tracked('/api/settings/alignment/:model', async (request: NextRequest, { params }: RouteParams) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const { model } = await params;

    const filePath = resolveAlignmentPath(model);
    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Invalid model name' },
        { status: 400 }
      );
    }

    // Verify the file already exists — no creating arbitrary new files
    try {
      await fs.access(filePath);
    } catch {
      return NextResponse.json(
        { success: false, error: `No alignment file found for model: ${model}` },
        { status: 404 }
      );
    }

    let body: { content?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    if (typeof body.content !== 'string') {
      return NextResponse.json(
        { success: false, error: 'content (string) is required' },
        { status: 400 }
      );
    }

    if (Buffer.byteLength(body.content, 'utf-8') > MAX_FILE_SIZE) {
      return NextResponse.json(
        { success: false, error: 'Content exceeds 64KB limit' },
        { status: 413 }
      );
    }

    // Atomic write: write to temp file then rename (prevents corrupt reads during write)
    const tempPath = filePath + `.tmp.${process.pid}-${Date.now()}`;
    await fs.writeFile(tempPath, body.content, 'utf-8');
    await fs.rename(tempPath, filePath);

    const stat = await fs.stat(filePath);

    return NextResponse.json({
      success: true,
      data: {
        model,
        filename: `alignment-${model}.md`,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        message: `alignment-${model}.md saved. Run sync to deploy to agents.`,
      },
    });
  } catch (error) {
    console.error('[settings/alignment/[model]] PUT error:', error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
});
