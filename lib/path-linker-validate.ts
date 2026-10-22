/**
 * Canonical path validation for Path Linker.
 * Sprint 37 P3-T2.
 *
 * Resolves a user-supplied path to its canonical form via realpath,
 * then checks it against the allowlist. This defeats:
 *  - .. traversal attacks
 *  - symlink escapes
 *  - encoded/obfuscated paths
 */

import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isPathAllowed, loadAllowlist, isConfigLoaded } from './path-linker-allowlist';
import { appPath } from '@/lib/app-paths';

const ALLOWLIST_PATH = appPath('data', 'path-linker-allowlist.json');

export interface ValidationResult {
  allowed: boolean;
  canonicalPath?: string;
  isDirectory?: boolean;
  reason?: string;
}

/**
 * Validate and canonicalize a path before opening.
 *
 * 1. Reject empty/relative paths
 * 2. path.resolve() to normalize .. segments
 * 3. realpath() to resolve symlinks and confirm existence
 * 4. Check canonical path against allowlist
 * 5. stat() to determine file vs directory
 */
export async function validateAndCanonicalize(
  inputPath: string
): Promise<ValidationResult> {
  // Reject empty or relative
  if (!inputPath || !inputPath.startsWith('/')) {
    return { allowed: false, reason: 'invalid path' };
  }

  // Load the allowlist config — cached after first call, hot-reloads on file change.
  if (!isConfigLoaded()) {
    loadAllowlist(ALLOWLIST_PATH);
  }

  // Step 1: normalize (resolve .., remove trailing slashes)
  const normalized = resolve(inputPath);

  // Step 2: realpath — resolves symlinks and confirms existence
  let canonical: string;
  try {
    canonical = await realpath(normalized);
  } catch {
    return { allowed: false, reason: 'not found' };
  }

  // Step 3: allowlist check on the canonical (post-symlink) path
  if (!isPathAllowed(canonical)) {
    return { allowed: false, reason: 'not in allowlist', canonicalPath: canonical };
  }

  // Step 4: stat to determine type
  try {
    const st = await stat(canonical);
    return {
      allowed: true,
      canonicalPath: canonical,
      isDirectory: st.isDirectory(),
    };
  } catch {
    return { allowed: false, reason: 'not found', canonicalPath: canonical };
  }
}

/**
 * Canonicalize a path for showing it in Windows File Explorer. Explorer only
 * displays a location on the owner's own desktop and returns no file content, so
 * every existing absolute path is permitted, including symlinks into Windows
 * drives such as ~/Games -> /mnt/e/GameDev. Content-reading callers must keep
 * using validateAndCanonicalize and its allowlist.
 */
export async function canonicalizeExistingPath(
  inputPath: string
): Promise<ValidationResult> {
  if (!inputPath || !inputPath.startsWith('/')) {
    return { allowed: false, reason: 'invalid path' };
  }
  try {
    const canonical = await realpath(resolve(inputPath));
    const st = await stat(canonical);
    return { allowed: true, canonicalPath: canonical, isDirectory: st.isDirectory() };
  } catch {
    return { allowed: false, reason: 'not found' };
  }
}
