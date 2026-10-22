/**
 * Tests for TypeBadge type normalization in TableDataBrowser.
 * Bug: type.replace() crashes when column type is undefined.
 */

import { describe, it, expect } from 'vitest';

// Extract the logic from TypeBadge to test independently
function normalizeType(type: string | undefined | null): string {
  return (type || 'unknown').replace(/\(.*\)/, '').toLowerCase().trim();
}

describe('TypeBadge type normalization', () => {
  it('handles normal type string', () => {
    expect(normalizeType('varchar(255)')).toBe('varchar');
  });

  it('handles type without parentheses', () => {
    expect(normalizeType('integer')).toBe('integer');
  });

  it('handles undefined type (the bug)', () => {
    expect(normalizeType(undefined)).toBe('unknown');
  });

  it('handles null type', () => {
    expect(normalizeType(null)).toBe('unknown');
  });

  it('handles empty string type', () => {
    expect(normalizeType('')).toBe('unknown');
  });

  it('handles type with mixed case', () => {
    expect(normalizeType('TIMESTAMPTZ')).toBe('timestamptz');
  });

  it('trims whitespace', () => {
    expect(normalizeType('  text  ')).toBe('text');
  });
});
