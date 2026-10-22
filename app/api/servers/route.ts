import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getProjectById } from '@/lib/config';
import { ServerStatus } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

const execAsync = promisify(exec);

const PM2_EXEC_TIMEOUT_MS = 30000;   // pm2 command execution
const STOP_EXEC_TIMEOUT_MS = 15000;  // stop command
const SERVER_START_WAIT_MS = 3000;   // wait for server to bind port after start

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/servers', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const searchParams = request.nextUrl.searchParams;
  const projectId = searchParams.get('projectId');

  if (projectId) {
    const status = await getServerStatus(projectId);
    return NextResponse.json(status);
  }

  return NextResponse.json({ statuses: [] });
});

export const POST = tracked('/api/servers', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { action, projectId } = body as { action: 'start' | 'stop'; projectId: string };

    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    if (!project.server) {
      return NextResponse.json(
        { success: false, error: 'Project does not have server configuration' },
        { status: 400 }
      );
    }

    if (action === 'start') {
      return await startServer(
        projectId,
        project.path,
        project.server.startCommand,
        project.server.port
      );
    } else if (action === 'stop') {
      return await stopServer(
        projectId,
        project.path,
        project.server.stopCommand,
        project.server.port
      );
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Server control error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to control server' },
      { status: 500 }
    );
  }
});

async function getServerStatus(projectId: string): Promise<ServerStatus> {
  const project = await getProjectById(projectId);
  if (!project?.server?.port) {
    return { projectId, isRunning: false };
  }

  const port = project.server.port;
  const isRunning = await isPortInUse(port);

  // Try to get PID from port
  let pid: number | undefined;
  if (isRunning) {
    try {
      const { stdout } = await execAsync(`lsof -ti:${port} 2>/dev/null | head -1`);
      pid = parseInt(stdout.trim(), 10) || undefined;
    } catch {
      // Ignore
    }
  }

  return {
    projectId,
    isRunning,
    pid,
    port,
  };
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    // Check with lsof first (more reliable)
    const { stdout } = await execAsync(
      `lsof -i:${port} -sTCP:LISTEN -t 2>/dev/null`
    );
    return stdout.trim().length > 0;
  } catch {
    // Try ss as fallback
    try {
      const { stdout } = await execAsync(
        `ss -tln 2>/dev/null | grep -q ":${port} " && echo "yes" || echo "no"`
      );
      return stdout.trim() === 'yes';
    } catch {
      return false;
    }
  }
}

async function startServer(
  projectId: string,
  cwd: string,
  command: string,
  port: number
): Promise<NextResponse> {
  // Check if port is already in use
  if (await isPortInUse(port)) {
    return NextResponse.json(
      { success: false, error: `Port ${port} is already in use`, alreadyRunning: true },
      { status: 409 }
    );
  }

  try {
    // startCommand is sourced from the registered project config (not from the request body).
    // Access is gated behind requireAuthOrLocal(write) — modifying the config also requires auth.
    const fullCommand = `cd "${cwd}" && ${command}`;

    // Execute the command - for PM2 commands this will return quickly
    // For other commands we run in background with nohup
    if (command.includes('pm2')) {
      // PM2 commands handle their own daemonization
      await execAsync(fullCommand, {
        timeout: PM2_EXEC_TIMEOUT_MS,
        env: { ...process.env, PORT: port.toString() },
      });
    } else {
      // For non-PM2 commands, run in background
      execAsync(`cd "${cwd}" && nohup ${command} > /dev/null 2>&1 &`, {
        env: { ...process.env, PORT: port.toString() },
      }).catch(() => {
        // Ignore - command runs in background
      });
    }

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, SERVER_START_WAIT_MS));

    // Check if it's now running
    const isRunning = await isPortInUse(port);

    if (isRunning) {
      return NextResponse.json({
        success: true,
        port,
        message: `Server started on port ${port}`,
      });
    } else {
      return NextResponse.json({
        success: false,
        message: 'Server may still be starting, check status in a moment',
      });
    }
  } catch (error) {
    console.error('Start server error:', error);
    return NextResponse.json(
      { success: false, error: `Failed to start server: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

async function stopServer(
  projectId: string,
  cwd: string,
  stopCommand: string | undefined,
  port: number
): Promise<NextResponse> {
  try {
    // If there's a custom stop command (like pm2:stop), use it
    if (stopCommand) {
      const fullCommand = `cd "${cwd}" && ${stopCommand}`;
      try {
        await execAsync(fullCommand, { timeout: STOP_EXEC_TIMEOUT_MS });
      } catch (error) {
        console.error('Stop command error:', error);
      }
    }

    // Also try to kill by port as fallback
    try {
      await execAsync(`fuser -k ${port}/tcp 2>/dev/null`);
    } catch {
      // Try lsof method
      try {
        const { stdout } = await execAsync(`lsof -ti:${port} 2>/dev/null`);
        const pids = stdout.trim().split('\n').filter(Boolean);
        for (const pid of pids) {
          await execAsync(`kill -15 ${pid} 2>/dev/null`).catch(() => {});
          // Give it a moment to gracefully shutdown
          await new Promise((resolve) => setTimeout(resolve, 500));
          // Force kill if still running
          await execAsync(`kill -9 ${pid} 2>/dev/null`).catch(() => {});
        }
      } catch {
        // Port might already be free
      }
    }

    // Wait for port to be released
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const stillRunning = await isPortInUse(port);

    return NextResponse.json({
      success: !stillRunning,
      message: stillRunning
        ? 'Server may still be stopping'
        : `Server on port ${port} stopped`,
    });
  } catch (error) {
    console.error('Stop server error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to stop server' },
      { status: 500 }
    );
  }
}
