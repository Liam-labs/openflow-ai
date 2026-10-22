/**
 * Windows-native path conversion utilities.
 * Pure string functions — NO Node.js imports. Safe for client AND server bundles.
 * Sprint 76: split from wsl-path.ts so path-parser.ts can import without
 * pulling in child_process for the browser bundle.
 */

/**
 * Convert a Windows-native path (UNC, WSL-URL, or drive-letter) to its
 * Linux equivalent. Returns null if the input doesn't match any known
 * Windows path format.
 *
 * UNC:   \\wsl$\Ubuntu-22.04\home\<user>\foo  →  ~/foo
 * UNC:   \\wsl.localhost\Ubuntu-22.04\home\<user>\foo  →  ~/foo
 * WSL:   //wsl.localhost/Ubuntu-22.04~/foo   →  ~/foo
 * Drive: C:\Users\<user>\foo  →  /mnt/c/Users/<windows-user>/foo
 */
export function windowsToLinux(winPath: string): string | null {
  // UNC path: \\wsl$\<distro>\<rest> or \\wsl.localhost\<distro>\<rest>
  const uncMatch = winPath.match(
    /^\\\\wsl(?:\$\\|\.localhost\\)([^\\]+)\\(.+)$/,
  );
  if (uncMatch) {
    const rest = uncMatch[2].replace(/\\/g, '/');
    return '/' + rest;
  }

  // WSL URL-style: //wsl.localhost/<distro>/<rest>
  const wslMatch = winPath.match(/^\/\/wsl\.localhost\/([^/]+)\/(.+)$/);
  if (wslMatch) {
    return '/' + wslMatch[2];
  }

  // Windows drive-letter: C:\...  →  /mnt/c/...
  const driveMatch = winPath.match(/^([A-Za-z]):\\(.+)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }

  return null;
}
