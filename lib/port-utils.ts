/**
 * Port Monitoring Utilities
 *
 * Shared port scanning logic used by both the /api/ports route
 * and the server-side SSE port monitor in instrumentation.ts.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { PortInfo } from '@/lib/types';

const execAsync = promisify(exec);

/**
 * Scan for all listening TCP ports.
 * Uses `ss` with fallback to `lsof`.
 *
 * Handles all address formats (0.0.0.0:PORT, *:PORT, [::]:PORT, 127.0.0.1:PORT)
 * and includes ports where process info is unavailable (WSL2 proxied ports, etc.).
 */
export async function getListeningPorts(): Promise<PortInfo[]> {
  const ports: PortInfo[] = [];

  try {
    // Print the full line so we can parse port AND optional process info
    const { stdout } = await execAsync('ss -tlnp 2>/dev/null');
    const lines = stdout.trim().split('\n').filter(l => l.includes('LISTEN'));

    for (const line of lines) {
      // Extract port from local address field — handles all formats:
      // 0.0.0.0:3000, 127.0.0.1:3000, *:3000, [::]:3000, [::1]:3000
      const portMatch = line.match(/[:\]](\d{2,5})\s+\S+:\*/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);
      if (isNaN(port) || port < 1 || port > 65535) continue;

      // Extract process info — optional (WSL2 proxied ports, foreign-user procs won't have it)
      const pidMatch  = line.match(/pid=(\d+)/);
      const nameMatch = line.match(/"([^"]+)"/);
      const pid     = pidMatch  ? parseInt(pidMatch[1], 10)  : 0;
      const process = nameMatch ? nameMatch[1]               : 'unknown';

      ports.push({ port, pid, process, status: 'listening' });
    }
  } catch {
    // Fallback to lsof if ss fails
    try {
      const { stdout } = await execAsync(
        'lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null'
      );
      const lines = stdout.trim().split('\n').filter(Boolean).slice(1); // skip header

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 9) continue;
        const processName = parts[0];
        const pid = parseInt(parts[1], 10);
        const addrField = parts[8]; // e.g. "127.0.0.1:3000" or "*:3000"
        const portMatch = addrField.match(/:(\d+)$/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);
        if (isNaN(port)) continue;
        ports.push({ port, pid, process: processName, status: 'listening' });
      }
    } catch {
      // Both commands failed, return empty
    }
  }

  // Deduplicate: prefer entries with process info over 'unknown'
  const uniquePorts = new Map<number, PortInfo>();
  for (const entry of ports) {
    const existing = uniquePorts.get(entry.port);
    if (!existing || (existing.process === 'unknown' && entry.process !== 'unknown')) {
      uniquePorts.set(entry.port, entry);
    }
  }

  return Array.from(uniquePorts.values()).sort((a, b) => a.port - b.port);
}

/**
 * Build a fingerprint of port state for change detection.
 * Only includes port number and process name (ignores PID which can change on restart).
 */
export function buildPortFingerprint(ports: PortInfo[]): string {
  return ports
    .map(p => `${p.port}:${p.process}`)
    .sort()
    .join('|');
}

/**
 * Get actual listening ports by scanning TCP sockets with `ss`.
 * Returns a map of PID → port for processes that have a real TCP listener.
 * No port range filter — captures all listening ports.
 * This is ground truth — not based on env vars.
 */
export async function getActualListeningPorts(): Promise<Map<number, number>> {
  const pidToPort = new Map<number, number>();

  try {
    const { stdout } = await execAsync(
      "ss -tlnp 2>/dev/null | grep LISTEN",
      { timeout: 5000 }
    );

    const lines = stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      // Extract port from local address and PID from users field
      const portMatch = line.match(/:(\d+)\s/);
      const pidMatch = line.match(/pid=(\d+)/);
      if (portMatch && pidMatch) {
        const port = parseInt(portMatch[1], 10);
        const pid = parseInt(pidMatch[1], 10);
        if (port && pid) {
          pidToPort.set(pid, port);
        }
      }
    }
  } catch {
    // ss not available or failed — return empty map
  }

  return pidToPort;
}

/**
 * Build a map of parent PID → child PIDs by scanning /proc.
 * Used to resolve ports for dev servers where PM2 tracks the parent (npm)
 * but the actual listener is a child process (next-server, node, etc.).
 */
export async function getChildPidMap(): Promise<Map<number, number[]>> {
  const parentToChildren = new Map<number, number[]>();

  try {
    const { stdout } = await execAsync(
      "ps -eo pid,ppid --no-headers 2>/dev/null",
      { timeout: 5000 }
    );

    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        if (pid && ppid) {
          const existing = parentToChildren.get(ppid) || [];
          existing.push(pid);
          parentToChildren.set(ppid, existing);
        }
      }
    }
  } catch {
    // ps failed — return empty map
  }

  return parentToChildren;
}
