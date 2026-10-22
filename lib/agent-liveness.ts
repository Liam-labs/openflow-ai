/**
 * Agent process liveness helper.
 *
 * Provides a single cross-platform function for checking whether an agent
 * process (identified by PID) is still alive. Branches on the platform
 * field carried in session JSON files:
 *   - default / 'wsl'  → this machine's process table (lib/proc-info.ts: /proc on Linux, signal 0 on macOS)
 *   - 'windows'        → tasklist.exe query via WSL interop
 */

import { isPidAlive } from './proc-info';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

export type AgentPlatform = 'wsl' | 'windows';

/**
 * Returns true if the agent process identified by `pid` is currently alive.
 *
 * @param pid      - Process ID to check
 * @param platform - 'wsl' (default) or 'windows'. Windows uses tasklist.exe
 *                   via WSL interop; elsewhere the local process table is used.
 */
export async function isAgentAlive(
  pid: number,
  platform: AgentPlatform = 'wsl'
): Promise<boolean> {
  if (!pid || isNaN(pid)) return false;

  if (platform === 'windows') {
    return checkWindowsPid(pid);
  }

  // Default: this machine's own process table (/proc on Linux, signal 0 on macOS)
  return isPidAlive(pid);
}

async function checkWindowsPid(pid: number): Promise<boolean> {
  try {
    const { stdout } = await exec(
      `tasklist.exe /FI "PID eq ${pid}" /NH /FO CSV`,
      { timeout: 5000 }
    );
    const out = stdout.trim();
    return out.length > 0 && !out.includes('No tasks are running');
  } catch {
    return false;
  }
}
