/**
 * Unit tests for the screenshot monitor=0 default (audit task 6931d9a6).
 *
 * Owner runs dual monitors. The bridge defaulted to monitor=1 (primary),
 * which silently hid apps on the secondary display. The agent-API screenshot
 * handler now injects monitor=0 (all screens) when the caller omits it.
 * Explicit monitor values (0, 1, 2, …) are passed through unchanged.
 */

import { describe, it, expect } from 'vitest';
import { applyScreenshotDefaults } from '@/app/api/agent/actions/computer-use';

describe('applyScreenshotDefaults', () => {
  it('injects monitor=0 when monitor is undefined', () => {
    const result = applyScreenshotDefaults({ sessionId: 'cu-x' });
    expect(result.monitor).toBe(0);
    expect(result.sessionId).toBe('cu-x');
  });

  it('injects monitor=0 when monitor key is missing entirely', () => {
    const result = applyScreenshotDefaults({});
    expect(result.monitor).toBe(0);
  });

  it('respects explicit monitor=1 (primary only)', () => {
    const result = applyScreenshotDefaults({ sessionId: 'cu-x', monitor: 1 });
    expect(result.monitor).toBe(1);
  });

  it('respects explicit monitor=0 (all screens)', () => {
    const result = applyScreenshotDefaults({ sessionId: 'cu-x', monitor: 0 });
    expect(result.monitor).toBe(0);
  });

  it('respects explicit monitor=2 (secondary)', () => {
    const result = applyScreenshotDefaults({ sessionId: 'cu-x', monitor: 2 });
    expect(result.monitor).toBe(2);
  });

  it('preserves all other body fields untouched', () => {
    const result = applyScreenshotDefaults({
      sessionId: 'cu-x',
      format: 'png',
      quality: 80,
      scale: 0.5,
      preset: 'quick',
    });
    expect(result).toEqual({
      sessionId: 'cu-x',
      format: 'png',
      quality: 80,
      scale: 0.5,
      preset: 'quick',
      monitor: 0,
    });
  });

  it('treats null monitor as missing (defaults to 0)', () => {
    const result = applyScreenshotDefaults({ sessionId: 'cu-x', monitor: null });
    expect(result.monitor).toBe(0);
  });

  it('does not mutate the input object', () => {
    const input = { sessionId: 'cu-x' };
    applyScreenshotDefaults(input);
    expect(input).not.toHaveProperty('monitor');
  });
});
