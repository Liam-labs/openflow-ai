/**
 * Process Health — Data Collection
 *
 * Collects process/thread health metrics from the OS using `ps` commands.
 * Cross-references PIDs with PM2 for service name mapping.
 *
 * Used by:
 *   - /api/process-health route (on-demand)
 *   - instrumentation.ts 30s history poller
 */

import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import { DataPaths } from './data-paths';
import { appPath } from '@/lib/app-paths';

import { userInfo } from 'os';

/** The account DevFlow runs as: only its processes are counted. */
const OWN_USER = userInfo().username;
const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────────────────────

export type MetricStatus = 'green' | 'amber' | 'orange' | 'red';

export interface MetricStatuses {
  processes: MetricStatus;
  threads:   MetricStatus;
  zombies:   MetricStatus;
  forkErrors: MetricStatus;
  orphans:   MetricStatus;
}

/**
 * Threshold config per metric — tune these to adjust card coloring.
 * A metric value >= the threshold trips that color level.
 *
 * Based on system baseline: ~360 procs, ~2800 threads.
 */
export const HEALTH_THRESHOLDS = {
  processes:  { amber: 400,  orange: 600,  red: 800  },
  threads:    { amber: 3000, orange: 4000, red: 5000 },
  zombies:    { amber: 1,    orange: 11,   red: 51   },
  forkErrors: { amber: 1,    orange: 4,    red: 11   },
  orphans:    { amber: 1,    orange: 6,    red: 16   },
} as const;

export interface ProcessSummary {
  totalProcesses: number;
  totalThreads: number;
  zombies: number;
  orphans: number;
  forkErrors1hr: number;
  processLimit: number;
  threadLimit: number;
  /** Worst status across all metrics */
  status: MetricStatus;
  /** Per-metric threshold status */
  metricStatuses: MetricStatuses;
}

export interface TopConsumer {
  pid: number;
  name: string;
  parentPid: number;
  parentName: string;
  threads: number;
  memoryMB: number;
  cpuPercent: number;
  state: string;
  owner: string;
  pm2Name: string | null;
  uptime: string;
  children: number;
}

export interface HistoryEntry {
  timestamp: string;
  threads: number;
  zombies: number;
}

export interface ProcessHealthData {
  summary: ProcessSummary;
  topConsumers: TopConsumer[];
  history: HistoryEntry[];
  /** Threshold config included for frontend reference */
  thresholds: typeof HEALTH_THRESHOLDS;
}

interface HistoryFile {
  entries: HistoryEntry[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseState(stat: string): string {
  switch (stat[0]) {
    case 'R': return 'running';
    case 'Z': return 'zombie';
    case 'T': return 'stopped';
    case 'D': return 'sleeping'; // uninterruptible sleep
    default:  return 'sleeping';
  }
}

function parseUptime(etime: string): string {
  const trimmed = etime.trim();
  let days = 0, hours = 0, minutes = 0;

  const dayMatch = trimmed.match(/^(\d+)-/);
  if (dayMatch) {
    days = parseInt(dayMatch[1], 10);
    const rest = trimmed.slice(dayMatch[0].length);
    const parts = rest.split(':');
    hours   = parseInt(parts[0] || '0', 10);
    minutes = parseInt(parts[1] || '0', 10);
  } else {
    const parts = trimmed.split(':');
    if (parts.length === 3) {
      hours   = parseInt(parts[0], 10);
      minutes = parseInt(parts[1], 10);
    } else {
      minutes = parseInt(parts[0], 10);
    }
  }

  if (days > 0)  return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getMetricStatus(
  value: number,
  thresholds: { amber: number; orange: number; red: number }
): MetricStatus {
  if (value >= thresholds.red)    return 'red';
  if (value >= thresholds.orange) return 'orange';
  if (value >= thresholds.amber)  return 'amber';
  return 'green';
}

const STATUS_RANK: Record<MetricStatus, number> = {
  green: 0, amber: 1, orange: 2, red: 3,
};

function worstStatus(...statuses: MetricStatus[]): MetricStatus {
  return statuses.reduce((worst, s) =>
    STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst, 'green' as MetricStatus
  );
}

// ─── Data collectors ─────────────────────────────────────────────────────────

async function getProcessLimit(): Promise<number> {
  try {
    const content = await fs.readFile('/proc/self/limits', 'utf-8');
    const match = content.match(/Max processes\s+(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch { /* fall through */ }
  return 140241;
}

async function getThreadLimit(): Promise<number> {
  try {
    const content = await fs.readFile('/proc/sys/kernel/threads-max', 'utf-8');
    return parseInt(content.trim(), 10) || 280482;
  } catch {
    return 280482;
  }
}

async function getForkErrors1hr(): Promise<number> {
  try {
    const logDir = appPath('logs');
    const cutoff = Date.now() - 60 * 60 * 1000;
    let count = 0;

    let files: string[];
    try {
      files = await fs.readdir(logDir);
    } catch {
      return 0;
    }

    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      try {
        const filePath = path.join(logDir, file);
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) continue;
        const { stdout } = await execAsync(
          `grep -c EAGAIN "${filePath}" 2>/dev/null || echo 0`,
          { timeout: 3000 }
        );
        count += parseInt(stdout.trim(), 10) || 0;
      } catch { /* skip this file */ }
    }

    return count;
  } catch {
    return 0;
  }
}

async function getPm2NameMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const { stdout } = await execAsync('pm2 jlist 2>/dev/null', { timeout: 8000 });
    const processes = JSON.parse(stdout) as Array<{ pid?: number; name?: string }>;
    for (const p of processes) {
      if (p.pid && p.name) map.set(p.pid, p.name);
    }
  } catch { /* pm2 unavailable */ }
  return map;
}

async function getChildCounts(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const { stdout } = await execAsync('ps -eo ppid --no-headers 2>/dev/null', { timeout: 5000 });
    for (const line of stdout.trim().split('\n')) {
      const ppid = parseInt(line.trim(), 10);
      if (!isNaN(ppid)) map.set(ppid, (map.get(ppid) || 0) + 1);
    }
  } catch { /* ignore */ }
  return map;
}

async function getParentNames(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const { stdout } = await execAsync('ps -eo pid,comm --no-headers 2>/dev/null', { timeout: 5000 });
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (!isNaN(pid)) map.set(pid, parts[1] || '');
    }
  } catch { /* ignore */ }
  return map;
}

// ─── Main collector ───────────────────────────────────────────────────────────

export async function collectProcessHealth(): Promise<ProcessHealthData> {
  const [processLimit, threadLimit, forkErrors1hr, pm2Names, childCounts, parentNames] =
    await Promise.all([
      getProcessLimit(),
      getThreadLimit(),
      getForkErrors1hr(),
      getPm2NameMap(),
      getChildCounts(),
      getParentNames(),
    ]);

  const { stdout: psOut } = await execAsync(
    'ps -eo pid,ppid,nlwp,rss,pcpu,stat,comm,etime,user --sort=-nlwp --no-headers 2>/dev/null',
    { timeout: 10000, maxBuffer: 20 * 1024 * 1024 }
  );

  interface PsRow {
    pid: number; ppid: number; nlwp: number; rss: number;
    pcpu: number; stat: string; comm: string; etime: string; user: string;
  }

  const allRows: PsRow[] = psOut.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      pid:   parseInt(parts[0], 10),
      ppid:  parseInt(parts[1], 10),
      nlwp:  parseInt(parts[2], 10),
      rss:   parseInt(parts[3], 10),
      pcpu:  parseFloat(parts[4]),
      stat:  parts[5] || 'S',
      comm:  parts[6] || '',
      etime: parts[7] || '0:00',
      user:  parts[8] || '',
    };
  }).filter(p => !isNaN(p.pid) && !isNaN(p.nlwp));

  // Compute summary stats
  let totalProcesses = 0;
  let totalThreads   = 0;
  let zombies        = 0;
  let orphans        = 0;

  for (const p of allRows) {
    if (p.stat.startsWith('Z')) zombies++;
    if (p.user === OWN_USER) {
      totalProcesses++;
      totalThreads += p.nlwp;
      // Orphan: user process re-parented to init unexpectedly
      if (p.ppid === 1) orphans++;
    }
  }

  const metricStatuses: MetricStatuses = {
    processes:  getMetricStatus(totalProcesses, HEALTH_THRESHOLDS.processes),
    threads:    getMetricStatus(totalThreads,   HEALTH_THRESHOLDS.threads),
    zombies:    getMetricStatus(zombies,         HEALTH_THRESHOLDS.zombies),
    forkErrors: getMetricStatus(forkErrors1hr,  HEALTH_THRESHOLDS.forkErrors),
    orphans:    getMetricStatus(orphans,         HEALTH_THRESHOLDS.orphans),
  };
  const status = worstStatus(...Object.values(metricStatuses) as MetricStatus[]);

  // Top 50 consumers by thread count (already sorted by --sort=-nlwp)
  const topConsumers: TopConsumer[] = allRows.slice(0, 50).map(p => ({
    pid:        p.pid,
    name:       p.comm,
    parentPid:  p.ppid,
    parentName: parentNames.get(p.ppid) || '',
    threads:    p.nlwp,
    memoryMB:   Math.round(p.rss / 1024),
    cpuPercent: p.pcpu,
    state:      parseState(p.stat),
    owner:      pm2Names.get(p.pid) || p.user,
    pm2Name:    pm2Names.get(p.pid) || null,
    uptime:     parseUptime(p.etime),
    children:   childCounts.get(p.pid) || 0,
  }));

  const histFile = await readJsonFile<HistoryFile>(DataPaths.processHealthHistory, { entries: [] });

  return {
    summary: { totalProcesses, totalThreads, zombies, orphans, forkErrors1hr, processLimit, threadLimit, status, metricStatuses },
    topConsumers,
    history: histFile.entries,
    thresholds: HEALTH_THRESHOLDS,
  };
}

// ─── History poller helpers ───────────────────────────────────────────────────

/** Lightweight stats collection for history writes (cheaper than full collectProcessHealth) */
export async function getQuickStats(): Promise<{ threads: number; zombies: number }> {
  try {
    const [threadsResult, zombiesResult] = await Promise.all([
      execAsync(
        `ps -eo nlwp,user --no-headers 2>/dev/null | awk '$2=="${OWN_USER}"{sum+=$1}END{print sum+0}'`,
        { timeout: 5000 }
      ),
      execAsync(
        "ps -eo stat --no-headers 2>/dev/null | grep -c '^Z' || echo 0",
        { timeout: 5000 }
      ),
    ]);
    return {
      threads: parseInt(threadsResult.stdout.trim(), 10) || 0,
      zombies: parseInt(zombiesResult.stdout.trim(), 10) || 0,
    };
  } catch {
    return { threads: 0, zombies: 0 };
  }
}

/** Append an entry to the circular history buffer (max 2880 = 24hrs at 30s intervals) */
export async function appendProcessHealthHistory(threads: number, zombies: number): Promise<void> {
  await withFileLock(DataPaths.processHealthHistory, async () => {
    const data = await readJsonFile<HistoryFile>(DataPaths.processHealthHistory, { entries: [] });
    data.entries.push({ timestamp: new Date().toISOString(), threads, zombies });
    if (data.entries.length > 2880) {
      data.entries = data.entries.slice(data.entries.length - 2880);
    }
    await writeJsonFile(DataPaths.processHealthHistory, data);
  });
}
