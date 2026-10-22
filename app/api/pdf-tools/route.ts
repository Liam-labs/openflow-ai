import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { getHomeDir } from '@/lib/home-dir';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

const HOME = getHomeDir();
const PDF_EDITOR_DIR = `${HOME}/PDF-Editing`;
const UV_PATH = `${HOME}/.local/bin/uv`;
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdf-editor-uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'pdf-editor-outputs');

// Ensure temp dirs exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function isAllowedPdfPath(p: string): boolean {
  const resolved = path.resolve(p);
  // Restrict to upload and output dirs only — prevents reading arbitrary files under HOME
  return (
    resolved.startsWith(UPLOAD_DIR + path.sep) ||
    resolved.startsWith(OUTPUT_DIR + path.sep) ||
    resolved === UPLOAD_DIR ||
    resolved === OUTPUT_DIR
  );
}

async function callPdfCli(command: string, args: Record<string, unknown>): Promise<unknown> {
  // Use execFile with array args — no shell, no injection
  const { stdout, stderr } = await execFileAsync(
    UV_PATH,
    ['run', '--directory', PDF_EDITOR_DIR, 'python', '-m', 'pdf_editor.cli', command, JSON.stringify(args)],
    { timeout: 30000 }
  );
  if (stderr && !stdout) {
    throw new Error(stderr);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`PDF CLI returned invalid JSON: ${stdout.slice(0, 200)}`);
  }
}

/**
 * POST /api/pdf-tools — Unified endpoint for PDF operations
 *
 * Actions:
 *   upload   — Accepts multipart form data with a PDF file
 *   analyze  — Analyze a previously uploaded PDF
 *   fill     — Fill a form with field values
 *   read     — Extract text from a PDF
 */
export const POST = tracked('/api/pdf-tools', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const contentType = request.headers.get('content-type') || '';

    // Handle file upload (multipart)
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      }

      if (!file.name.toLowerCase().endsWith('.pdf')) {
        return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 });
      }

      // 50MB limit
      if (file.size > 50 * 1024 * 1024) {
        return NextResponse.json({ error: 'File too large (max 50MB)' }, { status: 400 });
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const filename = `upload_${randomUUID()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const filepath = path.join(UPLOAD_DIR, filename);
      await fs.promises.writeFile(filepath, buffer);

      return NextResponse.json({
        success: true,
        filename: file.name,
        path: filepath,
        size: file.size,
      });
    }

    // Handle JSON actions
    const body = await request.json();
    const { action, ...params } = body;

    switch (action) {
      case 'analyze': {
        if (!params.path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }
        if (!isAllowedPdfPath(params.path as string)) {
          return NextResponse.json({ error: 'Access to this path is not allowed' }, { status: 403 });
        }
        const result = await callPdfCli('analyze', { path: params.path });
        return NextResponse.json({ success: true, data: result });
      }

      case 'fill': {
        if (!params.path || !params.fields) {
          return NextResponse.json(
            { error: 'path and fields are required' },
            { status: 400 }
          );
        }
        if (!isAllowedPdfPath(params.path as string)) {
          return NextResponse.json({ error: 'Access to this path is not allowed' }, { status: 403 });
        }
        const outputFilename = `filled_${randomUUID()}.pdf`;
        const outputPath = path.join(OUTPUT_DIR, outputFilename);

        const result = await callPdfCli('fill', {
          path: params.path,
          fields: params.fields,
          output_path: outputPath,
          fontsize: params.fontsize || 10,
          color: params.color || 'black',
          overwrite: true,
        });
        return NextResponse.json({
          success: true,
          data: result,
          download_url: `/api/pdf-tools?download=${outputFilename}`,
        });
      }

      case 'read': {
        if (!params.path) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }
        if (!isAllowedPdfPath(params.path as string)) {
          return NextResponse.json({ error: 'Access to this path is not allowed' }, { status: 403 });
        }
        const result = await callPdfCli('read', {
          path: params.path,
          pages: params.pages || null,
        });
        return NextResponse.json({ success: true, data: result });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid: analyze, fill, read` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('PDF tools error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

/**
 * GET /api/pdf-tools?download=filename — Download a filled PDF
 */
export const GET = tracked('/api/pdf-tools', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const filename = request.nextUrl.searchParams.get('download');

  if (!filename) {
    return NextResponse.json(
      { error: 'Use ?download=filename to download a file' },
      { status: 400 }
    );
  }

  // Security: only allow alphanumeric, dots, underscores, hyphens
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  const filepath = path.join(OUTPUT_DIR, filename);
  let buffer: Buffer<ArrayBuffer>;
  try {
    buffer = await fs.promises.readFile(filepath) as Buffer<ArrayBuffer>;
  } catch {
    return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
  }
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    },
  });
});
