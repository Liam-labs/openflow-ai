import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { PRODUCT_NAME } from '@/lib/brand';

const execAsync = promisify(exec);

// Paths
const CADDYFILE_PATH = '/mnt/c/Caddy/Caddyfile';
const HOSTS_PATH = '/mnt/c/Windows/System32/drivers/etc/hosts';

export interface ProxyMapping {
  id: string;
  hostname: string;
  port: number;
  enabled: boolean;
}

// Parse Caddyfile to extract mappings
function parseCaddyfile(content: string): ProxyMapping[] {
  const mappings: ProxyMapping[] = [];
  const regex = /^([a-zA-Z0-9.-]+\.test)\s*\{[\s\S]*?reverse_proxy\s+localhost:(\d+)[\s\S]*?\}/gm;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const hostname = match[1];
    const port = parseInt(match[2], 10);
    mappings.push({
      id: `${hostname}-${port}`,
      hostname,
      port,
      enabled: true,
    });
  }

  return mappings;
}

// Generate Caddyfile content from mappings
function generateCaddyfile(mappings: ProxyMapping[]): string {
  return mappings
    .filter(m => m.enabled)
    .map(m => `${m.hostname} {\n    reverse_proxy localhost:${m.port}\n}`)
    .join('\n\n') + '\n';
}

// Check if hostname exists in hosts file
async function checkHostsFile(): Promise<string[]> {
  try {
    const content = await fs.readFile(HOSTS_PATH, 'utf-8');
    const localHosts: string[] = [];
    const regex = /127\.0\.0\.1\s+([a-zA-Z0-9.-]+\.test)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      localHosts.push(match[1]);
    }
    return localHosts;
  } catch {
    return [];
  }
}

// Check if Caddy is running
async function isCaddyRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('powershell.exe -Command "Get-Process -Name caddy -ErrorAction SilentlyContinue"');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// GET: List all proxy mappings
export const GET = tracked('/api/proxy', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    // Check if Caddyfile exists
    let caddyfileExists = false;
    let mappings: ProxyMapping[] = [];

    try {
      const content = await fs.readFile(CADDYFILE_PATH, 'utf-8');
      caddyfileExists = true;
      mappings = parseCaddyfile(content);
    } catch {
      // Caddyfile doesn't exist
    }

    // Check hosts file for registered hostnames
    const hostsEntries = await checkHostsFile();

    // Check Caddy status
    const caddyRunning = await isCaddyRunning();

    // Mark mappings that are missing from hosts file
    const mappingsWithStatus = mappings.map(m => ({
      ...m,
      inHostsFile: hostsEntries.includes(m.hostname),
    }));

    return NextResponse.json({
      success: true,
      mappings: mappingsWithStatus,
      caddyInstalled: caddyfileExists,
      caddyRunning,
      hostsEntries,
    });
  } catch (error) {
    console.error('Error reading proxy config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read proxy configuration' },
      { status: 500 }
    );
  }
});

// POST: Add or update a proxy mapping
export const POST = tracked('/api/proxy', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { action, hostname, port } = body;

    if (action === 'add') {
      if (!hostname || !port) {
        return NextResponse.json(
          { success: false, error: 'Hostname and port are required' },
          { status: 400 }
        );
      }

      // Validate hostname format
      if (!/^[a-zA-Z0-9-]+\.test$/.test(hostname)) {
        return NextResponse.json(
          { success: false, error: 'Hostname must be in format: name.test' },
          { status: 400 }
        );
      }

      // Validate port
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return NextResponse.json(
          { success: false, error: 'Port must be between 1 and 65535' },
          { status: 400 }
        );
      }

      // Block system ports (< 1024)
      if (portNum < 1024) {
        return NextResponse.json(
          { success: false, error: 'Port must be 1024 or higher (system ports are not allowed)' },
          { status: 400 }
        );
      }

      // Block known DevFlow infrastructure ports
      const BLOCKED_PORTS: Record<number, string> = {
        3000: `${PRODUCT_NAME} production`,
        3001: `${PRODUCT_NAME} Alpha`,
        6333: 'Qdrant vector DB',
        6334: 'Qdrant gRPC',
        54321: 'Supabase API',
        54322: 'Supabase DB',
        54323: 'Supabase Studio',
      };
      if (BLOCKED_PORTS[portNum]) {
        return NextResponse.json(
          { success: false, error: `Port ${portNum} is reserved for internal infrastructure (${BLOCKED_PORTS[portNum]}) and cannot be proxied` },
          { status: 400 }
        );
      }

      // Read existing Caddyfile
      let mappings: ProxyMapping[] = [];
      try {
        const content = await fs.readFile(CADDYFILE_PATH, 'utf-8');
        mappings = parseCaddyfile(content);
      } catch {
        // File doesn't exist, start fresh
      }

      // Check if hostname already exists
      const existingIndex = mappings.findIndex(m => m.hostname === hostname);
      if (existingIndex >= 0) {
        // Update existing
        mappings[existingIndex].port = portNum;
      } else {
        // Add new
        mappings.push({
          id: `${hostname}-${portNum}`,
          hostname,
          port: portNum,
          enabled: true,
        });
      }

      // Write updated Caddyfile
      const newContent = generateCaddyfile(mappings);
      await fs.writeFile(CADDYFILE_PATH, newContent, 'utf-8');

      // Generate hosts entry command (user needs to run as admin)
      const hostsCommand = `Add-Content -Path 'C:\\Windows\\System32\\drivers\\etc\\hosts' -Value '127.0.0.1   ${hostname}'`;

      return NextResponse.json({
        success: true,
        message: `Proxy mapping added: ${hostname} -> localhost:${portNum}`,
        hostsCommand,
        needsHostsEntry: true,
        mapping: { hostname, port: portNum },
      });
    }

    if (action === 'reload') {
      // Reload Caddy configuration
      try {
        await execAsync('powershell.exe -Command "C:\\Caddy\\caddy.exe reload --config C:\\Caddy\\Caddyfile"');
        return NextResponse.json({
          success: true,
          message: 'Caddy configuration reloaded',
        });
      } catch (error) {
        // If reload fails, try to just inform user
        return NextResponse.json({
          success: false,
          error: 'Failed to reload Caddy. Make sure it is running.',
        });
      }
    }

    if (action === 'start') {
      try {
        await execAsync('powershell.exe -Command "Start-Process -FilePath \'C:\\Caddy\\caddy.exe\' -ArgumentList \'run --config C:\\Caddy\\Caddyfile\' -WorkingDirectory \'C:\\Caddy\' -WindowStyle Hidden"');
        return NextResponse.json({
          success: true,
          message: 'Caddy started',
        });
      } catch {
        return NextResponse.json({
          success: false,
          error: 'Failed to start Caddy',
        });
      }
    }

    if (action === 'stop') {
      try {
        await execAsync('powershell.exe -Command "Stop-Process -Name caddy -Force -ErrorAction SilentlyContinue"');
        return NextResponse.json({
          success: true,
          message: 'Caddy stopped',
        });
      } catch {
        return NextResponse.json({
          success: false,
          error: 'Failed to stop Caddy',
        });
      }
    }

    return NextResponse.json(
      { success: false, error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Error updating proxy config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update proxy configuration' },
      { status: 500 }
    );
  }
});

// DELETE: Remove a proxy mapping
export const DELETE = tracked('/api/proxy', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = new URL(request.url);
    const hostname = searchParams.get('hostname');

    if (!hostname) {
      return NextResponse.json(
        { success: false, error: 'Hostname is required' },
        { status: 400 }
      );
    }

    // Read existing Caddyfile
    let content: string;
    try {
      content = await fs.readFile(CADDYFILE_PATH, 'utf-8');
    } catch {
      return NextResponse.json(
        { success: false, error: 'Caddyfile not found' },
        { status: 404 }
      );
    }

    let mappings = parseCaddyfile(content);
    const originalLength = mappings.length;

    mappings = mappings.filter(m => m.hostname !== hostname);

    if (mappings.length === originalLength) {
      return NextResponse.json(
        { success: false, error: 'Mapping not found' },
        { status: 404 }
      );
    }

    // Write updated Caddyfile
    const newContent = generateCaddyfile(mappings);
    await fs.writeFile(CADDYFILE_PATH, newContent, 'utf-8');

    return NextResponse.json({
      success: true,
      message: `Proxy mapping removed: ${hostname}`,
      note: 'Remember to remove the hosts file entry manually if no longer needed',
    });
  } catch (error) {
    console.error('Error deleting proxy mapping:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete proxy mapping' },
      { status: 500 }
    );
  }
});
