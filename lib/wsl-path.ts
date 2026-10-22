/**
 * WSL path translation helper.
 *
 * Translates Linux paths to Windows paths via `wslpath -w`.
 * Uses execFile (NOT shell) — safe for paths with spaces, quotes, unicode.
 *
 * For Windows→Linux conversion (UNC, WSL-URL, drive-letter), see path-windows.ts
 * — those are pure string functions safe for client bundles.
 */

import { execFile } from 'child_process';

/**
 * Translate a Linux path to its Windows equivalent via wslpath.
 * Throws on failure (non-zero exit, missing binary, empty output).
 */
export function translateToWindows(linuxPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wslpath', ['-w', linuxPath], (err, stdout, _stderr) => {
      if (err) {
        reject(new Error(`wslpath failed for "${linuxPath}": ${err.message}`));
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(`wslpath returned empty output for "${linuxPath}"`));
        return;
      }

      resolve(trimmed);
    });
  });
}
