import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';

const CONFIG_PATH = appPath('config', 'projects.json');

interface RegisterRequest {
  path: string;
}

interface RegisterResponse {
  registered: boolean;
  message: string;
}

async function getConfig() {
  const content = await fs.readFile(CONFIG_PATH, 'utf-8');
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${err instanceof Error ? err.message : err}`);
  }
}

async function saveConfig(config: Record<string, unknown>) {
  await withFileLock(CONFIG_PATH, async () => {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  });
}

// GET /api/claude/loops/register?path=/some/path
// Check if a path is already registered
export const GET = tracked('/api/claude/loops/register', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = request.nextUrl;
    const checkPath = searchParams.get('path');

    if (!checkPath) {
      return NextResponse.json({ success: false, error: 'Missing path parameter' }, { status: 400 });
    }

    const config = await getConfig();
    const watchPaths: string[] = config.loopsConfig?.watchPaths || [];
    const isRegistered = watchPaths.includes(checkPath);

    return NextResponse.json({
      registered: isRegistered,
      path: checkPath
    });
  } catch (error) {
    console.error('Error checking registration:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to check registration' },
      { status: 500 }
    );
  }
});

// POST /api/claude/loops/register
// Register a new path for loop monitoring
export const POST = tracked('/api/claude/loops/register', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body: RegisterRequest = await request.json();

    if (!body.path) {
      return NextResponse.json(
        { success: false, error: 'Missing path in request body' },
        { status: 400 }
      );
    }

    // Normalize path (remove trailing slash)
    const normalizedPath = body.path.replace(/\/+$/, '');

    // Validate path exists
    try {
      await fs.access(normalizedPath);
    } catch {
      return NextResponse.json(
        { success: false, error: `Invalid path: directory does not exist` },
        { status: 400 }
      );
    }

    const config = await getConfig();

    // Ensure loopsConfig exists
    if (!config.loopsConfig) {
      config.loopsConfig = { watchPaths: [], historyLimit: 20 };
    }
    if (!config.loopsConfig.watchPaths) {
      config.loopsConfig.watchPaths = [];
    }

    const watchPaths: string[] = config.loopsConfig.watchPaths;

    // Check if already registered
    if (watchPaths.includes(normalizedPath)) {
      return NextResponse.json<RegisterResponse>({
        registered: false,
        message: 'Path already registered'
      });
    }

    // Add path
    watchPaths.push(normalizedPath);
    await saveConfig(config);

    return NextResponse.json<RegisterResponse>({
      registered: true,
      message: 'Path added to watchPaths'
    });
  } catch (error) {
    console.error('Error registering path:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to register path' },
      { status: 500 }
    );
  }
});
