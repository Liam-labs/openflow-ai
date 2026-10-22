import { PM2Process, PM2Status } from './types';

export function formatUptime(uptimeMs: number): string {
  if (!uptimeMs || uptimeMs <= 0) return '--';

  const seconds = Math.floor(uptimeMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatMemory(bytes: number): string {
  if (!bytes || bytes <= 0) return '--';

  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(0)} MB`;
}

export function getCpuLevel(cpu: number): 'low' | 'medium' | 'high' | 'critical' {
  if (cpu < 25) return 'low';
  if (cpu < 50) return 'medium';
  if (cpu < 75) return 'high';
  return 'critical';
}

export function getMemoryLevel(bytes: number, thresholdMb: number = 500): 'low' | 'medium' | 'high' | 'critical' {
  const mb = bytes / (1024 * 1024);
  const ratio = mb / thresholdMb;
  if (ratio < 0.25) return 'low';
  if (ratio < 0.5) return 'medium';
  if (ratio < 0.75) return 'high';
  return 'critical';
}

interface RawPM2Process {
  name: string;
  pm_id: number;
  pid: number;
  pm2_env: {
    status: string;
    pm_uptime?: number;
    restart_time?: number;
    unstable_restarts?: number;   // restarts that fired under min_uptime — proxy for "this restart was a crash, not planned"
    cron_restart?: string;         // pm2 cron_restart schedule, present iff configured
    PORT?: number | string;
    env?: {
      PORT?: number | string;
    };
    pm_cwd?: string;
    exec_mode?: string;
  };
  monit?: {
    memory?: number;
    cpu?: number;
  };
}

export function parsePM2Process(raw: RawPM2Process): PM2Process {
  const env = raw.pm2_env || {};
  const monit = raw.monit || {};

  // Calculate uptime from pm_uptime timestamp
  const uptime = env.pm_uptime ? Date.now() - env.pm_uptime : 0;

  // Extract port from various locations
  const port = Number(env.PORT) || Number(env.env?.PORT) || null;

  // Map PM2 status to our status type
  const statusMap: Record<string, PM2Status> = {
    'online': 'online',
    'stopping': 'online',
    'stopped': 'stopped',
    'errored': 'errored',
    'launching': 'launching',
  };

  return {
    name: raw.name,
    pm_id: raw.pm_id,
    pid: raw.pid || 0,
    status: statusMap[env.status] || 'stopped',
    cpu: monit.cpu || 0,
    memory: monit.memory || 0,
    memoryFormatted: formatMemory(monit.memory || 0),
    uptime,
    uptimeFormatted: formatUptime(uptime),
    restarts: env.restart_time || 0,
    unstableRestarts: typeof env.unstable_restarts === 'number' ? env.unstable_restarts : 0,
    cronRestart: typeof env.cron_restart === 'string' && env.cron_restart ? env.cron_restart : undefined,
    port: port && !isNaN(port) ? port : null,
    cwd: env.pm_cwd || '',
    execMode: env.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
  };
}

export function parsePM2Processes(rawJson: string): PM2Process[] {
  try {
    const rawProcesses: RawPM2Process[] = JSON.parse(rawJson);
    return rawProcesses.map(parsePM2Process);
  } catch {
    return [];
  }
}

export function getPortsInUse(processes: PM2Process[]): Record<number, string> {
  const portsMap: Record<number, string> = {};

  for (const proc of processes) {
    if (proc.port && proc.status === 'online') {
      portsMap[proc.port] = proc.name;
    }
  }

  return portsMap;
}

/**
 * Overlay actual listening ports onto PM2 processes.
 * Replaces inherited PORT env vars with actual TCP socket data.
 * Processes that don't actually listen on any port get port=null.
 * Also walks descendant processes (e.g., npm → sh → node → next-server).
 */
export function overlayActualPorts(
  processes: PM2Process[],
  actualPorts: Map<number, number>,
  childPidMap?: Map<number, number[]>
): PM2Process[] {
  // Recursively collect all descendant PIDs (BFS)
  const getDescendants = (pid: number): number[] => {
    if (!childPidMap) return [];
    const descendants: number[] = [];
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = childPidMap.get(current) || [];
      for (const child of children) {
        descendants.push(child);
        queue.push(child);
      }
    }
    return descendants;
  };

  return processes.map(proc => {
    if (proc.status !== 'online' || !proc.pid) return { ...proc, port: null };

    // Check if this process's PID actually owns a listening port
    const actualPort = actualPorts.get(proc.pid);
    if (actualPort) {
      return { ...proc, port: actualPort };
    }

    // Walk all descendants to find the actual listener
    const descendants = getDescendants(proc.pid);
    for (const descPid of descendants) {
      const descPort = actualPorts.get(descPid);
      if (descPort) {
        return { ...proc, port: descPort };
      }
    }

    // Process is online but doesn't have a real listening port
    return { ...proc, port: null };
  });
}

export function getStatusColor(status: PM2Status): string {
  switch (status) {
    case 'online': return 'success';
    case 'stopped': return 'muted';
    case 'errored': return 'error';
    case 'launching': return 'warning';
    default: return 'muted';
  }
}
