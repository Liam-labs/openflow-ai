import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getProjectById } from '@/lib/config';
import { ImageInfo } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/images/scan', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  return NextResponse.json(
    { success: false, error: 'Method not allowed. This endpoint only supports POST.' },
    { status: 405, headers: { Allow: 'POST' } }
  );
});

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tiff'];

async function scanDirectory(dir: string, baseDir: string): Promise<ImageInfo[]> {
  const images: ImageInfo[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip node_modules, .git, and other common non-image directories
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '.next', 'dist', 'build', '.cache'].includes(entry.name)) {
          continue;
        }
        // Recursively scan subdirectories
        const subImages = await scanDirectory(fullPath, baseDir);
        images.push(...subImages);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTENSIONS.includes(ext)) {
          try {
            const stats = await fs.stat(fullPath);
            const metadata = await sharp(fullPath).metadata();

            images.push({
              path: fullPath,
              relativePath: path.relative(baseDir, fullPath),
              filename: entry.name,
              size: stats.size,
              width: metadata.width || 0,
              height: metadata.height || 0,
              format: metadata.format || ext.slice(1),
            });
          } catch (err) {
            // Skip files that can't be read by sharp
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning directory ${dir}:`, err);
  }

  return images;
}

export const POST = tracked('/api/images/scan', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { projectId, subPath } = body as { projectId: string; subPath?: string };

    if (!projectId) {
      return NextResponse.json({ success: false, error: 'Project ID is required' }, { status: 400 });
    }

    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const scanPath = subPath
      ? path.join(project.path, subPath)
      : project.path;

    // Path traversal guard: scanPath must resolve within project.path
    const resolvedScan = path.resolve(scanPath);
    const resolvedProject = path.resolve(project.path);
    if (!resolvedScan.startsWith(resolvedProject + path.sep) && resolvedScan !== resolvedProject) {
      return NextResponse.json({ success: false, error: 'subPath must be within project directory' }, { status: 403 });
    }

    // Verify the path exists
    try {
      await fs.access(scanPath);
    } catch {
      return NextResponse.json({ success: false, error: 'Path does not exist' }, { status: 404 });
    }

    const images = await scanDirectory(scanPath, project.path);

    // Sort by size (largest first)
    images.sort((a, b) => b.size - a.size);

    const totalSize = images.reduce((sum, img) => sum + img.size, 0);

    return NextResponse.json({
      success: true,
      projectPath: project.path,
      scanPath,
      images,
      totalCount: images.length,
      totalSize,
      totalSizeFormatted: formatBytes(totalSize),
    });
  } catch (error) {
    console.error('Image scan error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to scan for images' },
      { status: 500 }
    );
  }
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
