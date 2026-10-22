import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { getDevflowHome } from '@/lib/home-dir';

/**
 * The Codex-on-Windows launch package. All three must be present on the Windows
 * drive: the PowerShell launcher, its app-server wrapper, and the wrapper's
 * required sibling module (imported at runtime). A missing sibling fails the
 * wrapper's import on Windows, so the set is staged and verified atomically.
 */
export const CODEX_WINDOWS_PACKAGE = [
  'collab-codex-win.ps1',
  'collab-codex-ws.py',
  'design_reference_harness.py',
] as const;

/**
 * Convert a Windows drive path (e.g. `C:\DevFlow\scripts`) to its WSL /mnt mount
 * (`/mnt/c/DevFlow/scripts`) so DevFlow, running in WSL, can write to it.
 * Throws on anything that is not a drive-letter path — a UNC or WSL path is not a
 * valid target (the interop-launched pwsh cannot see `\\wsl$`).
 */
export function windowsDriveToMnt(winDir: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winDir);
  if (!m) {
    throw new Error(
      `DEVFLOW_WIN_SCRIPTS_DIR must be a Windows drive path (e.g. C:\\DevFlow\\scripts); got: ${winDir}`,
    );
  }
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/**
 * Atomically stage the canonical Codex-on-Windows launch package onto the Windows
 * drive directory (given as a Windows path). Idempotent — a file whose staged
 * copy already hash-matches source is left untouched. Fails closed: throws if a
 * source file is missing, or if any copy or post-copy hash verification fails, so
 * the spawn aborts rather than launching a Windows wrapper against drifted or
 * partial scripts.
 *
 * Why this exists: the WSL→Windows launch requires these scripts on a Windows
 * drive because the interop-launched pwsh cannot read `\\wsl$` (evidence:
 * SG-1/plans/evidence/codex-powershell/findings.md). Auto-staging keeps the
 * Windows copy in lockstep with the WSL source so an edit can't silently drift.
 */
export async function stageCodexWindowsPackage(
  winScriptsDir: string,
  wslSourceDir: string = `${getDevflowHome()}/scripts`,
): Promise<void> {
  const destDir = windowsDriveToMnt(winScriptsDir);
  await fs.mkdir(destDir, { recursive: true });

  for (const name of CODEX_WINDOWS_PACKAGE) {
    const src = path.join(wslSourceDir, name);
    const dest = path.join(destDir, name);

    let srcHash: string;
    try {
      srcHash = await sha256(src);
    } catch {
      throw new Error(`Codex-on-Windows staging: source script missing or unreadable: ${src}`);
    }

    // Content-compare first — leave an already-identical staged copy untouched.
    try {
      if ((await sha256(dest)) === srcHash) continue;
    } catch {
      /* dest absent or unreadable — fall through to copy */
    }

    // Atomic replace: write a sibling temp, then rename over the target.
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tmp, await fs.readFile(src));
      await fs.rename(tmp, dest);
    } catch (err) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw new Error(
        `Codex-on-Windows staging: failed to copy ${name} to ${dest}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Post-copy verification — fail closed on any mismatch.
    const destHash = await sha256(dest);
    if (destHash !== srcHash) {
      throw new Error(
        `Codex-on-Windows staging: post-copy hash mismatch for ${name} ` +
          `(source ${srcHash.slice(0, 12)} != staged ${destHash.slice(0, 12)})`,
      );
    }
  }
}
