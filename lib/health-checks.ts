import { exec, execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import net from 'net';
import {
  HealthCheck,
  HealthCheckResult,
  HealthStatus,
  ProjectHealthStatus,
  Project,
} from './types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Validate process name to prevent shell injection */
function isValidProcessName(name: string): boolean {
  return /^[a-zA-Z0-9._\-/]+$/.test(name) && name.length <= 256;
}

async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 2000;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, '127.0.0.1');
  });
}

async function checkHttp(
  url: string,
  expectedStatus: number = 200
): Promise<{ success: boolean; responseTime: number; message?: string }> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;

    if (response.status === expectedStatus) {
      return { success: true, responseTime };
    } else {
      return {
        success: false,
        responseTime,
        message: `Status ${response.status}`,
      };
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      success: false,
      responseTime,
      message: error instanceof Error ? error.message : 'Request failed',
    };
  }
}

async function checkCommand(
  command: string
): Promise<{ success: boolean; message?: string }> {
  try {
    await execAsync(command, { timeout: 5000 });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Command failed',
    };
  }
}

type Pm2Entry = { name?: string; pm2_env?: { status?: string } };

/** The health monitor runs every process check in parallel every 15 s. Each
 *  pgrep/pm2 child is a fork of the large DevFlow server, which blocked its
 *  event loop for seconds, so a cycle shares one process table and one
 *  `pm2 jlist` instead of forking per check. */
const PROCESS_SNAPSHOT_TTL_MS = 5_000;

interface ProcessEntry {
  comm: string;
  cmdline: string;
}

let processTableCache: { at: number; promise: Promise<ProcessEntry[] | null> } | null = null;
let pm2ListCache: { at: number; promise: Promise<Pm2Entry[]> } | null = null;

function cachedSnapshot<T>(
  cache: { at: number; promise: Promise<T> } | null,
  load: () => Promise<T>,
  store: (entry: { at: number; promise: Promise<T> }) => void,
): Promise<T> {
  if (cache && Date.now() - cache.at < PROCESS_SNAPSHOT_TTL_MS) return cache.promise;
  const promise = load();
  store({ at: Date.now(), promise });
  return promise;
}

/** Linux process table from /proc; null where /proc is unavailable. */
function readProcessTable(): Promise<ProcessEntry[] | null> {
  return cachedSnapshot(processTableCache, async () => {
    let pids: string[];
    try {
      pids = (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name));
    } catch {
      return null;
    }
    const entries = await Promise.all(pids.map(async (pid) => {
      try {
        const [comm, cmdline] = await Promise.all([
          fs.readFile(`/proc/${pid}/comm`, 'utf-8'),
          fs.readFile(`/proc/${pid}/cmdline`, 'utf-8'),
        ]);
        return { comm: comm.trim(), cmdline: cmdline.replace(/\0/g, ' ').trim() };
      } catch {
        return null; // exited during the scan
      }
    }));
    return entries.filter((entry): entry is ProcessEntry => entry !== null);
  }, (entry) => { processTableCache = entry; });
}

/** PM2 fallback: many services run as `node /path/to/script.js` under PM2.
 *  pgrep -x / -f won't match the PM2 *name*, so a service that's perfectly
 *  healthy under PM2 shows as offline. This checks `pm2 jlist` for an online
 *  entry with the given name. 2026-05-18 fix for footage-tracker,
 *  tokenpulse-collector, rag-qdrant-mcp-sse, github-mcp-http false-offline. */
async function checkPm2ByName(processName: string): Promise<boolean> {
  const list = await cachedSnapshot(pm2ListCache, async () => {
    try {
      const { stdout } = await execFileAsync('pm2', ['jlist'], {
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return JSON.parse(stdout) as Pm2Entry[];
    } catch {
      return [];
    }
  }, (entry) => { pm2ListCache = entry; });
  return list.some(
    (p) => p.name === processName && p.pm2_env?.status === 'online'
  );
}

/** Legacy pgrep path for hosts without /proc. */
async function checkProcessWithPgrep(processName: string): Promise<boolean> {
  for (const args of [['-x', processName], ['-f', processName]]) {
    try {
      // Use execFile with array args — no shell interpolation
      const { stdout } = await execFileAsync('pgrep', args, { timeout: 5000 });
      if (stdout.trim().length > 0) return true;
    } catch {
      /* not found or pgrep unavailable */
    }
  }
  return false;
}

async function checkProcess(
  processName: string
): Promise<{ success: boolean; message?: string }> {
  if (!isValidProcessName(processName)) {
    return { success: false, message: 'Invalid process name' };
  }

  const table = await readProcessTable();
  if (table) {
    // Same matches as `pgrep -x` (process name) and `pgrep -f` (full command line).
    const pattern = new RegExp(processName);
    if (table.some((p) => p.comm === processName || pattern.test(p.cmdline))) {
      return { success: true };
    }
  } else if (await checkProcessWithPgrep(processName)) {
    return { success: true };
  }

  if (await checkPm2ByName(processName)) {
    return { success: true };
  }

  return { success: false, message: 'Process not found' };
}

export async function runHealthCheck(
  check: HealthCheck,
  index: number
): Promise<HealthCheckResult> {
  const checkId = `check-${index}`;
  const startTime = Date.now();

  try {
    switch (check.type) {
      case 'port': {
        const isOpen = await checkPort(check.port);
        return {
          checkId,
          label: check.label,
          status: isOpen ? 'online' : 'offline',
          message: isOpen ? `Port ${check.port} is open` : `Port ${check.port} is closed`,
          responseTime: Date.now() - startTime,
        };
      }

      case 'http': {
        const result = await checkHttp(check.url, check.expectedStatus);
        return {
          checkId,
          label: check.label,
          status: result.success ? 'online' : 'offline',
          message: result.success ? 'Endpoint responding' : result.message,
          responseTime: result.responseTime,
        };
      }

      case 'command': {
        const result = await checkCommand(check.command);
        return {
          checkId,
          label: check.label,
          status: result.success ? 'online' : 'offline',
          message: result.success ? 'Command succeeded' : result.message,
          responseTime: Date.now() - startTime,
        };
      }

      case 'process': {
        const result = await checkProcess(check.processName);
        return {
          checkId,
          label: check.label,
          status: result.success ? 'online' : 'offline',
          message: result.success
            ? `Process "${check.processName}" is running`
            : result.message,
          responseTime: Date.now() - startTime,
        };
      }

      default:
        return {
          checkId,
          label: 'Unknown',
          status: 'unknown',
          message: 'Unknown check type',
        };
    }
  } catch (error) {
    return {
      checkId,
      label: check.label,
      status: 'offline',
      message: error instanceof Error ? error.message : 'Check failed',
      responseTime: Date.now() - startTime,
    };
  }
}

export async function runProjectHealthChecks(
  project: Project
): Promise<ProjectHealthStatus> {
  const checks = await Promise.all(
    (project.healthChecks ?? []).map((check, index) => runHealthCheck(check, index))
  );

  const overallStatus = determineOverallStatus(checks);

  return {
    projectId: project.id,
    overallStatus,
    checks,
    lastChecked: new Date().toISOString(),
  };
}

function determineOverallStatus(checks: HealthCheckResult[]): HealthStatus {
  if (checks.length === 0) return 'unknown';

  const allOnline = checks.every((c) => c.status === 'online');
  if (allOnline) return 'online';

  const hasOffline = checks.some((c) => c.status === 'offline');
  if (hasOffline) return 'offline';

  return 'unknown';
}
