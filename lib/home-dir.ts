/**
 * Where things live on this machine, so no source file hard-codes a user name.
 *
 * Plain functions over `process.env` only (no Node imports), so they are safe wherever the caller runs.
 * Call them where the path is needed; each reads the environment at call time.
 *
 * - `getHomeDir()`: the user's home folder (`HOME`).
 * - `getDevflowHome()`: the DevFlow checkout. `DEVFLOW_HOME`, else `<home>/DevFlow`.
 * - `getWindowsHome()`: the Windows profile folder as WSL sees it, for installs that bridge to Windows.
 *   `DEVFLOW_WINDOWS_HOME` (for example `/mnt/c/Users/<windows-user>`), else `/mnt/c/Users/<USER>`.
 */

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || process.env.NEXT_PUBLIC_DEVFLOW_HOME_DIR || '/';
}

export function getDevflowHome(): string {
  return process.env.DEVFLOW_HOME || process.env.NEXT_PUBLIC_DEVFLOW_HOME || `${getHomeDir()}/DevFlow`;
}

/** The Windows profile folder name, for `C:\\Users\\<name>` style paths. */
export function getWindowsProfileName(): string {
  return getWindowsHome().split('/').filter(Boolean).pop() || 'user';
}

export function getWindowsHome(): string {
  return process.env.DEVFLOW_WINDOWS_HOME || `/mnt/c/Users/${process.env.USER || process.env.USERNAME || 'user'}`;
}
