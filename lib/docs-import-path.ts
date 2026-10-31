/**
 * Which files may the docs importer read? Decided on the REAL path of the file (symlinks and ".." followed), never on the
 * text the caller sent: "~/docs/../.ssh/notes.txt" starts with a visible folder but lands in a hidden one.
 *
 * Allowed: anywhere under the application folder, or under a visible, non-sensitive folder directly inside the home folder.
 * Blocked: hidden folders in the home folder, known-sensitive folders, and everything outside both roots.
 */
import path from 'path';

const SENSITIVE_DIRS = new Set(['secrets', 'credentials', 'private', 'keys', 'certs', 'tokens', 'vault']);

export interface ImportRoots {
  /** Real path of the home folder. */
  home: string;
  /** Real path of the application folder. */
  app: string;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** `realFile` must already be resolved with fs.realpath; `roots` too. */
export function importPathAllowed(realFile: string, roots: ImportRoots): boolean {
  if (inside(realFile, roots.app)) return true;
  if (!inside(realFile, roots.home)) return false;
  const top = path.relative(roots.home, realFile).split(path.sep)[0];
  return top !== '' && !top.startsWith('.') && !SENSITIVE_DIRS.has(top.toLowerCase());
}
