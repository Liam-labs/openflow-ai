import { describe, it, expect } from 'vitest';

// Test the duration options and label helper logic
// These mirror the constants defined in app/gateway/page.tsx

type SessionDuration = '24h' | '336h' | '720h';

const DURATION_OPTIONS: { value: SessionDuration; label: string }[] = [
  { value: '24h', label: '1 Day' },
  { value: '336h', label: '14 Days' },
  { value: '720h', label: '30 Days' },
];

function durationLabel(dur: SessionDuration | null | undefined): string {
  return DURATION_OPTIONS.find(o => o.value === dur)?.label ?? '1 Day';
}

describe('gateway duration helpers', () => {
  describe('durationLabel', () => {
    it('returns "1 Day" for 24h', () => {
      expect(durationLabel('24h')).toBe('1 Day');
    });

    it('returns "14 Days" for 336h', () => {
      expect(durationLabel('336h')).toBe('14 Days');
    });

    it('returns "30 Days" for 720h', () => {
      expect(durationLabel('720h')).toBe('30 Days');
    });

    it('returns "1 Day" for null (default)', () => {
      expect(durationLabel(null)).toBe('1 Day');
    });

    it('returns "1 Day" for undefined (default)', () => {
      expect(durationLabel(undefined)).toBe('1 Day');
    });
  });

  describe('DURATION_OPTIONS', () => {
    it('contains exactly 3 options', () => {
      expect(DURATION_OPTIONS).toHaveLength(3);
    });

    it('has unique values', () => {
      const values = DURATION_OPTIONS.map(o => o.value);
      expect(new Set(values).size).toBe(values.length);
    });

    it('all values are valid SessionDuration strings', () => {
      const valid: SessionDuration[] = ['24h', '336h', '720h'];
      for (const opt of DURATION_OPTIONS) {
        expect(valid).toContain(opt.value);
      }
    });

    it('labels are human-readable day counts', () => {
      expect(DURATION_OPTIONS[0].label).toMatch(/day/i);
      expect(DURATION_OPTIONS[1].label).toMatch(/day/i);
      expect(DURATION_OPTIONS[2].label).toMatch(/day/i);
    });
  });
});
