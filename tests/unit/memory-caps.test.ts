/**
 * Unit tests for lib/memory-caps.ts — Hermes Sprint T1.
 *
 * Covers:
 *   - Capacity check: under limit, at limit, over limit
 *   - Append vs replace modes
 *   - Empty current file (new file creation)
 *   - Error message contains required consolidation instructions
 *   - Constants are correctly exported
 */

import { describe, it, expect } from 'vitest';
import {
  checkCapacity,
  getLimit,
  MEMORY_MD_CHAR_LIMIT,
  EXPERTISE_MD_CHAR_LIMIT,
} from '@/lib/memory-caps';

describe('memory-caps constants', () => {
  it('MEMORY_MD_CHAR_LIMIT is 2200', () => {
    expect(MEMORY_MD_CHAR_LIMIT).toBe(2200);
  });

  it('EXPERTISE_MD_CHAR_LIMIT is 3000', () => {
    expect(EXPERTISE_MD_CHAR_LIMIT).toBe(3000);
  });

  it('getLimit returns correct limits', () => {
    expect(getLimit('memory')).toBe(2200);
    expect(getLimit('expertise')).toBe(3000);
  });
});

describe('checkCapacity — append mode', () => {
  it('allows write when combined under limit', () => {
    const existing = 'x'.repeat(1000);
    const proposed = 'y'.repeat(500);
    const result = checkCapacity(existing, proposed, 'memory');
    expect(result.ok).toBe(true);
    expect(result.wouldBeChars).toBe(1500);
    expect(result.error).toBeNull();
  });

  it('allows write when combined at exact limit', () => {
    const existing = 'x'.repeat(1000);
    const proposed = 'y'.repeat(1200);
    const result = checkCapacity(existing, proposed, 'memory');
    expect(result.ok).toBe(true);
    expect(result.wouldBeChars).toBe(2200);
  });

  it('blocks write when combined exceeds limit', () => {
    const existing = 'x'.repeat(1500);
    const proposed = 'y'.repeat(800);
    const result = checkCapacity(existing, proposed, 'memory');
    expect(result.ok).toBe(false);
    expect(result.wouldBeChars).toBe(2300);
    expect(result.error).toBeDefined();
    expect(result.error!).toContain('consolidat');
    expect(result.error!).toContain('MEMORY.md');
    expect(result.error!).toContain('2200');
  });

  it('blocks write when proposed alone exceeds limit', () => {
    const existing = '';
    const proposed = 'z'.repeat(2500);
    const result = checkCapacity(existing, proposed, 'memory');
    expect(result.ok).toBe(false);
    expect(result.proposedChars).toBe(2500);
    expect(result.error!).toContain('reduce the content');
  });
});

describe('checkCapacity — replace mode', () => {
  it('allows replace when new content under limit', () => {
    const existing = 'x'.repeat(3000);
    const proposed = 'y'.repeat(1800);
    const result = checkCapacity(existing, proposed, 'memory', true);
    expect(result.ok).toBe(true);
    expect(result.wouldBeChars).toBe(1800);
  });

  it('blocks replace when new content exceeds limit', () => {
    const existing = 'x'.repeat(100);
    const proposed = 'y'.repeat(2500);
    const result = checkCapacity(existing, proposed, 'memory', true);
    expect(result.ok).toBe(false);
    expect(result.wouldBeChars).toBe(2500);
  });
});

describe('checkCapacity — expertise file', () => {
  it('uses expertise limit (3000) not memory limit (2200)', () => {
    const existing = 'x'.repeat(2000);
    const proposed = 'y'.repeat(500);
    // Under memory cap but under expertise cap too — should pass
    const result = checkCapacity(existing, proposed, 'expertise');
    expect(result.ok).toBe(true);
    expect(result.limitChars).toBe(3000);
  });

  it('blocks expertise write at 3100 chars', () => {
    const existing = 'x'.repeat(2500);
    const proposed = 'y'.repeat(600);
    const result = checkCapacity(existing, proposed, 'expertise');
    expect(result.ok).toBe(false);
    expect(result.wouldBeChars).toBe(3100);
    expect(result.error!).toContain('Expertise.md');
  });
});

describe('checkCapacity — edge cases', () => {
  it('handles empty existing file (new file creation)', () => {
    const result = checkCapacity('', 'hello', 'memory');
    expect(result.ok).toBe(true);
    expect(result.currentChars).toBe(0);
    expect(result.wouldBeChars).toBe(5);
  });

  it('handles empty proposed content', () => {
    const existing = 'x'.repeat(2000);
    const result = checkCapacity(existing, '', 'memory');
    expect(result.ok).toBe(true);
    expect(result.wouldBeChars).toBe(2000);
  });

  it('both empty', () => {
    const result = checkCapacity('', '', 'memory');
    expect(result.ok).toBe(true);
    expect(result.wouldBeChars).toBe(0);
  });
});

describe('checkCapacity — result shape', () => {
  it('returns all expected fields on success', () => {
    const result = checkCapacity('abc', 'def', 'memory');
    expect(result).toEqual({
      ok: true,
      fileType: 'memory',
      limitChars: 2200,
      currentChars: 3,
      proposedChars: 3,
      wouldBeChars: 6,
      error: null,
    });
  });

  it('returns all expected fields on failure', () => {
    const result = checkCapacity('x'.repeat(2000), 'y'.repeat(500), 'memory');
    expect(result.ok).toBe(false);
    expect(result.fileType).toBe('memory');
    expect(result.currentChars).toBe(2000);
    expect(result.proposedChars).toBe(500);
    expect(result.wouldBeChars).toBe(2500);
    expect(typeof result.error).toBe('string');
  });
});
