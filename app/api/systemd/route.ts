import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PM2Process } from '@/lib/types';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

const execAsync = promisify(exec);

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

async function getSystemdService(name: string, port: number | null): Promise<PM2Process> {
  try {
    const { stdout } = await execAsync(
      `systemctl show ${name} --property=ActiveState,MainPID,MemoryCurrent,ExecMainStartTimestamp,NRestarts`,
      { timeout: 5000 }
    );

    const props: Record<string, string> = {};
    for (const line of stdout.trim().split('\n')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        props[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }

    const isActive = props.ActiveState === 'active';
    const pid = parseInt(props.MainPID || '0', 10);
    const memBytes = parseInt(props.MemoryCurrent || '0', 10);
    // MemoryCurrent can be "[not set]" or huge uint64 max — treat as 0
    const memory = isNaN(memBytes) || memBytes > 1e15 ? 0 : memBytes;

    // Calculate uptime from ExecMainStartTimestamp (human-readable timestamp)
    let uptime = 0;
    const startTs = props.ExecMainStartTimestamp;
    if (startTs && isActive) {
      // Format: "Sun 2026-02-08 16:30:25 CET" — extract date/time, treat as local
      const match = startTs.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
      if (match) {
        const startDate = new Date(`${match[1]}T${match[2]}`);
        if (!isNaN(startDate.getTime())) {
          uptime = Date.now() - startDate.getTime();
        }
      }
    }

    const restarts = parseInt(props.NRestarts || '0', 10);

    return {
      name,
      pm_id: -1,
      pid: isActive ? pid : 0,
      status: isActive ? 'online' : 'stopped',
      cpu: 0,
      memory,
      memoryFormatted: memory > 0 ? formatBytes(memory) : '--',
      uptime,
      uptimeFormatted: uptime > 0 ? formatUptime(uptime) : '--',
      restarts: isNaN(restarts) ? 0 : restarts,
      port,
      cwd: '/usr/local/bin',
      execMode: 'systemd',
    };
  } catch {
    // Service doesn't exist or systemctl failed
    return {
      name,
      pm_id: -1,
      pid: 0,
      status: 'stopped',
      cpu: 0,
      memory: 0,
      memoryFormatted: '--',
      uptime: 0,
      uptimeFormatted: '--',
      restarts: 0,
      port,
      cwd: '/usr/local/bin',
      execMode: 'systemd',
    };
  }
}

export const GET = tracked('/api/systemd', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const servicesParam = request.nextUrl.searchParams.get('services') || '';
  const portsParam = request.nextUrl.searchParams.get('ports') || '';

  if (!servicesParam) {
    return NextResponse.json({ services: [] });
  }

  // Validate service names to prevent command injection
  const serviceNames = servicesParam.split(',').filter(Boolean).filter(
    name => /^[a-zA-Z0-9@_.-]+$/.test(name)
  );
  const ports = portsParam.split(',').map(p => parseInt(p, 10) || null);

  const services = await Promise.all(
    serviceNames.map((name, i) => getSystemdService(name, ports[i] ?? null))
  );

  return NextResponse.json({ services });
});
