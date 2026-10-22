import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock playwright BEFORE importing the module under test so the dynamic
// `await import('playwright')` resolves to our stub. Surface area mirrored
// from tests/computer-use/headless-registry.test.ts but instrumented for
// concurrency assertions: each context.close() does a small async yield to
// expose any race window where parallel stops could double-close or
// double-decrement.

const closeBrowserSpy = vi.fn(async () => undefined);
const closeContextSpy = vi.fn(async () => {
  // Simulate real context teardown taking a few ms — gives parallel stops
  // an opportunity to interleave between registry.delete and refcount--.
  await new Promise((r) => setTimeout(r, 5));
});
const launchSpy = vi.fn();

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => {
      launchSpy();
      return {
        isConnected: () => true,
        close: closeBrowserSpy,
        newContext: vi.fn(async () => ({
          close: closeContextSpy,
          newPage: vi.fn(async () => ({ goto: vi.fn(async () => undefined) })),
        })),
      };
    }),
  },
}));

import {
  startHeadlessSession,
  stopHeadlessSession,
  headlessSessionCount,
  hasHeadlessSession,
} from '@/lib/computer-use-headless';

describe('headless lifecycle mutex (e5708bc2 — concurrent stop safety)', () => {
  beforeEach(() => {
    closeBrowserSpy.mockClear();
    closeContextSpy.mockClear();
    launchSpy.mockClear();
  });

  afterEach(async () => {
    // Drain any leftover sessions so tests don't leak state into one another.
    for (let i = 0; i < 20; i++) {
      if (hasHeadlessSession(`cu-mt-${i}`)) await stopHeadlessSession(`cu-mt-${i}`);
    }
  });

  it('10 parallel stop calls on a single session — context closes exactly once, no orphans', async () => {
    await startHeadlessSession({ sessionId: 'cu-mt-0' });
    expect(headlessSessionCount()).toBe(1);

    // Fire 10 concurrent stops on the SAME session id. Pre-fix, multiple
    // calls could observe `_registry.has(...) === true` between yields and
    // each go on to decrement refcount. Post-fix, the lock serialises them:
    // first stop runs the full transaction, the rest see an empty registry
    // and return early.
    await Promise.all(Array.from({ length: 10 }, () => stopHeadlessSession('cu-mt-0')));

    expect(headlessSessionCount()).toBe(0);
    expect(hasHeadlessSession('cu-mt-0')).toBe(false);
    expect(closeContextSpy).toHaveBeenCalledTimes(1);
    // Browser disposed exactly once (last session out → close)
    expect(closeBrowserSpy).toHaveBeenCalledTimes(1);
  });

  it('10 parallel stops across 10 different sessions — refcount returns to baseline, browser closed once', async () => {
    // Start 10 sessions — must raise default cap (8) via maxConcurrent override.
    for (let i = 0; i < 10; i++) {
      await startHeadlessSession({ sessionId: `cu-mt-${i}`, maxConcurrent: 16 });
    }
    expect(headlessSessionCount()).toBe(10);

    // Browser launched exactly once across all starts (singleton).
    expect(launchSpy).toHaveBeenCalledTimes(1);

    // Stop all 10 in parallel. Acceptance per Jack's spec:
    // - no orphan chromium processes (browser.close called exactly once)
    // - refcount returns to baseline (no sessions remain)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => stopHeadlessSession(`cu-mt-${i}`))
    );

    expect(headlessSessionCount()).toBe(0);
    expect(closeContextSpy).toHaveBeenCalledTimes(10);
    expect(closeBrowserSpy).toHaveBeenCalledTimes(1);
  });

  it('rapid stop/start interleave — browser is not disposed while a sibling start is in flight', async () => {
    await startHeadlessSession({ sessionId: 'cu-mt-1' });
    expect(launchSpy).toHaveBeenCalledTimes(1);

    // Race: stop the only existing session AT THE SAME TIME as starting a new one.
    // Pre-fix: stop could observe (refcount==0, registry.size==0) between yields and
    // close the browser, leaving the just-started session pointing at a closed handle.
    // Post-fix: lock serialises — the start completes its refcount++ before the stop
    // gets a chance to run, OR the stop completes (and disposes browser) before the
    // start's refcount++; in the latter case ensureBrowser launches a fresh browser.
    await Promise.all([
      stopHeadlessSession('cu-mt-1'),
      startHeadlessSession({ sessionId: 'cu-mt-2' }),
    ]);

    // After the dust settles, exactly one session is alive and it has a working browser.
    expect(headlessSessionCount()).toBe(1);
    expect(hasHeadlessSession('cu-mt-2')).toBe(true);
    // Browser invariant: every browser that was opened was either still in use
    // (newest one) or properly closed. closeBrowserSpy fires either 0 or 1 times
    // depending on which arm of the race ran first; never more than once per launch.
    expect(closeBrowserSpy.mock.calls.length).toBeLessThanOrEqual(launchSpy.mock.calls.length);
  });
});
