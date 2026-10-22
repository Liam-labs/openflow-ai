import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const WSL_INTEROP_DIR = '/run/WSL';
const INTEROP_NAME = /^\d+_interop$/;

export async function selectWorkingWslInterop(
  candidates: string[],
  probe: (socketPath: string) => Promise<void>,
): Promise<string> {
  for (const candidate of candidates) {
    try {
      await probe(candidate);
      return candidate;
    } catch {
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
  await execFileAsync('cmd.exe', ['/d', '/c', 'exit', '0'], {
    cwd: '/mnt/c',
    env: { ...process.env, WSL_INTEROP: socketPath },
    timeout: 3_000,
  });
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
