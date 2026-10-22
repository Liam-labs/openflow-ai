/**
 * Path detection in chat message text.
 * Sprint 37 P1-T1 — pure TypeScript, no React, no browser APIs.
 *
 * Detects Linux-style absolute paths, skipping:
 *  - fenced code blocks (``` ... ```)
 *  - inline code (`...`)
 *  - URLs (http://, https://, file://)
 *  - glob/regex patterns (* ? [ {)
 *  - bare roots without a path segment (/home, /tmp, /etc alone)
 *
 * Sprint 76: added UNC (\\wsl$\...), WSL URL (//wsl.localhost/...), and
 * Windows drive-letter (C:\...) detection. Windows-native paths are
 * converted to their Linux equivalents at parse time via windowsToLinux().
 */

import { windowsToLinux } from '@/lib/path-windows';

export interface PathMatch {
  /** Start offset in the original text */
  start: number;
  /** End offset (exclusive) in the original text */
  end: number;
  /** The detected path (trailing punctuation stripped) */
  path: string;
  /**
   * True when the match is a relative path (e.g. `scripts/foo.sh`,
   * `Start SEO Engine.bat`). False/undefined for absolute paths
   * starting with `/home/`, `/mnt/`, etc. Sprint 69 T1.1.
   */
  isRelative?: boolean;
}

/**
 * Known root prefixes that trigger path detection.
 * Order matters for /mnt/X — the regex handles the drive-letter requirement.
 */
const ROOT_PREFIXES = [
  '/home/',
  '/mnt/',
  '/tmp/',
  '/opt/',
  '/var/',
  '/etc/',
];

/** Characters that look like glob/regex — reject the whole match if present */
const GLOB_CHARS = /[*?{[]/;

/** Trailing punctuation to strip (only when NOT followed by word chars) */
const TRAILING_PUNCT = /[.,;:)\]]+$/;

// ─── Windows-native path detection (Sprint 76) ────────────────────────────────

/**
 * UNC path: \\wsl$\<distro>\<rest> or \\wsl.localhost\<distro>\<rest>.
 * distro = one or more non-backslash chars; rest = at least one segment.
 * Negative lookbehind prevents matching inside URLs or longer tokens.
 */
const UNC_PATH_RE =
  /(?<![:\w])\\\\wsl(?:\$\\|\.localhost\\)([^\\]+)\\([^\\]+\\(?:[^\s()`"'<>]+\\)*[^\s()`"'<>\\]+)/g;

/**
 * WSL URL-style: //wsl.localhost/<distro>/<rest> (forward-slash variant).
 * Rest must include at least one path segment after the distro.
 */
const WSL_URL_RE =
  /(?<![:\w])\/\/wsl\.localhost\/([^/]+)\/([^\s()`"'<>]+\/(?:[^\s()`"'<>]+\/)*[^\s()`"'<>]+)/g;

/**
 * Windows drive-letter: C:\path, D:\folder\file.ext.
 * Must have at least one segment after the drive root.
 */
const WIN_DRIVE_RE =
  /(?<![:\w])[A-Za-z]:\\([^\s()`"'<>]+\\(?:[^\s()`"'<>]+\\)*[^\s()`"'<>\\]+)/g;

// ─── Relative path detection (Sprint 69 T1.1) ────────────────────────────────

/**
 * File extensions that mark a token as a relative file path even without
 * a leading directory prefix. Lowercase compared case-insensitively.
 */
const RELATIVE_FILE_EXTS = [
  'ts', 'tsx', 'py', 'sh', 'md', 'json', 'bat', 'txt', 'yml', 'yaml', 'toml',
];

/**
 * Directory prefixes that mark a token as a relative path even without a
 * file extension (e.g. `scripts/run`, `src/utils/helpers`).
 */
const RELATIVE_DIR_PREFIXES = [
  'scripts', 'src', 'components', 'lib', 'app', 'data', 'public', 'tests', 'docs',
];

const RELATIVE_EXT_ALT = RELATIVE_FILE_EXTS.join('|');
const RELATIVE_DIR_ALT = RELATIVE_DIR_PREFIXES.join('|');

/**
 * Relative-path regex — directory-prefix branch.
 * Anchored on a known dir prefix followed by `/<segment>...`. The negative
 * lookbehind keeps it from triggering inside larger tokens (e.g. `myscripts/`
 * or absolute `/scripts/...` — already covered by the absolute regex).
 */
const RELATIVE_DIR_RE = new RegExp(
  `(?<![\\w/.-])(?:${RELATIVE_DIR_ALT})\\/[^\\s()\\[\\]\`"'<>]+`,
  'g',
);

/**
 * Relative-path regex — file-extension branch (no spaces in name).
 * Matches `foo.ts`, `lib/path-parser.ts`, `package.json`, etc. The body may
 * contain word chars, dots, hyphens, slashes — no spaces. Negative lookbehind
 * blocks word-char prefixes so `myfile.ts` inside a longer word doesn't match.
 */
const RELATIVE_EXT_NOSPACE_RE = new RegExp(
  `(?<![\\w/.-])[A-Za-z0-9_][\\w./-]*\\.(?:${RELATIVE_EXT_ALT})\\b`,
  'gi',
);

/**
 * Relative-path regex — Title Case multi-word filenames (e.g. `Start SEO
 * Engine.bat`, `Run Build.bat`). Each space-separated word must start with an
 * uppercase letter or digit; this prevents prose like "edited the bat file"
 * from matching, while allowing common Windows-style launcher filenames.
 *
 * No slashes in this branch — multi-word title-cased filenames almost never
 * appear inside path segments in practice, and allowing slashes here makes
 * the regex ambiguous against the dir-prefix branch.
 */
const RELATIVE_EXT_TITLECASE_RE = new RegExp(
  `(?<![\\w/.-])[A-Z0-9][\\w-]*(?: [A-Z0-9][\\w-]*)+\\.(?:${RELATIVE_EXT_ALT})\\b`,
  'g',
);

/**
 * Regex for path-like sequences. Matches:
 *  - A root from ROOT_PREFIXES
 *  - Followed by at least one non-whitespace, non-bracket segment
 *
 * The negative lookbehind rejects:
 *  - word chars before the slash (a/home/foo)
 *  - another slash before (//wsl.localhost)
 *  - colon before (http://...)
 */
const PATH_RE =
  /(?<![:\w/])(?:\/home\/[^\s/]+|\/mnt\/[a-z]|\/tmp|\/opt|\/var(?:\/log)?|\/etc)(?:\/[^\s()`"'<>]+)+/g;

/**
 * Detect Linux-style absolute paths AND relative paths in message text.
 * Skips fenced code blocks and inline code spans.
 *
 * Sprint 69 T1.1: relative-path detection added alongside the existing
 * absolute-path pass. Relative matches carry `isRelative: true` so the
 * downstream resolver (T1.2) can distinguish them.
 */
export function parsePathsInText(text: string): PathMatch[] {
  if (!text) return [];

  // Step 1: identify regions to exclude (fenced + inline code)
  const excluded = buildExcludedRanges(text);

  // Step 2: absolute-path pass (legacy behaviour — must remain unchanged)
  const results: PathMatch[] = [];
  PATH_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PATH_RE.exec(text)) !== null) {
    const start = match.index;
    let raw = match[0];

    // Skip if inside excluded range
    if (isInExcludedRange(start, excluded)) continue;

    // Skip if preceded by URL-like scheme (extra safety beyond lookbehind)
    const before = text.slice(Math.max(0, start - 10), start);
    if (/https?:\/\/$/i.test(before) || /file:\/\/$/i.test(before)) continue;

    // Strip trailing markdown formatting (** from bold) before other checks
    raw = stripTrailingMarkdown(raw);

    // Strip trailing punctuation (but not file extensions)
    raw = stripTrailingPunct(raw);

    // Skip if the cleaned path contains glob chars
    if (GLOB_CHARS.test(raw)) continue;

    // Skip bare roots (must have at least one segment after the root)
    if (isBareRoot(raw)) continue;

    results.push({
      start,
      end: start + raw.length,
      path: raw,
    });
  }

  // Step 2.5: Windows-native path pass (Sprint 76).
  // Detects UNC (\\wsl$\...), WSL URL (//wsl.localhost/...), and Windows
  // drive-letter (C:\...) paths. Each is converted to its Linux equivalent
  // so the existing open-in-windows pipeline handles it unchanged.
  for (const re of [UNC_PATH_RE, WSL_URL_RE, WIN_DRIVE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      let raw = m[0];

      if (isInExcludedRange(start, excluded)) continue;

      raw = stripTrailingMarkdown(raw);
      raw = stripTrailingPunct(raw);

      if (GLOB_CHARS.test(raw)) continue;

      const linuxPath = windowsToLinux(raw);
      if (!linuxPath) continue;

      results.push({
        start,
        end: start + raw.length,
        path: linuxPath,
      });
    }
  }

  // Step 3: relative-path pass (Sprint 69 T1.1). Three regex branches:
  //   - dir-prefix (scripts/foo.sh, app/api/route.ts)
  //   - extension-anchored, no spaces (lib/path-parser.ts, package.json)
  //   - extension-anchored, Title Case spaces (Start SEO Engine.bat)
  const relativeCandidates: PathMatch[] = [];
  for (const re of [RELATIVE_DIR_RE, RELATIVE_EXT_NOSPACE_RE, RELATIVE_EXT_TITLECASE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      let raw = m[0];

      if (isInExcludedRange(start, excluded)) continue;

      raw = stripTrailingMarkdown(raw);
      raw = stripTrailingPunct(raw);

      if (GLOB_CHARS.test(raw)) continue;

      relativeCandidates.push({
        start,
        end: start + raw.length,
        path: raw,
        isRelative: true,
      });
    }
  }

  // Merge + dedup. An "outer" match (longer, encompassing) is preferred over
  // any "inner" match it contains: e.g. `Run Build.bat` (Title Case branch)
  // beats `Build.bat` (ext-nospace branch). Absolute matches always beat any
  // relative match they overlap.
  const all = [...results, ...relativeCandidates].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // Same start → keep longer match first.
    return b.end - a.end;
  });

  const kept: PathMatch[] = [];
  for (const m of all) {
    // Drop if fully contained in any already-kept match.
    if (kept.some(k => m.start >= k.start && m.end <= k.end)) continue;
    // Drop any kept match fully contained in this one (rare — only with
    // same-start ties resolved above, but defends against weird overlap).
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].start >= m.start && kept[i].end <= m.end) {
        kept.splice(i, 1);
      }
    }
    kept.push(m);
  }

  kept.sort((a, b) => a.start - b.start);
  return kept;
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface Range {
  start: number;
  end: number;
}

/**
 * Build sorted list of character ranges that are inside fenced code blocks
 * or inline code spans. Uses a simple tokenizer approach for fences.
 */
function buildExcludedRanges(text: string): Range[] {
  const ranges: Range[] = [];

  // Pass 1: fenced code blocks (``` ... ```)
  // Track open/close state to handle unbalanced fences
  const fenceRe = /^```[^\n]*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let fenceOpen: number | null = null;

  fenceRe.lastIndex = 0;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    if (fenceOpen === null) {
      fenceOpen = fenceMatch.index;
    } else {
      ranges.push({
        start: fenceOpen,
        end: fenceMatch.index + fenceMatch[0].length,
      });
      fenceOpen = null;
    }
  }

  // If an unbalanced fence is open, exclude everything from it to the end
  if (fenceOpen !== null) {
    ranges.push({ start: fenceOpen, end: text.length });
  }

  // Pass 2: inline code (` ... `) — but not inside already-excluded fenced blocks
  const inlineRe = /`([^`\n]*)`/g;
  let inlineMatch: RegExpExecArray | null;

  inlineRe.lastIndex = 0;
  while ((inlineMatch = inlineRe.exec(text)) !== null) {
    const s = inlineMatch.index;
    const e = s + inlineMatch[0].length;
    // Only add if not already inside a fenced block
    if (!isInExcludedRange(s, ranges)) {
      ranges.push({ start: s, end: e });
    }
  }

  return ranges.sort((a, b) => a.start - b.start);
}

function isInExcludedRange(pos: number, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (pos >= r.start && pos < r.end) return true;
    if (r.start > pos) break; // ranges are sorted
  }
  return false;
}

/**
 * Strip trailing markdown emphasis markers (*, **, ***) when they follow
 * a non-slash character (i.e. they are formatting, not glob patterns).
 * "/plan.md**" → "/plan.md"  (markdown bold)
 * "/lib/*"     → "/lib/*"    (glob — star follows slash)
 */
function stripTrailingMarkdown(raw: string): string {
  const m = raw.match(/\*+$/);
  if (m) {
    const before = raw.slice(0, -m[0].length);
    if (before.length > 0 && !before.endsWith('/')) {
      return before;
    }
  }
  return raw;
}

/**
 * Strip trailing punctuation that's not part of a file extension.
 * e.g. "/foo/bar.ts." → strip the trailing "."
 *       "/foo/bar.ts"  → keep (the . is part of the extension)
 */
function stripTrailingPunct(raw: string): string {
  return raw.replace(TRAILING_PUNCT, '');
}

/**
 * Check if a path is just a bare root with no meaningful segment.
 * /home → bare (no user after it, but our regex requires /home/user)
 * /tmp → bare
 * /tmp/foo → not bare
 */
function isBareRoot(path: string): boolean {
  const bare = ['/tmp', '/opt', '/etc', '/var', '/var/log'];
  return bare.includes(path);
}
