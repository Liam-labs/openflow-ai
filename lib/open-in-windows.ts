/**
 * Open a Linux path in the Windows host environment.
 *
 * 1. Checks the path exists on disk (stat)
 * 2. Translates via wslpath -w (execFile, no shell)
 * 3. Spawns the appropriate Windows program:
 *    - Directory open: explorer.exe <winpath>
 *    - File open: explorer.exe <winpath> (shell-dispatches to default handler)
 *    - File reveal: explorer.exe /select, <winpath>
 *    - Directory reveal: explorer.exe <winpath> (same as open)
 *    All spawned with detached:true, stdio:'ignore', shell:false, then unref().
 *    An 'error' listener is attached so ENOENT on the Windows binary is
 *    surfaced to the server log rather than silently swallowed.
 *
 * History: the file-open branch previously used `cmd.exe /C start "" <path>`
 * but that fails silently when the node cwd is a WSL path (PM2 under WSL):
 * CMD emits "UNC paths are not supported. Defaulting to Windows directory."
 * and `start`'s dispatch to the default handler becomes unreliable. explorer.exe
 * handles UNC paths natively and is already the canonical binary for the other
 * three branches — unified here for consistency and correctness.
 */

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { translateToWindows } from '@/lib/wsl-path';
import {
  assertWindowsWslServiceAvailable,
  resolveWorkingWslInterop,
} from '@/lib/windows-interop';

export interface OpenInWindowsRequest {
  path: string;
  mode: 'open' | 'reveal';
}

export interface OpenInWindowsResult {
  success: boolean;
  error?: string;
  statusCode?: number;
}

function attachErrorListener(child: ChildProcess, command: string): ChildProcess {
  child.on('error', (err) => {
    console.error(`[open-in-windows] spawn error for ${command}:`, err);
  });
  return child;
}

export async function openInWindows(
  request: OpenInWindowsRequest,
): Promise<OpenInWindowsResult> {
  const { path: linuxPath, mode } = request;

  // 1. Check path exists
  let isDir: boolean;
  try {
    const stat = await fs.stat(linuxPath);
    isDir = stat.isDirectory();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { success: false, error: 'Path does not exist', statusCode: 404 };
    }
    return { success: false, error: `stat failed: ${(err as Error).message}`, statusCode: 500 };
  }

  // 2. Translate to Windows path
  let winPath: string;
  try {
    winPath = await translateToWindows(linuxPath);
  } catch (err) {
    return { success: false, error: `wslpath translation failed: ${(err as Error).message}`, statusCode: 500 };
  }

  // 3. Spawn fire-and-forget
  try {
    // PM2 can retain a socket from an earlier WSL lifetime. Resolve a live
    // endpoint for every host launch instead of inheriting that stale value.
    const wslInterop = await resolveWorkingWslInterop();

    // Opening a \\wsl.localhost path asks Windows to call back into WSL. Probe
    // that direction too so E_UNEXPECTED reaches the UI instead of returning a
    // false success while Explorer silently fails.
    if (/^\\\\wsl(?:\$|\.localhost)\\/i.test(winPath)) {
      await assertWindowsWslServiceAvailable(wslInterop);
    }

    const spawnOptions = {
      detached: true,
      stdio: 'ignore' as const,
      shell: false,
      env: { ...process.env, WSL_INTEROP: wslInterop },
    };

    if (mode === 'reveal' && !isDir) {
      // Reveal file in parent folder with selection. The path must be its own
      // argument: WSL quotes an argument containing spaces as a whole, and
      // explorer.exe cannot parse "/select,E:\a b\c", so it silently opens
      // Documents instead.
      attachErrorListener(spawn('explorer.exe', ['/select,', winPath], spawnOptions), 'explorer.exe /select').unref();
    } else {
      // Open: directories open the folder, files shell-dispatch to their default handler.
      // explorer.exe handles both cases and tolerates UNC paths (unlike cmd.exe /C start).
      attachErrorListener(spawn('explorer.exe', [winPath], spawnOptions), 'explorer.exe').unref();
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: `spawn failed: ${(err as Error).message}`, statusCode: 500 };
  }
}
