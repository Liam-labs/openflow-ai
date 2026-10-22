/**
 * path-chip-helpers.ts
 * Pure helper functions for the PathChip component.
 * No React dependency — fully testable in a node environment.
 */

/** Known file extensions — if last segment has one of these, it's a file. */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'md', 'txt', 'css', 'scss', 'html',
  'yml', 'yaml', 'toml', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'pdf', 'log', 'sh', 'bash', 'zsh', 'py', 'rs', 'go', 'rb', 'lua',
  'sql', 'csv', 'env', 'lock', 'config', 'conf', 'ini', 'bak', 'dat',
  'jsonl', 'ndjson', 'map', 'wasm', 'd.ts',
]);

/** Known dotfile names that are files (not directories). */
const DOTFILE_NAMES = new Set([
  '.env', '.gitignore', '.gitmodules', '.npmrc', '.nvmrc',
  '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc',
  '.dockerignore', '.npmignore',
]);

/**
 * Extract the display name (last path segment) from an absolute path.
 */
export function getDisplayName(path: string): string {
  // Remove trailing slash to normalize
  const cleaned = path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = cleaned.split('/');
  return segments[segments.length - 1] || path;
}

/**
 * Heuristic: is this path likely a directory?
 * - Ends in `/` → directory
 * - Last segment has a known file extension → file
 * - Last segment is a known dotfile → file
 * - Last segment starts with `.` and has no further dot → directory (like .claude, .ssh)
 * - No extension at all → directory
 */
export function isDirectoryPath(path: string): boolean {
  if (path.endsWith('/')) return true;

  const name = getDisplayName(path);

  // Check known dotfile names first
  if (DOTFILE_NAMES.has(name)) return false;

  // If name starts with dot and has no further dot → directory (.claude, .ssh, .DevData)
  if (name.startsWith('.') && name.indexOf('.', 1) === -1) return true;

  // Check for file extension
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex === -1) return true; // No extension → directory
  if (dotIndex === 0) return true;  // Pure dotfile without further extension → directory

  const ext = name.slice(dotIndex + 1).toLowerCase();
  if (FILE_EXTENSIONS.has(ext)) return false;

  // Unknown extension — default to file (most things with dots are files)
  return false;
}

/**
 * Fire POST to /api/open-in-windows.
 * Returns { ok: true } on success or { ok: false, error: string } on failure.
 */
export async function openInWindows(
  path: string,
  mode: 'open' | 'reveal',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/open-in-windows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, mode }),
    });

    if (res.ok) return { ok: true };

    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    return { ok: false, error: body.error || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
