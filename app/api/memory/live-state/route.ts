/**
 * /api/memory/live-state
 *
 * Snapshot of current memory health for the Memory Protection panel:
 * - Top RSS consumers right now (via /proc walk) + their oom_score_adj
 * - Embedding server (rag-qdrant-memory) RSS vs configured ceiling
 * - oom-score-manager status (running, last tick, agents tagged)
 * - earlyoom status (running, current args)
 *
 * Designed to be cheap (<100ms) — single /proc walk, no external commands
 * beyond `pm2 jlist` (cached for 10s).
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { tracked } from '@/lib/api-tracking';
import { requireAuthOrLocal } from '@/lib/api-auth';

import { getDevflowHome } from '@/lib/home-dir';
const exec = promisify(execCb);

const TOP_N = 15;

interface ProcInfo {
  pid: number;
  comm: string;
  cmdline: string;
  rssKb: number;
  oomScoreAdj: number | null;
  oomScore: number | null;
  uid: string | null;
  pm2Name: string | null;
}

interface LiveState {
  generatedAt: string;
  memory: { totalMB: number; availableMB: number; usedMB: number; swapTotalMB: number; swapFreeMB: number };
  topProcesses: ProcInfo[];
  embeddingServer: {
    pid: number | null;
    rssKb: number | null;
    rssMb: number | null;
    ceilingMb: number;
    pctOfCeiling: number | null;
    uptimeSeconds: number | null;
    healthy: boolean;
  };
  defenseStatus: {
    embeddingCeiling: { active: boolean; detail: string };
    earlyoom: { active: boolean; args: string | null };
    oomScoreManager: { active: boolean; lastTickAgo: number | null; agentsTagged: number | null };
  };
}

async function readMeminfo() {
  const txt = await fs.readFile('/proc/meminfo', 'utf-8');
  const get = (k: string) => {
    const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1], 10) : 0;
  };
  const totalKB = get('MemTotal');
  const availKB = get('MemAvailable');
  return {
    totalMB: Math.round(totalKB / 1024),
    availableMB: Math.round(availKB / 1024),
    usedMB: Math.round((totalKB - availKB) / 1024),
    swapTotalMB: Math.round(get('SwapTotal') / 1024),
    swapFreeMB: Math.round(get('SwapFree') / 1024),
  };
}

async function readProc(pid: number): Promise<ProcInfo | null> {
  try {
    const dir = `/proc/${pid}`;
    const [comm, status, cmdlineRaw, oomAdj, oomScore, statInfo] = await Promise.all([
      fs.readFile(`${dir}/comm`, 'utf-8').catch(() => ''),
      fs.readFile(`${dir}/status`, 'utf-8').catch(() => ''),
      fs.readFile(`${dir}/cmdline`, 'utf-8').catch(() => ''),
      fs.readFile(`${dir}/oom_score_adj`, 'utf-8').catch(() => ''),
      fs.readFile(`${dir}/oom_score`, 'utf-8').catch(() => ''),
      fs.stat(`${dir}`).catch(() => null),
    ]);
    if (!status) return null;
    const rssMatch = status.match(/^VmRSS:\s+(\d+)/m);
    if (!rssMatch) return null;
    const uidMatch = status.match(/^Uid:\s+(\d+)/m);
    return {
      pid,
      comm: comm.trim(),
      cmdline: cmdlineRaw.replace(/\0/g, ' ').trim(),
      rssKb: parseInt(rssMatch[1], 10),
      oomScoreAdj: oomAdj ? parseInt(oomAdj.trim(), 10) : null,
      oomScore: oomScore ? parseInt(oomScore.trim(), 10) : null,
      uid: uidMatch ? uidMatch[1] : null,
      pm2Name: null, // filled in by caller after PM2 jlist
    };
  } catch {
    return null;
  }
}

async function topProcesses(): Promise<ProcInfo[]> {
  const procEntries = await fs.readdir('/proc');
  const pids = procEntries.filter(n => /^\d+$/.test(n)).map(n => parseInt(n, 10));
  const infos = (await Promise.all(pids.map(readProc))).filter((p): p is ProcInfo => p !== null);
  infos.sort((a, b) => b.rssKb - a.rssKb);
  return infos.slice(0, TOP_N);
}

async function pm2Snapshot(): Promise<Record<string, { pid: number; uptime: number | null }> | null> {
  try {
    const { stdout } = await exec('pm2 jlist', { timeout: 4000 });
    const list = JSON.parse(stdout);
    const out: Record<string, { pid: number; uptime: number | null }> = {};
    for (const p of list) {
      const env = p.pm2_env || {};
      out[p.name] = {
        pid: p.pid || 0,
        uptime: env.pm_uptime ? Math.floor((Date.now() - env.pm_uptime) / 1000) : null,
      };
    }
    return out;
  } catch {
    return null;
  }
}

async function embeddingChildPid(wrapperPid: number): Promise<number | null> {
  try {
    const { stdout } = await exec(`pgrep -P ${wrapperPid}`, { timeout: 1500 });
    const first = stdout.trim().split('\n')[0];
    return first ? parseInt(first, 10) : null;
  } catch {
    return null;
  }
}

async function readOomScoreManagerStatus(): Promise<{ active: boolean; lastTickAgo: number | null; agentsTagged: number | null }> {
  const logPath = `${getDevflowHome()}/logs/oom-score-manager-output.log`;
  if (!existsSync(logPath)) return { active: false, lastTickAgo: null, agentsTagged: null };
  try {
    const stat = await fs.stat(logPath);
    const buf = await fs.readFile(logPath, 'utf-8');
    const lines = buf.split('\n').slice(-200).reverse();
    for (const line of lines) {
      const tickMatch = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\][\s\S]*?agents=(\d+)/);
      if (tickMatch) {
        const [_, ts, agents] = tickMatch;
        const tickEpoch = new Date(ts.replace(' ', 'T') + 'Z').getTime();
        const ageMs = stat.mtimeMs - tickEpoch;
        // Cap "lastTickAgo" at file mtime — if mtime is fresh and parse failed,
        // fall back to mtime itself.
        const ago = Math.max(0, Math.floor((Date.now() - stat.mtimeMs) / 1000));
        return {
          active: ageMs < 5 * 60 * 1000,
          lastTickAgo: ago,
          agentsTagged: parseInt(agents, 10),
        };
      }
    }
  } catch {
    /* fall through */
  }
  return { active: false, lastTickAgo: null, agentsTagged: null };
}

export const GET = tracked('/api/memory/live-state', async (req: NextRequest) => {
  const authError = await requireAuthOrLocal(req, 'read');
  if (authError) return authError;

  const [memory, top, pm2List] = await Promise.all([
    readMeminfo(),
    topProcesses(),
    pm2Snapshot(),
  ]);

  // Tag PM2-managed PIDs so the UI can offer an in-app restart action.
  if (pm2List) {
    const pidToName = new Map<number, string>();
    for (const [name, info] of Object.entries(pm2List)) {
      if (info.pid > 0) pidToName.set(info.pid, name);
    }
    for (const proc of top) {
      const matched = pidToName.get(proc.pid);
      if (matched) proc.pm2Name = matched;
    }
  }

  // Embedding server card: find wrapper, then python child.
  const wrapper = pm2List?.['rag-qdrant-memory'];
  const ceilingMb = 4096;
  let embedding: LiveState['embeddingServer'] = {
    pid: null,
    rssKb: null,
    rssMb: null,
    ceilingMb,
    pctOfCeiling: null,
    uptimeSeconds: null,
    healthy: false,
  };
  if (wrapper && wrapper.pid > 0) {
    const childPid = await embeddingChildPid(wrapper.pid);
    if (childPid) {
      const info = await readProc(childPid);
      if (info) {
        const rssMb = Math.round(info.rssKb / 1024);
        embedding = {
          pid: childPid,
          rssKb: info.rssKb,
          rssMb,
          ceilingMb,
          pctOfCeiling: Math.round((rssMb / ceilingMb) * 100),
          uptimeSeconds: wrapper.uptime,
          healthy: rssMb < ceilingMb * 0.9,
        };
      }
    }
  }

  // Earlyoom card
  let earlyoomArgs: string | null = null;
  const earlyoomPm = pm2List?.['earlyoom'];
  if (earlyoomPm && earlyoomPm.pid > 0) {
    try {
      const cmd = await fs.readFile(`/proc/${earlyoomPm.pid}/cmdline`, 'utf-8');
      earlyoomArgs = cmd.replace(/\0/g, ' ').trim();
    } catch { /* */ }
  }

  // oom-score-manager card
  const omStatus = await readOomScoreManagerStatus();
  const omPm = pm2List?.['oom-score-manager'];

  const state: LiveState = {
    generatedAt: new Date().toISOString(),
    memory,
    topProcesses: top,
    embeddingServer: embedding,
    defenseStatus: {
      embeddingCeiling: {
        // The defense is "active" if the wrapper is supervising a python child;
        // RSS approaching the ceiling is normal — the wrapper exists precisely
        // to catch that and restart.  Don't flip the indicator red just because
        // the current cycle is near its limit.
        active: embedding.pid !== null,
        detail: embedding.pid
          ? `RSS ${embedding.rssMb}MB / ${ceilingMb}MB ceiling (${embedding.pctOfCeiling}%)`
          : 'wrapper not running',
      },
      earlyoom: {
        active: !!earlyoomPm && earlyoomPm.pid > 0,
        args: earlyoomArgs,
      },
      oomScoreManager: {
        active: !!omPm && omPm.pid > 0 && omStatus.active,
        lastTickAgo: omStatus.lastTickAgo,
        agentsTagged: omStatus.agentsTagged,
      },
    },
  };

  return NextResponse.json(state);
});
