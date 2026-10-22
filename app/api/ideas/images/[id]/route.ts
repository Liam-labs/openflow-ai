import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { tracked } from '@/lib/api-tracking';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

const IMAGES_DIR = DataPaths.ideaImages;

export const GET = tracked('/api/ideas/images/:id', async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const { id } = await params;

    // Sanitize filename to prevent path traversal
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeId || safeId !== id) {
      return NextResponse.json({ success: false, error: 'Invalid image ID' }, { status: 400 });
    }

    const filePath = path.join(IMAGES_DIR, safeId);

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
    }

    const data = await fs.readFile(filePath);

    // Determine content type from extension
    const ext = path.extname(safeId).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
    };

    // SVG intentionally excluded — serves with script execution risk
    const contentType = contentTypes[ext] || 'application/octet-stream';

    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    console.error('[Idea Images] Error serving image:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
});
