import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const GET = tracked('/api/claude/loops/screenshot', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const { searchParams } = request.nextUrl;
  const projectPath = searchParams.get('project');
  const screenshotPath = searchParams.get('path');

  if (!projectPath || !screenshotPath) {
    return NextResponse.json(
      { error: 'Missing required parameters: project and path' },
      { status: 400 }
    );
  }

  // Security: Ensure the screenshot path is within the project's .claude directory
  const normalizedScreenshotPath = path.normalize(screenshotPath);
  if (!normalizedScreenshotPath.startsWith('.claude/ralph-screenshots/')) {
    return NextResponse.json(
      { error: 'Invalid screenshot path' },
      { status: 400 }
    );
  }

  const fullPath = path.join(projectPath, normalizedScreenshotPath);

  // Additional security: Ensure resolved path is within project directory
  const resolvedPath = path.resolve(fullPath);
  const resolvedProjectPath = path.resolve(projectPath);
  if (!resolvedPath.startsWith(resolvedProjectPath)) {
    return NextResponse.json(
      { error: 'Path traversal not allowed' },
      { status: 403 }
    );
  }

  try {
    const imageBuffer = await fs.readFile(fullPath);

    // Determine content type based on extension
    const ext = path.extname(fullPath).toLowerCase();
    let contentType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg';
    } else if (ext === '.webp') {
      contentType = 'image/webp';
    }

    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json(
        { error: 'Screenshot not found' },
        { status: 404 }
      );
    }
    console.error('Error reading screenshot:', error);
    return NextResponse.json(
      { error: 'Failed to read screenshot' },
      { status: 500 }
    );
  }
});
