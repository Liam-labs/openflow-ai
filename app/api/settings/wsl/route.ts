/**
 * WSL Resource Settings API
 *
 * GET  /api/settings/wsl  — Read .wslconfig + detect system resources
 * PATCH /api/settings/wsl — Update .wslconfig
 *
 * .wslconfig is on the Windows side of the owner's PC. When DevFlow runs elsewhere
 * (the server, DEVFLOW_AGENT_HOST set), the file is read and written through
 * that PC's agent-hostd; reading /mnt/c on the server found nothing, so the
 * page showed made-up defaults and every save failed (4 Oct 2026).
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { defaultHost, hostCall } from '@/lib/host-executor';
import { getWindowsHome } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

// In-process mutex for .wslconfig writes (flock unreliable on /mnt/c/ NTFS mounts)
let writeLock = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn);
  // Keep the chain moving even if fn throws
  writeLock = next.then(() => undefined, () => undefined);
  return next;
}

let cachedWslConfigPath: string | null = null;

async function getWslConfigPath(): Promise<string> {
  if (cachedWslConfigPath) return cachedWslConfigPath;
  const candidates = [`${getWindowsHome()}/.wslconfig`];
  for (const c of candidates) {
    if (existsSync(c)) { cachedWslConfigPath = c; return c; }
  }
  try {
    const { stdout } = await execAsync('cmd.exe /C "echo %USERPROFILE%"', { timeout: 5000 });
    const winUser = stdout.trim();
    const wslPath = winUser.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
    cachedWslConfigPath = `${wslPath}/.wslconfig`;
    return cachedWslConfigPath;
  } catch {
    cachedWslConfigPath = `${getWindowsHome()}/.wslconfig`;
    return cachedWslConfigPath;
  }
}

interface WslConfig {
  memory?: string;
  processors?: number;
  swap?: string;
  vmIdleTimeout?: number;
  gpuSupport?: boolean;
  nestedVirtualization?: boolean;
  [key: string]: string | number | boolean | undefined;
}

interface SystemInfo {
  totalRamGB: number;
  totalProcessors: number;
}

function parseWslConfig(content: string): WslConfig {
  const config: WslConfig = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();

    if (value === 'true') config[key] = true;
    else if (value === 'false') config[key] = false;
    else if (/^-?\d+$/.test(value)) config[key] = parseInt(value, 10);
    else config[key] = value;
  }

  return config;
}

function serializeWslConfig(config: WslConfig): string {
  const lines = ['[wsl2]'];

  // Preserve a consistent order
  const orderedKeys = ['memory', 'processors', 'swap', 'vmIdleTimeout', 'gpuSupport', 'nestedVirtualization'];
  const allKeys = new Set([...orderedKeys, ...Object.keys(config)]);

  for (const key of allKeys) {
    if (config[key] !== undefined) {
      lines.push(`${key}=${config[key]}`);
    }
  }

  return lines.join('\n') + '\n';
}

// Cache system resources — hardware doesn't change at runtime
let cachedSystemInfo: SystemInfo | null = null;

async function detectSystemResources(): Promise<SystemInfo> {
  if (cachedSystemInfo) return cachedSystemInfo;

  let totalRamGB = 64;
  let totalProcessors = 24;

  try {
    const { stdout: ram } = await execAsync(
      'powershell.exe -NoProfile -Command "[math]::Round((Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum / 1GB)"',
      { timeout: 10000 }
    );
    totalRamGB = parseInt(ram.trim(), 10) || 64;
  } catch {
    // Fallback
  }

  try {
    const { stdout: cpus } = await execAsync(
      'powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum"',
      { timeout: 10000 }
    );
    totalProcessors = parseInt(cpus.trim(), 10) || 24;
  } catch {
    // Fallback
  }

  cachedSystemInfo = { totalRamGB, totalProcessors };
  return cachedSystemInfo;
}

function parseMemoryValue(value: string): number {
  const match = value.match(/^(\d+)\s*(GB|MB|TB)?$/i);
  if (!match) return 0;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || 'GB').toUpperCase();
  if (unit === 'TB') return num * 1024;
  if (unit === 'MB') return num / 1024;
  return num;
}

// Permitted .wslconfig keys and their expected types
const ALLOWED_WSL_KEYS: Record<string, 'string' | 'number' | 'boolean'> = {
  memory: 'string',
  processors: 'number',
  swap: 'string',
  vmIdleTimeout: 'number',
  gpuSupport: 'boolean',
  nestedVirtualization: 'boolean',
};

const MEMORY_PATTERN = /^\d+(GB|MB|TB)?$/i;

function validateWslUpdates(updates: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) continue; // deletion — always allowed

    if (!(key in ALLOWED_WSL_KEYS)) {
      return `Unknown key: ${key}`;
    }

    const expectedType = ALLOWED_WSL_KEYS[key];
    if (typeof value !== expectedType) {
      return `Key "${key}" must be ${expectedType}, got ${typeof value}`;
    }

    // Range checks
    if (key === 'memory' || key === 'swap') {
      if (!MEMORY_PATTERN.test(value as string)) {
        return `Key "${key}" must match pattern like "8GB", "512MB" — got "${value}"`;
      }
    }
    if (key === 'processors') {
      if (!Number.isInteger(value) || (value as number) < 1) {
        return 'Key "processors" must be a positive integer';
      }
    }
    if (key === 'vmIdleTimeout') {
      // WSL documents -1 as the sentinel for disabling VM idle shutdown.
      if (!Number.isInteger(value) || (value as number) < -1) {
        return 'Key "vmIdleTimeout" must be -1 or a non-negative integer';
      }
    }
  }
  return null;
}

interface HostWslConfig {
  path: string;
  content: string;
  system: SystemInfo;
}

/** The PC's .wslconfig and hardware, via its agent-hostd. */
async function readHostWslConfig(host: string): Promise<HostWslConfig> {
  return hostCall<HostWslConfig>(host, 'wsl-config', {}, 30_000);
}

/** Error reply for a PC that could not be reached or refused the operation. */
function hostError(host: string, error: unknown, action: string): NextResponse {
  const code = (error as { code?: string })?.code;
  const message = code === 'EHOSTTIMEOUT'
    ? `Could not ${action}: the PC (${host}) is not connected to ${PRODUCT_NAME} right now`
    : `Could not ${action} on the PC (${host}): ${(error as Error)?.message ?? 'unknown error'}`;
  return NextResponse.json({ success: false, error: message }, { status: code === 'EHOSTTIMEOUT' ? 503 : 502 });
}

function respond(config: WslConfig, configPath: string, system: SystemInfo, extra: Record<string, unknown> = {}) {
  return NextResponse.json({
    success: true,
    config,
    configPath,
    system,
    parsed: {
      memoryGB: config.memory ? parseMemoryValue(config.memory as string) : Math.floor(system.totalRamGB / 2),
      processors: (config.processors as number) || system.totalProcessors,
      swapGB: config.swap ? parseMemoryValue(config.swap as string) : 0,
    },
    ...extra,
  });
}

export const GET = tracked('/api/settings/wsl', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const host = defaultHost();
  if (host) {
    try {
      const remote = await readHostWslConfig(host);
      return respond(parseWslConfig(remote.content), remote.path, remote.system);
    } catch (error) {
      console.error('[settings/wsl] GET via host error:', error);
      return hostError(host, error, 'read the WSL config');
    }
  }

  try {
    const configPath = await getWslConfigPath();
    let config: WslConfig = {};

    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8');
      config = parseWslConfig(content);
    }

    const system = await detectSystemResources();

    return respond(config, configPath, system);
  } catch (error) {
    console.error('[settings/wsl] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read WSL config' },
      { status: 500 }
    );
  }
});

export const PATCH = tracked('/api/settings/wsl', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: Partial<WslConfig>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const updates = body as Partial<WslConfig>;

    const validationError = validateWslUpdates(updates as Record<string, unknown>);
    if (validationError) {
      return NextResponse.json({ success: false, error: validationError }, { status: 400 });
    }

    const host = defaultHost();
    if (host) {
      try {
        const result = await withWriteLock(async () => {
          const remote = await readHostWslConfig(host);
          const cfg = parseWslConfig(remote.content);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === undefined) delete cfg[key];
            else cfg[key] = value;
          }
          await hostCall(host, 'wsl-config-write', { content: serializeWslConfig(cfg) }, 30_000);
          return { cfg, remote };
        });
        return respond(result.cfg, result.remote.path, result.remote.system, { restartRequired: true });
      } catch (error) {
        console.error('[settings/wsl] PATCH via host error:', error);
        return hostError(host, error, 'save the WSL config');
      }
    }

    const configPath = await getWslConfigPath();

    // Serialize config and resolve system info inside write lock to prevent concurrent clobber
    const config = await withWriteLock(async () => {
      let cfg: WslConfig = {};
      if (existsSync(configPath)) {
        const raw = await readFile(configPath, 'utf-8');
        cfg = parseWslConfig(raw);
      }

      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined) {
          delete cfg[key];
        } else {
          cfg[key] = value;
        }
      }

      const fileContent = serializeWslConfig(cfg);
      await writeFile(configPath, fileContent, 'utf-8');
      return cfg;
    });
    const system = await detectSystemResources();

    return respond(config, configPath, system, { restartRequired: true });
  } catch (error) {
    console.error('[settings/wsl] PATCH error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update WSL config' },
      { status: 500 }
    );
  }
});
