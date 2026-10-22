/**
 * Hard character caps on agent memory files (Hermes Sprint T1).
 *
 * Enforced at two levels:
 *   1. Hook-level (PreCompact flush): memory-cap-check.sh called by flush.sh
 *      blocks the write and returns a structured error the agent must consolidate.
 *   2. Library-level: exported constants and check function for use in tests
 *      and future Write/Edit PreToolUse interceptors.
 *
 * Caps (characters, not bytes):
 *   MEMORY.md   ≤ 2,200 chars (~800 tokens)
 *   Expertise.md ≤ 3,000 chars (~1,100 tokens)
 */

export const MEMORY_MD_CHAR_LIMIT = 2200;
export const EXPERTISE_MD_CHAR_LIMIT = 3000;

export type MemoryFileType = 'memory' | 'expertise';

export interface CapacityCheckResult {
  ok: boolean;
  fileType: MemoryFileType;
  limitChars: number;
  currentChars: number;
  proposedChars: number;
  wouldBeChars: number;
  /** Structured error message for the agent to act on, null if ok. */
  error: string | null;
}

/**
 * Check whether a proposed write to a memory file would exceed the character cap.
 *
 * @param existingContent - Current content of the target file (empty string if new).
 * @param proposedContent - Content the agent wants to write (append or replace).
 * @param fileType         - Which memory file is being targeted.
 * @param isReplace        - If true, proposedContent replaces existingContent entirely.
 */
export function checkCapacity(
  existingContent: string,
  proposedContent: string,
  fileType: MemoryFileType,
  isReplace: boolean = false,
): CapacityCheckResult {
  const limit = fileType === 'memory' ? MEMORY_MD_CHAR_LIMIT : EXPERTISE_MD_CHAR_LIMIT;
  const label = fileType === 'memory' ? 'MEMORY.md' : 'Expertise.md';
  const currentChars = existingContent.length;
  const proposedChars = proposedContent.length;

  const wouldBeChars = isReplace ? proposedChars : currentChars + proposedChars;

  if (proposedChars > limit) {
    return {
      ok: false,
      fileType,
      limitChars: limit,
      currentChars,
      proposedChars,
      wouldBeChars: proposedChars,
      error:
        `Memory capacity exceeded (${limit} char limit for ${label}, ` +
        `proposed write alone is ${proposedChars} chars). ` +
        `You must reduce the content before writing.`,
    };
  }

  if (wouldBeChars > limit) {
    const op = isReplace ? 'replace would be' : `current ${currentChars} chars + proposed ${proposedChars} chars =`;
    return {
      ok: false,
      fileType,
      limitChars: limit,
      currentChars,
      proposedChars,
      wouldBeChars,
      error:
        `Memory capacity exceeded (${limit} char limit for ${label}, ` +
        `${op} ${wouldBeChars} chars). ` +
        `You must consolidate: (1) read the current file, ` +
        `(2) identify stale/obsolete entries, ` +
        `(3) compress or remove them, (4) retry the write.`,
    };
  }

  return {
    ok: true,
    fileType,
    limitChars: limit,
    currentChars,
    proposedChars,
    wouldBeChars,
    error: null,
  };
}

/**
 * Return the char limit for a given memory file type.
 */
export function getLimit(fileType: MemoryFileType): number {
  return fileType === 'memory' ? MEMORY_MD_CHAR_LIMIT : EXPERTISE_MD_CHAR_LIMIT;
}
