/**
 * Sprint 54 T1 — shared paths for the /api/settings/rebuild route.
 *
 * Exposed as a module so tests can mock getRebuildPaths() with a tmpdir
 * without needing to chdir or touch process.cwd().
 */
import path from 'path';
import { appPath, appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

export interface RebuildPaths {
  appDataDir: string;
  lockPath: string;
  buildIdPath: string;
  scriptPath: string;
}

export function getRebuildPaths(): RebuildPaths {
  const cwd = appRoot();
  const home = getHomeDir();
  const appDataDir = appPath('.AppData');
  return {
    appDataDir,
    lockPath: path.join(appDataDir, 'rebuild.lock'),
    buildIdPath: path.join(cwd, '.next', 'BUILD_ID'),
    scriptPath: path.join(home, 'DevFlow/scripts/safe-build.sh'),
  };
}
