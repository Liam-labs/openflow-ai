import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import fs from 'fs/promises';
import path from 'path';
import { tracked } from '@/lib/api-tracking';
import { sanitizeDownloadFilename, buildContentDisposition } from '@/lib/download-filename';
import { appPath } from '@/lib/app-paths';

const IMAGES_DIR = appPath('.AppData', 'collab-images');

const METHOD_NOT_ALLOWED = NextResponse.json(
  { error: 'Method not allowed. This endpoint only supports GET.' },
  { status: 405, headers: { Allow: 'GET' } }
);

export const POST = tracked('/api/collab/images/:id', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;
 return METHOD_NOT_ALLOWED; });
export const PUT = tracked('/api/collab/images/:id', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;
 return METHOD_NOT_ALLOWED; });
export const DELETE = tracked('/api/collab/images/:id', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;
 return METHOD_NOT_ALLOWED; });
export const PATCH = tracked('/api/collab/images/:id', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;
 return METHOD_NOT_ALLOWED; });

export const GET = tracked('/api/collab/images/:id', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { id } = await params;

    // Sanitize filename to prevent path traversal
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeId || safeId !== id) {
      return NextResponse.json({ error: 'Invalid image ID' }, { status: 400 });
    }

    const filePath = path.join(IMAGES_DIR, safeId);

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 });
    }

    const data = await fs.readFile(filePath);

    // Determine content type from extension
    const ext = path.extname(safeId).toLowerCase();
    const contentTypes: Record<string, string> = {
      // Images
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
      // Documents
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
      '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.json': 'application/json', '.xml': 'application/xml',
      // Office
      '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      // Archives
      '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
      '.7z': 'application/x-7z-compressed', '.rar': 'application/x-rar-compressed',
      // Media
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';
    const isImage = contentType.startsWith('image/');

    // Scriptable content types that must never render inline (XSS prevention)
    const FORCE_DOWNLOAD_TYPES = new Set([
      'image/svg+xml', 'text/html', 'text/javascript', 'application/javascript',
      'text/css', 'application/xml', 'text/xml',
    ]);
    const forceDownload = !isImage || FORCE_DOWNLOAD_TYPES.has(contentType);

    const headers: Record<string, string> = {
      'Content-Type': forceDownload ? 'application/octet-stream' : contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    };

    // Non-image files and scriptable types get download disposition.
    // Honour ?name=<original> when the UI passes the user-visible filename;
    // sanitize it before it lands in the header. If absent or unsafe, omit
    // filename entirely and let the client-side `download` attr decide.
    if (forceDownload) {
      const requestedName = request.nextUrl.searchParams.get('name');
      const safeName = sanitizeDownloadFilename(requestedName);
      headers['Content-Disposition'] = buildContentDisposition(safeName);
    }

    return new NextResponse(data, { headers });
  } catch (error) {
    console.error('[Collab Images] Error serving image:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
