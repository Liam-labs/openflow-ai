import { describe, it, expect } from 'vitest';
import { compactCommandFor, harnessCanCompact } from '@/lib/harness-compact';

describe('compactCommandFor', () => {
  it('uses /compact for Claude (the default harness) and Codex', () => {
    expect(compactCommandFor(undefined)).toBe('/compact');
    expect(compactCommandFor(null)).toBe('/compact');
    expect(compactCommandFor('claude')).toBe('/compact');
    expect(compactCommandFor('codex')).toBe('/compact');
  });
  it('uses /compress for Gemini', () => {
    expect(compactCommandFor('gemini')).toBe('/compress');
  });
  it('has no command for harnesses without a confirmed one', () => {
    expect(compactCommandFor('grok')).toBeNull();
    expect(compactCommandFor('antigravity')).toBeNull();
    expect(harnessCanCompact('grok')).toBe(false);
    expect(harnessCanCompact('claude')).toBe(true);
  });
});
