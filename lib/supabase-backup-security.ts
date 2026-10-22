/**
 * Shared security helpers for the Supabase local-backup routes.
 *
 * Extracted from `app/api/supabase/backups/download/route.ts` because
 * Next.js 16 only allows specific named exports (GET/POST/etc) from route
 * files. These helpers are imported by the download, delete, and diff
 * handlers so the security bar stays unified across the route tree.
 */

/** Mirror of `sanitizeName` in the parent backups route so the prefix check stays in lockstep. */
export function sanitizeBackupInstanceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Strict filename validator — rejects anything that could escape the backups dir.
 * Exported for unit testing.
 */
export function isSafeBackupFilename(filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.length > 255) return false;
  // Block path separators + parent-dir traversal + null bytes
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.includes('..')) return false;
  if (filename.includes('\0')) return false;
  // Must end with .sql
  if (!filename.toLowerCase().endsWith('.sql')) return false;
  // Must be a plain filename (no leading dots beyond the extension)
  if (filename.startsWith('.')) return false;
  return true;
}
