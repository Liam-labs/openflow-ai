import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getProjectById } from '@/lib/config';
import { tracked } from '@/lib/api-tracking';
import { requireTokenOrLocal } from '@/lib/api-auth';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

interface PM2ProcessInfo {
  name: string;
  pid?: number;
  pm2_env?: {
    status?: string;
    PORT?: string;
    port?: string;
    args?: string[];
    pm_uptime?: number;
  };
}

// Check if a specific port is in use
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`lsof -i:${port} -sTCP:LISTEN -t 2>/dev/null`);
    return stdout.trim().length > 0;
  } catch {
    // lsof returns non-zero if port is free
    return false;
  }
}

// Find an available port starting from a base port
async function findAvailablePort(startPort: number = 3000): Promise<number> {
  const usedPorts = new Set<number>();

  // Get all ports from PM2 processes
  try {
    const { stdout } = await execAsync('pm2 jlist 2>/dev/null');
    const processes = JSON.parse(stdout || '[]');

    for (const proc of processes) {
      // Check env for PORT (multiple possible locations)
      const envPort = proc.pm2_env?.PORT || proc.pm2_env?.port || proc.pm2_env?.env?.PORT;
      if (envPort) usedPorts.add(parseInt(envPort, 10));

      // Also check the process name for port patterns like "dev-xxx" that use sequential ports
      const nameMatch = proc.name?.match(/^dev-/);
      if (nameMatch && proc.pm2_env?.status === 'online') {
        // Try to extract port from args or command
        const args = proc.pm2_env?.args || [];
        const portArgIndex = args.indexOf('--port');
        if (portArgIndex !== -1 && args[portArgIndex + 1]) {
          usedPorts.add(parseInt(args[portArgIndex + 1], 10));
        }
      }
    }
  } catch {
    // PM2 not available
  }

  // Get system ports using ss (more reliable than lsof parsing)
  try {
    const { stdout: ssOutput } = await execAsync("ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | rev | cut -d: -f1 | rev");
    const systemPorts = ssOutput.split('\n').filter(Boolean).map(p => parseInt(p, 10)).filter(p => !isNaN(p));
    systemPorts.forEach(p => usedPorts.add(p));
  } catch {
    // ss not available, try netstat
    try {
      const { stdout: netstatOutput } = await execAsync("netstat -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | rev | cut -d: -f1 | rev");
      const netstatPorts = netstatOutput.split('\n').filter(Boolean).map(p => parseInt(p, 10)).filter(p => !isNaN(p));
      netstatPorts.forEach(p => usedPorts.add(p));
    } catch {
      // Fall back to checking ports individually
    }
  }

  // Find first available port, double-checking with lsof
  let port = startPort;
  while (port <= 65535) {
    if (!usedPorts.has(port)) {
      // Double-check this specific port
      const inUse = await isPortInUse(port);
      if (!inUse) {
        return port;
      }
      usedPorts.add(port);
    }
    port++;
  }

  throw new Error('No available ports found');
}

// GET - Check dev server status for a project
export const GET = tracked('/api/dev-server', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json({ error: 'Project ID required' }, { status: 400 });
    }

    const pm2Name = `dev-${projectId}`;

    try {
      const { stdout } = await execAsync('pm2 jlist');
      const processes = JSON.parse(stdout || '[]') as PM2ProcessInfo[];
      const devProcess = processes.find(p => p.name === pm2Name);

      if (devProcess) {
        // Try multiple ways to get the port
        let port = devProcess.pm2_env?.PORT || devProcess.pm2_env?.port;

        // Fallback: extract from args (looks like ['run', 'dev', '--', '--port', '3003'])
        if (!port) {
          const args = devProcess.pm2_env?.args || [];
          const portArgIndex = args.indexOf('--port');
          if (portArgIndex !== -1 && args[portArgIndex + 1]) {
            port = args[portArgIndex + 1];
          }
        }

        return NextResponse.json({
          running: devProcess.pm2_env?.status === 'online',
          port: port ? parseInt(port, 10) : null,
          pm2Name,
          pid: devProcess.pid,
          uptime: devProcess.pm2_env?.pm_uptime,
        });
      }
    } catch {
      // PM2 not running or no processes
    }

    return NextResponse.json({ running: false, pm2Name });
  } catch (error) {
    console.error('Dev server status error:', error);
    return NextResponse.json({ error: 'Failed to check status' }, { status: 500 });
  }
});

// POST - Start or stop dev server
export const POST = tracked('/api/dev-server', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { projectId, action } = body as { projectId: string; action: 'start' | 'stop' };

    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const pm2Name = `dev-${projectId}`;

    if (action === 'start') {
      // First, check if process already exists and delete it to avoid duplicates
      try {
        const { stdout: existingList } = await execAsync('pm2 jlist 2>/dev/null');
        const existingProcesses = JSON.parse(existingList || '[]') as PM2ProcessInfo[];
        const existing = existingProcesses.find(p => p.name === pm2Name);

        if (existing) {
          await execAsync(`pm2 delete "${pm2Name}" 2>/dev/null`);
          // Wait for cleanup
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch {
        // No existing process, continue
      }

      // Clean up stale Next.js dev lock file (prevents "is another instance running?" errors)
      const lockFile = `${project.path}/.next/dev/lock`;
      try {
        await execAsync(`rm -f "${lockFile}" 2>/dev/null`);
      } catch {
        // Lock file doesn't exist, that's fine
      }

      // Find available port
      const port = await findAvailablePort(3000);

      // Start dev server with PM2, setting PORT env var so we can retrieve it later
      const command = `cd "${project.path}" && PORT=${port} pm2 start npm --name "${pm2Name}" -- run dev -- --port ${port}`;

      await execAsync(command, { timeout: 30000 });

      return NextResponse.json({
        success: true,
        message: `Dev server started on port ${port}`,
        port,
        pm2Name,
      });
    } else if (action === 'stop') {
      try {
        await execAsync(`pm2 delete "${pm2Name}"`, { timeout: 10000 });
      } catch {
        // Process might not exist
      }

      return NextResponse.json({
        success: true,
        message: 'Dev server stopped',
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Dev server error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
