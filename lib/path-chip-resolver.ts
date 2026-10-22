/**
 * Channel→project relative path resolver.
 * Sprint 69 T1.2 — pure function, no React, no I/O.
 *
 * Joins a relative path (detected by `parsePathsInText` with `isRelative: true`)
 * against the owning channel's `projectPath`, with traversal-escape defence.
 *
 * Returns `null` when:
 *   - `channelProjectPath` is missing / empty
 *   - The relative path is empty / not a string
 *   - The joined path escapes `channelProjectPath` (traversal attempt)
 *   - The relative path normalises to an absolute path that isn't already inside
 *     `channelProjectPath`
 *
 * The API endpoints performing actual filesystem reads must still allowlist-check
 * the absolute path — this resolver is a defence-in-depth UX gate, not the
 * authority on what can be served.
 */

import path from 'path';

/** True when the path looks like a Linux-style absolute path. */
export function isAbsolutePath(p: string): boolean {
  return typeof p === 'string' && p.startsWith('/');
}

/**
 * Normalise a user-supplied relative path:
 *   - Decode percent-encoded characters (e.g. `%20` → ` `)
 *   - Convert backslashes to forward slashes (Windows-style → POSIX)
 *   - Trim surrounding whitespace
 *
 * Returns `null` if decoding fails (malformed percent-encoding) so the caller
 * can fail closed instead of attempting to resolve a corrupt input.
 */
function normaliseRelative(input: string): string | null {
  let s = input.trim();
  if (s.length === 0) return null;
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  s = s.replace(/\\/g, '/');
  // Strip leading "./" — `./foo/bar` is the same as `foo/bar` and confuses
  // some posix.join callers.
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * Resolve a relative path against the owning channel's projectPath.
 *
 * Returns the joined absolute path (POSIX) on success, `null` on failure.
 *
 * - Absolute input → returned as-is (no joining; caller already has an
 *   absolute path).
 * - Relative input + valid `channelProjectPath` → joined and traversal-checked.
 * - Anything else → null.
 */
export function resolveRelativePath(
  relativePath: string,
  channelProjectPath: string | undefined | null,
): string | null {
  if (typeof relativePath !== 'string') return null;
  if (relativePath.length === 0) return null;

  // Already absolute — return as-is. The caller is responsible for any further
  // validation; we don't second-guess explicit absolute paths.
  if (isAbsolutePath(relativePath)) return relativePath;

  // Need a channel project path to anchor the relative input.
  if (!channelProjectPath || typeof channelProjectPath !== 'string') return null;
  if (!isAbsolutePath(channelProjectPath)) return null;

  const cleanRelative = normaliseRelative(relativePath);
  if (cleanRelative === null) return null;

  // After normalisation, an input that became absolute (e.g. starts with `/`
  // after backslash conversion + decode) is rejected — we only honour the
  // legacy absolute branch above, where the input was absolute from the start.
  if (isAbsolutePath(cleanRelative)) return null;

  // POSIX join + normalise. `path.posix.normalize` collapses `..` segments;
  // `path.posix.join` does the same. Use both via a single `posix.resolve`
  // anchored at the project path.
  const projectRoot = path.posix.resolve(channelProjectPath);
  const joined = path.posix.resolve(projectRoot, cleanRelative);

  // Defence-in-depth: the joined path MUST be inside projectRoot, with a path
  // separator at the boundary so that `/home/user/projectX` doesn't escape into
  // `/home/user/projectXY`.
  const rootWithSep = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  if (joined !== projectRoot && !joined.startsWith(rootWithSep)) return null;

  return joined;
}
