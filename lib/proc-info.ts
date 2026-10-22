/**
 * Facts about running processes and free memory, the same answers on Linux and macOS.
 *
 * Linux reads /proc (as the code always did). macOS has no /proc, so it asks `ps`, `pgrep` and `vm_stat`. Every caller wants a
 * plain answer ("alive?", "what is its command line?", "which children?", "how much memory is free?") and never needs to know which
 * system it is on. Anything that cannot be read gives the "nothing" answer (false, '', [], null), never an error.
 */
import { promises as fs } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';

export type Runner = (file: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

const usesProc = (platform: string) => platform === 'linux';

/** True when a process with this id exists (a zombie still counts, as it did with /proc). */
export async function isPidAlive(pid: number | string, platform: string = process.platform): Promise<boolean> {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (usesProc(platform)) {
    try {
      await access(`/proc/${id}`);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';   // it exists but belongs to someone else
  }
}

/** The command line of a process, words separated by a space; '' when it is gone or cannot be read. */
export async function readProcCmdline(pid: number | string, platform: string = process.platform, run: Runner = defaultRunner): Promise<string> {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return '';
  if (usesProc(platform)) {
    try {
      return (await fs.readFile(`/proc/${id}/cmdline`, 'utf-8')).split('\0').join(' ');
    } catch {
      return '';
    }
  }
  try {
    return (await run('ps', ['-p', String(id), '-o', 'command='])).trim();
  } catch {
    return '';
  }
}

/** The direct children of a process, as id strings; [] when there are none or it cannot be read. */
export async function readProcChildren(pid: number | string, platform: string = process.platform, run: Runner = defaultRunner): Promise<string[]> {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return [];
  if (usesProc(platform)) {
    try {
      const raw = await fs.readFile(`/proc/${id}/task/${id}/children`, 'utf-8');
      return raw.trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    return (await run('pgrep', ['-P', String(id)])).trim().split(/\s+/).filter(Boolean);   // pgrep exits 1 (an error here) for "none"
  } catch {
    return [];
  }
}

/** Memory a new program could use now, in MB, from the text of `vm_stat` (macOS): free + inactive + speculative pages. */
export function parseVmStatAvailableMB(text: string): number | null {
  const size = text.match(/page size of (\d+) bytes/);
  if (!size) return null;
  let pages = 0;
  let seen = 0;
  for (const name of ['Pages free', 'Pages inactive', 'Pages speculative']) {
    const m = text.match(new RegExp(`${name}:\\s+(\\d+)`));
    if (m) { pages += Number(m[1]); seen += 1; }
  }
  return seen === 0 ? null : Math.floor((pages * Number(size[1])) / (1024 * 1024));
}

/** Memory a new program could use now, in whole MB; null when it cannot be read. */
export async function availableMemoryMB(platform: string = process.platform, run: Runner = defaultRunner): Promise<number | null> {
  if (usesProc(platform)) {
    try {
      const match = (await fs.readFile('/proc/meminfo', 'utf-8')).match(/MemAvailable:\s+(\d+)\s+kB/);
      return match ? Math.floor(parseInt(match[1], 10) / 1024) : null;
    } catch {
      return null;
    }
  }
  if (platform === 'darwin') {
    try {
      return parseVmStatAvailableMB(await run('vm_stat', []));
    } catch {
      return null;
    }
  }
  return null;
}
