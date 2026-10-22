/**
 * Unit tests for the bridge shutdown decision logic.
 *
 * Covers the P0 race fix: closing a headless session must not trigger
 * bridge idle shutdown when a desktop session is still active, and
 * closing the last desktop session must trigger shutdown even if
 * headless sessions remain (bridge is desktop-only).
 */

import { describe, it, expect } from 'vitest';
import { countActiveDesktopSessions } from '@/app/api/agent/actions/computer-use';
import type { ComputerUseSession } from '@/lib/types';

function makeSession(overrides: Partial<ComputerUseSession>): ComputerUseSession {
  return {
    id: overrides.id ?? 'cu-test',
    status: overrides.status ?? 'active',
    bridgeUrl: '',
    bridgeReachable: false,
    target: 'desktop',
    actions: [],
    createdAt: new Date().toISOString(),
    createdBy: 'test',
    ...overrides,
  };
}

describe('countActiveDesktopSessions', () => {
  it('returns 0 for empty array', () => {
    expect(countActiveDesktopSessions([])).toBe(0);
  });

  it('counts active desktop sessions (mode undefined ⇒ desktop)', () => {
    const sessions = [
      makeSession({ id: 'a', status: 'active' }),
      makeSession({ id: 'b', status: 'active' }),
    ];
    expect(countActiveDesktopSessions(sessions)).toBe(2);
  });

  it('counts active desktop sessions (mode explicitly desktop)', () => {
    const sessions = [
      makeSession({ id: 'a', status: 'active', mode: 'desktop' }),
    ];
    expect(countActiveDesktopSessions(sessions)).toBe(1);
  });

  it('excludes closed sessions', () => {
    const sessions = [
      makeSession({ id: 'a', status: 'active' }),
      makeSession({ id: 'b', status: 'closed' }),
    ];
    expect(countActiveDesktopSessions(sessions)).toBe(1);
  });

  it('excludes headless sessions (bridge is desktop-only)', () => {
    const sessions = [
      makeSession({ id: 'a', status: 'active', mode: 'headless' }),
      makeSession({ id: 'b', status: 'active', mode: 'headless' }),
    ];
    expect(countActiveDesktopSessions(sessions)).toBe(0);
  });

  it('returns 0 when only headless remain after desktop close (triggers shutdown)', () => {
    // Scenario: desktop just marked closed, headless still active.
    // Expected: count = 0, bridge shutdown SHOULD be scheduled (bridge is desktop-only).
    const sessions = [
      makeSession({ id: 'desktop', status: 'closed' }),
      makeSession({ id: 'headless', status: 'active', mode: 'headless' }),
    ];
    expect(countActiveDesktopSessions(sessions)).toBe(0);
  });

  it('returns 1 when desktop active + headless closed (does NOT shut down)', () => {
    // Scenario: headless just marked closed, desktop still active.
    // Expected: count = 1, bridge shutdown SHOULD NOT be scheduled.
    const sessions = [
      makeSession({ id: 'desktop', status: 'active' }),
      makeSession({ id: 'headless', status: 'closed', mode: 'headless' }),
    ];
    expect(countActiveDesktopSessions(sessions)).toBe(1);
  });

  it('returns count of active desktops in mixed environment', () => {
    const sessions = [
      makeSession({ id: '1', status: 'active' }),                    // desktop active
      makeSession({ id: '2', status: 'active', mode: 'headless' }), // headless active (excluded)
      makeSession({ id: '3', status: 'closed' }),                    // desktop closed
      makeSession({ id: '4', status: 'active', mode: 'desktop' }),  // desktop active
      makeSession({ id: '5', status: 'error' }),                     // desktop error (excluded — not active)
    ];
    expect(countActiveDesktopSessions(sessions)).toBe(2);
  });
});
