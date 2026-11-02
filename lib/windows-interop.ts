import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const WSL_INTEROP_DIR = '/run/WSL';
const INTEROP_NAME = /^\d+_interop$/;

/** Seconds a Windows command gets before it counts as timed out. 3-5 s was too short when the PC is swapping hard. */
export const WINDOWS_COMMAND_TIMEOUT_MS = 20_000;
/** Pause before the one automatic retry of a timed-out Windows command. */
export const WINDOWS_RETRY_PAUSE_MS = 2_000;

export class WindowsCommandTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} timed out after ${timeoutMs / 1000} s and was retried once (the PC may be under heavy load)`);
    this.name = 'WindowsCommandTimeoutError';
  }
}

function isTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null; code?: string } | null;
  return !!e && (e.code === 'ETIMEDOUT' || (e.killed === true && !!e.signal));
}

/**
 * Run a Windows command reached through WSL interop. If it times out, wait briefly and run it once more;
 * a second timeout throws WindowsCommandTimeoutError saying how long it waited and that it retried.
 * Any other failure is thrown unchanged and is not retried. `run` must apply `timeoutMs` itself.
 */
export async function runWindowsCommand<T>(
  what: string,
  run: () => Promise<T>,
  opts: { timeoutMs?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? WINDOWS_COMMAND_TIMEOUT_MS;
  const pauseMs = opts.pauseMs ?? WINDOWS_RETRY_PAUSE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  try {
    return await run();
  } catch (err) {
    if (!isTimeout(err)) throw err;
  }
  await sleep(pauseMs);
  try {
    return await run();
  } catch (err) {
    if (isTimeout(err)) throw new WindowsCommandTimeoutError(what, timeoutMs);
    throw err;
  }
}

export async function selectWorkingWslInterop(
  candidates: string[],
  probe: (socketPath: string) => Promise<void>,
): Promise<string> {
  for (const candidate of candidates) {
    try {
      await probe(candidate);
      return candidate;
    } catch (err) {
      // A timeout that survived the retry means the PC is overloaded, not that this socket is stale: say so.
      if (err instanceof WindowsCommandTimeoutError) throw err;
      // A socket can remain on disk after its Windows-side interop endpoint has
      // disappeared. Try the next live socket instead of inheriting the stale one.
    }
  }

  throw new Error('No working WSL interop endpoint is available to launch Windows Terminal');
}

async function listInteropSockets(): Promise<string[]> {
  const entries = await fs.readdir(WSL_INTEROP_DIR, { withFileTypes: true });
  return entries
    .filter(entry => INTEROP_NAME.test(entry.name))
    .map(entry => `${WSL_INTEROP_DIR}/${entry.name}`)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

async function probeInterop(socketPath: string): Promise<void> {
  await runWindowsCommand('WSL interop check', () => execFileAsync('cmd.exe', ['/d', '/c', 'exit', '0'], {
    cwd: '/mnt/c',
    env: { ...process.env, WSL_INTEROP: socketPath },
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
  }));
}

/** Resolve and validate a currently working WSL→Windows interop socket. */
export async function resolveWorkingWslInterop(): Promise<string> {
  const candidates = await listInteropSockets();
  return selectWorkingWslInterop(candidates, probeInterop);
}

/**
 * Verify that the Windows WSL service can create a new process in Ubuntu.
 * A working WSL_INTEROP socket only proves WSL can invoke Windows binaries;
 * it does not catch Wsl/Service/E_UNEXPECTED when Windows calls back into WSL.
 */
export async function assertWindowsWslServiceAvailable(socketPath: string): Promise<void> {
  try {
    await execFileAsync('wsl.exe', ['-d', 'Ubuntu', '--', '/bin/true'], {
      cwd: '/mnt/c',
      env: { ...process.env, WSL_INTEROP: socketPath },
      timeout: 5_000,
      encoding: 'utf8',
    });
  } catch (err) {
    const failure = err as Error & { stderr?: string | Buffer };
    const stderr = String(failure.stderr ?? '')
      .replace(/\0/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const detail = stderr || failure.message;
    throw new Error(`Windows WSL service cannot open Linux paths: ${detail}`);
  }
}
