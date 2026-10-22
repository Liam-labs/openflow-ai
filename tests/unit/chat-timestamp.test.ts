/**
 * Tests for chat-timestamp helpers.
 * Written TDD — RED first (lib/chat-timestamp.ts does not exist yet), then GREEN.
 */

import { describe, it, expect } from 'vitest';
import { formatAbsoluteTime } from '@/lib/chat-timestamp';

// ─── formatAbsoluteTime ───────────────────────────────────────────────────────

describe('formatAbsoluteTime', () => {
  it('returns a string matching the HH:MMam/pm pattern', () => {
    const ts = '2026-04-18T09:30:00.000Z';
    const result = formatAbsoluteTime(ts);
    expect(result).toMatch(/^\d{1,2}:\d{2}[ap]m$/);
  });

  it('zero-pads minutes', () => {
    // :05 → ":05am" or ":05pm", not ":5"
    const ts = '2026-04-18T09:05:00.000Z';
    const result = formatAbsoluteTime(ts);
    expect(result).toMatch(/:\d{2}[ap]m$/);
  });

  it('reflects the correct minutes from the timestamp', () => {
    const ts = '2026-04-18T14:37:00.000Z';
    const result = formatAbsoluteTime(ts);
    expect(result).toContain(':37');
  });

  it('produces different results for timestamps 1 hour apart', () => {
    const ts1 = '2026-04-18T10:00:00.000Z';
    const ts2 = '2026-04-18T11:00:00.000Z';
    expect(formatAbsoluteTime(ts1)).not.toBe(formatAbsoluteTime(ts2));
  });

  it('accepts a numeric timestamp (epoch ms)', () => {
    const epoch = new Date('2026-04-18T08:00:00.000Z').getTime();
    const result = formatAbsoluteTime(epoch);
    expect(result).toMatch(/^\d{1,2}:\d{2}[ap]m$/);
  });

  it('returns lowercase am/pm (not AM/PM)', () => {
    const ts = '2026-04-18T09:00:00.000Z';
    const result = formatAbsoluteTime(ts);
    expect(result).not.toMatch(/[AP]M/);
  });
});
