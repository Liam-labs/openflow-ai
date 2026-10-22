/**
 * path-chip-injection.ts
 * Pure text-splitting logic for path detection in message renderer text gaps.
 * No React dependency — fully testable in a node environment.
 */

import { parsePathsInText } from '@/lib/path-parser';
import { resolveRelativePath } from '@/lib/path-chip-resolver';

export type PathSegment =
  | { type: 'text'; value: string }
  | {
      type: 'path';
      /** Display value — original path as written (relative or absolute). */
      path: string;
      /**
       * Sprint 69 T1.3: when the detected path is relative and the channel
       * has a `projectPath`, this carries the absolute path the chip should
       * actually open. Absolute paths leave this `undefined`.
       */
      resolved?: string;
    };

/**
 * Split a text string into segments, identifying Linux paths.
 * Used by the message renderer to inject PathChip components into text gaps
 * (the parts between tokens like code blocks, mentions, URLs, etc.).
 *
 * Sprint 69 T1.3: accepts optional `channelProjectPath`. When present, any
 * detected relative path is resolved against it and the absolute target rides
 * along on `segment.resolved`. When absent (or resolution fails — e.g.
 * traversal escape), the relative path is emitted as plain text instead of
 * a path segment, so the user doesn't get a clickable chip that goes nowhere.
 */
export function splitTextByPaths(
  text: string,
  channelProjectPath?: string | null,
): PathSegment[] {
  if (!text) return [];

  const matches = parsePathsInText(text);
  if (matches.length === 0) return [{ type: 'text', value: text }];

  const segments: PathSegment[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    if (match.start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.start) });
    }

    if (match.isRelative) {
      const resolved = resolveRelativePath(match.path, channelProjectPath);
      if (resolved) {
        segments.push({ type: 'path', path: match.path, resolved });
      } else {
        // No projectPath, or resolution rejected (traversal etc.) — render
        // the original text inline so the user isn't given a broken chip.
        segments.push({ type: 'text', value: match.path });
      }
    } else {
      segments.push({ type: 'path', path: match.path });
    }

    lastIndex = match.end;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}
