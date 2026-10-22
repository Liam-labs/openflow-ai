/**
 * Unit tests for resolveTaskTimeout (audit task ae690a4e).
 *
 * Default bumped 5min → 15min — the previous 5min timed out real flows
 * (Outlook profile dialog hit 4m44s). Warning surfaces for explicit timeouts
 * below 10min so AI-loop callers can detect under-spec'd configs.
 *
 * Acceptance:
 *   - default = 15min
 *   - explicit timeoutMs respected (within [10s, 30min] clamp)
 *   - warning emitted when explicit timeoutMs < 600_000ms
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTaskTimeout,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  RECOMMENDED_MIN_TIMEOUT_MS,
} from '@/app/api/agent/actions/computer-use';

describe('resolveTaskTimeout', () => {
  it('defaults to 15 minutes when timeoutMs is undefined', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(900_000);
    const result = resolveTaskTimeout(undefined);
    expect(result.timeoutMs).toBe(900_000);
    expect(result.warning).toBeUndefined();
  });

  it('respects explicit timeoutMs >= 10 minutes (recommended threshold)', () => {
    expect(RECOMMENDED_MIN_TIMEOUT_MS).toBe(600_000);
    const result = resolveTaskTimeout(600_000);
    expect(result.timeoutMs).toBe(600_000);
    expect(result.warning).toBeUndefined();
  });

  it('respects explicit timeoutMs equal to default 15 minutes', () => {
    const result = resolveTaskTimeout(900_000);
    expect(result.timeoutMs).toBe(900_000);
    expect(result.warning).toBeUndefined();
  });

  it('emits warning when explicit timeoutMs is below 10 minutes', () => {
    const result = resolveTaskTimeout(300_000); // 5 min — old default
    expect(result.timeoutMs).toBe(300_000);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('600000');
  });

  it('emits warning when explicit timeoutMs is just under threshold', () => {
    const result = resolveTaskTimeout(599_999);
    expect(result.warning).toBeDefined();
  });

  it('does NOT emit warning when timeoutMs is exactly the threshold', () => {
    const result = resolveTaskTimeout(600_000);
    expect(result.warning).toBeUndefined();
  });

  it('clamps to MAX_TIMEOUT_MS (30 min) when caller asks for more', () => {
    expect(MAX_TIMEOUT_MS).toBe(1_800_000);
    const result = resolveTaskTimeout(3_600_000); // 60 min
    expect(result.timeoutMs).toBe(1_800_000);
  });

  it('clamps tiny inputs to the 10-second floor', () => {
    const result = resolveTaskTimeout(1_000); // 1s
    expect(result.timeoutMs).toBe(10_000);
    // Clamped value below threshold still warns the caller about the original intent
    expect(result.warning).toBeDefined();
  });

  it('treats zero as defaulting (treated as falsy)', () => {
    const result = resolveTaskTimeout(0);
    expect(result.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(result.warning).toBeUndefined();
  });

  it('returns warning that mentions both the recommendation and the actual value', () => {
    const result = resolveTaskTimeout(120_000); // 2 min
    expect(result.warning).toContain('120000');
    expect(result.warning).toContain('600000');
  });
});
