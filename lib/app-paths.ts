/**
 * Application root path constants.
 *
 * process.cwd() is evaluated once at module load time and cached here.
 * Import APP_CWD instead of calling process.cwd() in hot paths to avoid
 * repeated syscalls and ensure a single source of truth for the app root.
 */

import path from 'path';

/**
 * The application root directory, read live on every call.
 *
 * Route and library code must call this instead of `process.cwd()`. Turbopack
 * treats `path.join(process.cwd(), ...)` in a route as a file dependency and
 * traces the whole directory (for `.AppData` that means ~100k runtime files and
 * a venv symlink that aborts the build). It cannot see through this call.
 */
export function appRoot(): string {
  return process.cwd();
}

/**
 * Join path segments onto the application root. Use this for any path under
 * `.AppData`: Turbopack pattern-traces `path.join(<unknown>, '.AppData', ...)`
 * even through appRoot(), and a venv symlink there aborts the build.
 */
export function appPath(...segments: string[]): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), ...segments);
}

/** The application root directory (DevFlow root). Cached at module load. */
export const APP_CWD = appRoot();

/** The runtime data directory (.AppData). Cached at module load. */
export const APP_DATA_DIR = path.join(
  /* turbopackIgnore: true */ APP_CWD,
  process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData',
);
