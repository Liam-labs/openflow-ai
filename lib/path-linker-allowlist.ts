/**
 * Path Linker allowlist — config loader + path validation.
 * Sprint 37 P3-T1.
 *
 * Loads roots and deny patterns from a JSON config file.
 * Caches in memory with optional fs.watchFile hot-reload.
 */

import { readFileSync, watchFile, unwatchFile } from 'node:fs';

export interface PathLinkerAllowlist {
  /** Allowed root paths — a path must start with one of these */
  roots: string[];
  /** Regex patterns for paths to deny even if under an allowed root */
  denyPatterns: string[];
}

const EMPTY_CONFIG: PathLinkerAllowlist = { roots: [], denyPatterns: [] };

let cachedConfig: PathLinkerAllowlist | null = null;
let cachedConfigPath: string | null = null;
let compiledDenyPatterns: RegExp[] = [];
let watching = false;

/**
 * Load the allowlist from a JSON file. Caches the result — subsequent calls
 * return the cached config unless reset or file changes (hot-reload).
 */
export function loadAllowlist(filePath: string): PathLinkerAllowlist {
  if (cachedConfig && cachedConfigPath === filePath) return cachedConfig;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    cachedConfig = { ...EMPTY_CONFIG };
    cachedConfigPath = filePath;
    compiledDenyPatterns = [];
    return cachedConfig;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    cachedConfig = { ...EMPTY_CONFIG };
    cachedConfigPath = filePath;
    compiledDenyPatterns = [];
    return cachedConfig;
  }

  const obj = parsed as Record<string, unknown>;

  const roots = Array.isArray(obj.roots)
    ? obj.roots.filter((r): r is string => typeof r === 'string')
    : [];

  const denyPatterns = Array.isArray(obj.denyPatterns)
    ? obj.denyPatterns.filter((p): p is string => typeof p === 'string')
    : [];

  cachedConfig = { roots, denyPatterns };
  cachedConfigPath = filePath;

  // Compile deny patterns to RegExp
  compiledDenyPatterns = denyPatterns
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);

  // Set up hot-reload watcher (once per path)
  if (!watching) {
    try {
      watchFile(filePath, { interval: 2000 }, () => {
        cachedConfig = null;
        cachedConfigPath = null;
        compiledDenyPatterns = [];
        // Lazy reload on next access
      });
      watching = true;
    } catch {
      // Watcher setup failure is non-fatal
    }
  }

  return cachedConfig;
}

/**
 * Check if the allowlist config has been loaded.
 */
export function isConfigLoaded(): boolean {
  return cachedConfig !== null;
}

/**
 * Check if a canonicalized path is allowed by the current config.
 * Must call loadAllowlist() first to populate the config.
 */
export function isPathAllowed(canonicalPath: string): boolean {
  if (!canonicalPath || !cachedConfig) return false;

  // Normalize: strip trailing slash for consistent matching
  const normalized = canonicalPath.endsWith('/')
    ? canonicalPath.slice(0, -1)
    : canonicalPath;

  // Check: path must start with one of the allowed roots
  const underRoot = cachedConfig.roots.some((root) => {
    // Exact match (the root itself)
    if (normalized === root) return true;
    // Path boundary match — root + '/' prefix
    if (normalized.startsWith(root + '/')) return true;
    return false;
  });

  if (!underRoot) return false;

  // Check: path must NOT match any deny pattern
  for (const deny of compiledDenyPatterns) {
    if (deny.test(canonicalPath)) return false;
  }

  return true;
}

/**
 * Reset cached state — for testing only.
 */
export function resetAllowlistForTest(): void {
  if (watching && cachedConfigPath) {
    try {
      unwatchFile(cachedConfigPath);
    } catch {
      // ignore
    }
  }
  cachedConfig = null;
  cachedConfigPath = null;
  compiledDenyPatterns = [];
  watching = false;
}
