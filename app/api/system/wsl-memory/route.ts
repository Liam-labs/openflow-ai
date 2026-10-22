/**
 * GET /api/system/wsl-memory
 *
 * Returns WSL2 memory statistics — total allocation, usage, swap, OOM risk,
 * and pressure stall information (PSI) showing how close the system is to
 * resource starvation.
 *
 * Reads /proc/meminfo for Linux-side stats, /sys/fs/cgroup/*.pressure for
 * PSI metrics, and ~/.wslconfig (via /mnt/c/Users) for the configured
 * WSL2 memory ceiling.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { tracked } from '@/lib/api-tracking';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

interface PressureStats {
  avg10: number;
  avg60: number;
  avg300: number;
  totalStallUs: number;
}

interface WslMemoryResponse {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  usagePercent: number;
  swapTotalMb: number;
  swapUsedMb: number;
  swapPercent: number;
  oomRisk: 'low' | 'moderate' | 'high' | 'critical';
  /** Which kind of machine this process runs on: WSL on the desktop, or the plain Linux server. */
  machine: 'wsl' | 'server';
  memTotalKb: number;
  memAvailableKb: number;
  memFreeKb: number;
  buffersKb: number;
  cachedKb: number;
  wslConfigMemoryMb: number | null;
  pressure: {
    memory: PressureStats | null;
    cpu: PressureStats | null;
    io: PressureStats | null;
  };
  errors: string[];
}

function parseMeminfo(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(.+?):\s+(\d+)\s*kB$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function readWslConfig(): Promise<number | null> {
  try {
    // os.userInfo().username is the Linux user (<user>), not Windows (<user>).
    // Scan /mnt/c/Users/ for any .wslconfig — there should only be one that matters.
    const usersDir = await fs.readdir('/mnt/c/Users/').catch(() => [] as string[]);
    for (const entry of usersDir) {
      try {
        const raw = await fs.readFile(`/mnt/c/Users/${entry}/.wslconfig`, 'utf-8');
        const m = raw.match(/^memory\s*=\s*(\d+)\s*GB$/m);
        if (m) return Number(m[1]) * 1024; // GB → MB
      } catch { /* try next */ }
    }
  } catch { /* non-fatal */ }
  return null;
}

function parsePressure(raw: string): PressureStats | null {
  const someLine = raw.split('\n').find((l) => l.startsWith('some '));
  if (!someLine) return null;
  const m = someLine.match(/^some\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/);
  if (!m) return null;
  return {
    avg10: parseFloat(m[1]),
    avg60: parseFloat(m[2]),
    avg300: parseFloat(m[3]),
    totalStallUs: parseInt(m[4], 10),
  };
}

function computeOomRisk(
  availableMb: number,
  totalMb: number,
  swapPercent: number,
  memPressure: PressureStats | null,
): 'low' | 'moderate' | 'high' | 'critical' {
  const availPct = (availableMb / totalMb) * 100;
  // Memory pressure: % of time tasks stalled waiting for memory in the last window.
  // PSI some > 10 means significant stall — OOM is imminent even if meminfo looks ok.
  const memStall = memPressure?.avg10 ?? 0;

  if (availPct < 3 || swapPercent > 95 || memStall > 25) return 'critical';
  if (availPct < 8 || swapPercent > 80 || memStall > 10) return 'high';
  if (availPct < 15 || swapPercent > 60 || memStall > 2) return 'moderate';
  return 'low';
}

export const GET = tracked('/api/system/wsl-memory', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  const errors: string[] = [];

  let meminfo: Record<string, number> = {};
  try {
    const raw = await fs.readFile('/proc/meminfo', 'utf-8');
    meminfo = parseMeminfo(raw);
  } catch (err) {
    errors.push(`/proc/meminfo read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const memTotalKb = meminfo['MemTotal'] ?? 0;
  const memAvailableKb = meminfo['MemAvailable'] ?? 0;
  const memFreeKb = meminfo['MemFree'] ?? 0;
  const buffersKb = meminfo['Buffers'] ?? 0;
  const cachedKb = (meminfo['Cached'] ?? 0) + (meminfo['SReclaimable'] ?? 0);
  const swapTotalKb = meminfo['SwapTotal'] ?? 0;
  const swapFreeKb = meminfo['SwapFree'] ?? 0;

  const swapTotalMb = Math.round(swapTotalKb / 1024);
  const swapUsedMb = Math.round((swapTotalKb - swapFreeKb) / 1024);
  const swapPercent = swapTotalMb > 0 ? Math.round((swapUsedMb / swapTotalMb) * 100) : 0;

  const wslConfigMemoryMb = await readWslConfig();
  // WSL reports a Microsoft kernel; the Remote server is plain Linux.
  const machine: 'wsl' | 'server' = await fs.readFile('/proc/version', 'utf-8').then(v => /microsoft/i.test(v), () => false) ? 'wsl' : 'server';

  // ── Read pressure stall info ───────────────────────────────────────
  let memPressure: PressureStats | null = null;
  let cpuPressure: PressureStats | null = null;
  let ioPressure: PressureStats | null = null;
  try {
    const [memRaw, cpuRaw, ioRaw] = await Promise.all([
      fs.readFile('/sys/fs/cgroup/memory.pressure', 'utf-8'),
      fs.readFile('/sys/fs/cgroup/cpu.pressure', 'utf-8'),
      fs.readFile('/sys/fs/cgroup/io.pressure', 'utf-8'),
    ]);
    memPressure = parsePressure(memRaw);
    cpuPressure = parsePressure(cpuRaw);
    ioPressure = parsePressure(ioRaw);
  } catch {
    // Non-fatal — older kernels may not expose pressure files
  }

  // total = WSL config limit (preferred) else MemTotal from /proc
  const totalMb = wslConfigMemoryMb ?? Math.round(memTotalKb / 1024);
  const availableMb = Math.round(memAvailableKb / 1024);
  const usedMb = Math.max(0, totalMb - availableMb);
  const usagePercent = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;

  const oomRisk = computeOomRisk(availableMb, totalMb, swapPercent, memPressure);

  const body: WslMemoryResponse = {
    totalMb,
    usedMb,
    availableMb,
    usagePercent,
    swapTotalMb,
    swapUsedMb,
    swapPercent,
    oomRisk,
    machine,
    memTotalKb,
    memAvailableKb,
    memFreeKb,
    buffersKb,
    cachedKb,
    wslConfigMemoryMb,
    pressure: {
      memory: memPressure,
      cpu: cpuPressure,
      io: ioPressure,
    },
    errors,
  };

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
});
