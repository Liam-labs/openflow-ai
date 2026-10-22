/**
 * POST /api/setup/generate-install
 *
 * Generates a host-bridge install command/script tailored to the user's config.
 * Returns the shell command the user should run on their host machine.
 *
 * Body: { port?: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appPath, appRoot } from '@/lib/app-paths';

interface GenerateInstallRequest {
  port?: number;
}

interface GenerateInstallResponse {
  success: boolean;
  installCommand: string;
  downloadUrl: string;
  token: string;
  port: number;
  error?: string;
}

export const POST = tracked('/api/setup/generate-install', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;
  try {
    const body: GenerateInstallRequest = await request.json();
    const port = body.port === undefined || body.port === null ? 3001 : body.port;
    // The port is written into a command the user is told to run, so it must be a plain port number and nothing else.
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return NextResponse.json({ success: false, error: 'port must be a whole number from 1 to 65535' }, { status: 400 });
    }

    // Generate a secure bridge token
    const token = crypto.randomBytes(32).toString('hex');

    // The install command uses the existing install.sh from the host-bridge directory
    const devflowHome = appRoot();
    const installScript = path.join(devflowHome, 'host-bridge', 'install.sh');

    // Check if install script exists
    let scriptExists = false;
    try {
      await fs.access(installScript);
      scriptExists = true;
    } catch {
      // Script not found — Docker mode, need to generate inline
    }

    let installCommand: string;

    if (scriptExists) {
      // Local mode: run the existing install script with environment vars
      installCommand = [
        `HOST_BRIDGE_TOKEN="${token}"`,
        `HOST_BRIDGE_PORT=${port}`,
        `bash ${installScript}`,
      ].join(' ');
    } else {
      // Docker mode: generate a standalone command
      installCommand = [
        `HOST_BRIDGE_TOKEN="${token}"`,
        `HOST_BRIDGE_PORT=${port}`,
        `DEVFLOW_HOME="${devflowHome}"`,
        `bash <(curl -fsSL http://localhost:3000/api/setup/generate-install?download=1)`,
      ].join(' \\\n  ');
    }

    const response: GenerateInstallResponse = {
      success: true,
      installCommand,
      downloadUrl: `/api/setup/generate-install?download=1`,
      token,
      port,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[Setup generate-install] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message } as Partial<GenerateInstallResponse>,
      { status: 500 }
    );
  }
});

/**
 * GET /api/setup/generate-install?download=1
 *
 * Returns the install.sh script content for download.
 */
export const GET = tracked('/api/setup/generate-install', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;

  const { searchParams } = new URL(request.url);

  if (searchParams.get('download') !== '1') {
    return NextResponse.json({ error: 'Use POST to generate install command, or GET ?download=1 for script' }, { status: 400 });
  }

  try {
    const scriptPath = appPath('host-bridge', 'install.sh');
    const content = await fs.readFile(scriptPath, 'utf-8');

    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/x-shellscript',
        'Content-Disposition': 'attachment; filename="install-host-bridge.sh"',
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Install script not found' },
      { status: 404 }
    );
  }
});
