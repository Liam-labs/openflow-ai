/**
 * Consolidate Actions — on-demand trigger for Knowledge Harvester
 *
 * consolidate.run    — spawn harvester.py immediately (with cooldown guard)
 * consolidate.status — check last run time and cooldown state
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';

import { getDevflowHome, getHomeDir } from '@/lib/home-dir';
const HARVESTER_SCRIPT = `${getHomeDir()}/rag-stack/harvester.py`;
const VENV_PYTHON = `${getHomeDir()}/rag-stack/venv/bin/python`;
const COOLDOWN_LOCK = `${getDevflowHome()}/logs/harvester-cooldown.lock`;
const COOLDOWN_SECONDS = 300; // 5 minutes — prevent stacked runs

async function getLockMtime(): Promise<number | null> {
  try {
    const stat = await fs.stat(COOLDOWN_LOCK);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function writeLock(): Promise<void> {
  await fs.mkdir(path.dirname(COOLDOWN_LOCK), { recursive: true });
  await fs.writeFile(COOLDOWN_LOCK, new Date().toISOString(), 'utf-8');
}

/**
 * consolidate.run — trigger harvester.py on demand
 * Optional body params:
 *   channel: string   — process specific channel ID only
 *   hours:   number   — override time window (default 24)
 *   force:   boolean  — bypass cooldown
 */
export async function run(body: AgentApiRequest, _auth: AgentAuthContext) {
  const force = body.force === true;

  // Cooldown check
  const lockMtime = await getLockMtime();
  if (lockMtime && !force) {
    const ageSeconds = (Date.now() - lockMtime) / 1000;
    if (ageSeconds < COOLDOWN_SECONDS) {
      const remaining = Math.ceil(COOLDOWN_SECONDS - ageSeconds);
      return {
        status: 'cooldown',
        message: `Last run was ${Math.floor(ageSeconds)}s ago. ${remaining}s remaining. Pass force:true to override.`,
        cooldownRemaining: remaining,
      };
    }
  }

  // Build args
  const args: string[] = [HARVESTER_SCRIPT];
  if (body.channel && typeof body.channel === 'string') {
    args.push('--channel', body.channel);
  }
  if (body.hours && typeof body.hours === 'number') {
    args.push('--hours', String(body.hours));
  }

  // Write cooldown lock before spawn (prevent double-trigger)
  await writeLock();

  // Spawn detached — harvester runs in background, we return immediately
  const child = spawn(VENV_PYTHON, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  const pid = child.pid ?? null;

  return {
    status: 'started',
    message: 'Knowledge Harvester started in background.',
    pid,
    args: args.slice(1), // exclude script path
  };
}

/**
 * consolidate.status — check last run time and cooldown state
 */
export async function status(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const lockMtime = await getLockMtime();

  if (!lockMtime) {
    return {
      lastRun: null,
      cooldownRemaining: 0,
      isRunning: false,
      message: 'No run recorded yet.',
    };
  }

  const ageSeconds = (Date.now() - lockMtime) / 1000;
  const cooldownRemaining = Math.max(0, Math.ceil(COOLDOWN_SECONDS - ageSeconds));

  return {
    lastRun: new Date(lockMtime).toISOString(),
    lastRunAgeSeconds: Math.floor(ageSeconds),
    cooldownRemaining,
    isRunning: cooldownRemaining > 0,
    message: cooldownRemaining > 0
      ? `Last run ${Math.floor(ageSeconds)}s ago — ${cooldownRemaining}s cooldown remaining`
      : `Last run ${Math.floor(ageSeconds)}s ago — ready to run`,
  };
}
