/**
 * Alignment File List
 *
 * GET /api/settings/alignment
 * Returns all alignment master files with metadata (model, path, last modified).
 * Restricted to ~/DevFlow/data/scaffolding/masters/per-model/ — no traversal possible.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const MASTERS_DIR = appPath('data', 'scaffolding', 'masters', 'per-model');

interface AlignmentFile {
  model: string;
  filename: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export const GET = tracked('/api/settings/alignment', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const entries: AlignmentFile[] = [];

    // Enumerate model directories — each subdir is a model (claude, gemini, grok…)
    let modelDirs: string[];
    try {
      modelDirs = await fs.readdir(MASTERS_DIR);
    } catch {
      return NextResponse.json({ success: true, data: { files: [] } });
    }

    for (const model of modelDirs) {
      // Only include lowercase alphanumeric model names — prevents traversal
      if (!/^[a-z0-9-]+$/.test(model)) continue;

      const modelDir = path.join(MASTERS_DIR, model);
      const stat = await fs.stat(modelDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const alignmentFile = `alignment-${model}.md`;
      const filePath = path.join(modelDir, alignmentFile);
      const fileStat = await fs.stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;

      entries.push({
        model,
        filename: alignmentFile,
        path: `per-model/${model}/${alignmentFile}`,
        sizeBytes: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
      });
    }

    // Sort alphabetically by model name
    entries.sort((a, b) => a.model.localeCompare(b.model));

    return NextResponse.json({ success: true, data: { files: entries } });
  } catch (error) {
    console.error('[settings/alignment] GET error:', error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
});
