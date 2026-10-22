import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  bridgeFetch,
  isRecoverableFailure,
  getBridgeRecoveryStats,
  _resetBridgeRecoveryState,
  _setBridgeRecoveryDeps,
} from '@/lib/computer-use-bridge';
import { ComputerUseError } from '@/lib/computer-use';

const HEALTHY = { ok: true, url: 'http://localhost:2150', checkedAt: '2026-04-27T00:00:00Z' };
const UNHEALTHY = { ok: false, url: 'http://localhost:2150', checkedAt: '2026-04-27T00:00:00Z' };

const SUCCESS_RES = {
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({ success: true }),
  text: async () => '{"success":true}',
};

function makeFetchSpy(behaviour: Array<{ throw?: Error; resolve?: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const step = behaviour[i] ?? behaviour[behaviour.length - 1];
    i++;
    if (step.throw) throw step.throw;
    return step.resolve as Awaited<ReturnType<typeof bridgeFetch>>;
  });
}

beforeEach(() => {
  _resetBridgeRecoveryState();
});

afterEach(() => {
  _resetBridgeRecoveryState();
});

// ─── §5: classification table ────────────────────────────────────────────────

describe('isRecoverableFailure (design §5)', () => {
  it.each([
    ['ECONNREFUSED', new Error('connect ECONNREFUSED 127.0.0.1:2150'), true],
    ['fetch failed (Node 18+)', new Error('fetch failed'), true],
    ['AbortError / timeout', new Error('Bridge request timed out (15s)'), true],
    ['reset by peer', new Error('socket reset by peer'), true],
    ['plain bridge unreachable', new Error('Bridge unreachable: ECONNREFUSED'), true],
  ])('%s → recoverable', (_label, err, expected) => {
    expect(isRecoverableFailure(err)).toBe(expected);
  });

  it.each([
    ['domain validation', new ComputerUseError('bad input', 'COMPUTER_USE_VALIDATION_INVALID', 400)],
    ['session not found', new ComputerUseError('no session', 'COMPUTER_USE_SESSION_NOT_FOUND', 404)],
    ['CU disabled', new ComputerUseError('off', 'COMPUTER_USE_DISABLED', 403)],
    ['token missing', new ComputerUseError('no token', 'COMPUTER_USE_TOKEN_MISSING', 500)],
  ])('%s → NOT recoverable', (_label, err) => {
    expect(isRecoverableFailure(err)).toBe(false);
  });

  it('returns false for null/undefined input', () => {
    expect(isRecoverableFailure(null)).toBe(false);
    expect(isRecoverableFailure(undefined)).toBe(false);
  });
});

// ─── Recovery flow ───────────────────────────────────────────────────────────

describe('bridgeFetch — auto-recovery flow', () => {
  it('one-shot restart succeeds → state HEALTHY, retry returns response', async () => {
    const fetchSpy = makeFetchSpy([
      { throw: new Error('fetch failed') },
      { resolve: SUCCESS_RES },
    ]);
    const startSpy = vi.fn(async () => ({ url: 'http://localhost:2150', alreadyRunning: false }));
    const healthSpy = vi.fn(async () => UNHEALTHY).mockImplementationOnce(async () => UNHEALTHY)
      .mockImplementationOnce(async () => HEALTHY);

    _setBridgeRecoveryDeps({
      fetch: fetchSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['fetch'],
      checkHealth: healthSpy,
      start: startSpy,
    });

    const res = await bridgeFetch('http://localhost:2150/click');
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // initial + retry
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(getBridgeRecoveryStats().state).toBe('HEALTHY');
    expect(getBridgeRecoveryStats().successfulRecoveries).toBe(1);
  });

  it('persistent failure → state DOWN, original error surfaced, no second restart', async () => {
    const originalErr = new Error('fetch failed');
    const fetchSpy = makeFetchSpy([{ throw: originalErr }]);
    const startSpy = vi.fn(async () => ({ url: 'http://localhost:2150', alreadyRunning: false }));
    const healthSpy = vi.fn(async () => UNHEALTHY); // never recovers

    _setBridgeRecoveryDeps({
      fetch: fetchSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['fetch'],
      checkHealth: healthSpy,
      start: startSpy,
    });

    await expect(bridgeFetch('http://localhost:2150/click')).rejects.toBe(originalErr);

    expect(startSpy).toHaveBeenCalledTimes(1);
    const stats = getBridgeRecoveryStats();
    expect(stats.state).toBe('DOWN');
    expect(stats.failedRecoveries).toBe(1);
    expect(stats.cooldownExpiresAt).not.toBeNull();
  });

  it('cooldown blocks new attempts → fast-fails with BRIDGE_UNAVAILABLE, startBridge NOT called', async () => {
    // Drive state to DOWN first.
    const fetchSpy = makeFetchSpy([{ throw: new Error('fetch failed') }]);
    const startSpy = vi.fn(async () => ({ url: 'http://localhost:2150', alreadyRunning: false }));
    const healthSpy = vi.fn(async () => UNHEALTHY);
    _setBridgeRecoveryDeps({
      fetch: fetchSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['fetch'],
      checkHealth: healthSpy,
      start: startSpy,
    });
    await expect(bridgeFetch('http://localhost:2150/click')).rejects.toThrow();
    expect(getBridgeRecoveryStats().state).toBe('DOWN');

    // Now a second call within cooldown — should fast-fail without invoking startBridge again.
    startSpy.mockClear();
    fetchSpy.mockClear();
    await expect(bridgeFetch('http://localhost:2150/click')).rejects.toMatchObject({
      code: 'COMPUTER_USE_BRIDGE_UNAVAILABLE',
    });
    expect(startSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // fast-fail before fetch attempted
  });

  it('concurrent failing fetches deduplicate to ONE startBridge call', async () => {
    let fetchCalls = 0;
    const fetchSpy = vi.fn(async () => {
      fetchCalls++;
      if (fetchCalls <= 10) throw new Error('fetch failed');
      return SUCCESS_RES as Awaited<ReturnType<typeof bridgeFetch>>;
    });
    const startSpy = vi.fn(async () => {
      // Simulate slow restart so concurrent callers all wait on the same promise.
      await new Promise((r) => setTimeout(r, 20));
      return { url: 'http://localhost:2150', alreadyRunning: false };
    });
    const healthSpy = vi.fn(async () => UNHEALTHY)
      .mockImplementationOnce(async () => UNHEALTHY)
      .mockImplementationOnce(async () => HEALTHY); // re-probe after restart succeeds

    _setBridgeRecoveryDeps({
      fetch: fetchSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['fetch'],
      checkHealth: healthSpy,
      start: startSpy,
    });

    // Fire 10 in parallel.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => bridgeFetch('http://localhost:2150/click'))
    );

    expect(startSpy).toHaveBeenCalledTimes(1); // dedupe via _recoveryPromise
    // All 10 saw the same recovery outcome — either all fulfilled (retry succeeds)
    // or all rejected (retry fails). Mixed results would indicate dedupe leak.
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled + rejected).toBe(10);
  });

  it('port collision → COMPUTER_USE_BRIDGE_PORT_HELD with hint, NO retry', async () => {
    const fetchSpy = makeFetchSpy([{ throw: new Error('fetch failed') }]);
    // startBridge says "already running" but health re-probe still fails →
    // something else is bound to the port.
    const startSpy = vi.fn(async () => ({ url: 'http://localhost:2150', alreadyRunning: true }));
    const healthSpy = vi.fn(async () => UNHEALTHY);

    _setBridgeRecoveryDeps({
      fetch: fetchSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['fetch'],
      checkHealth: healthSpy,
      start: startSpy,
    });

    const err = await bridgeFetch('http://localhost:2150/click').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputerUseError);
    expect((err as ComputerUseError).code).toBe('COMPUTER_USE_BRIDGE_PORT_HELD');
    expect((err as ComputerUseError).context).toMatchObject({ port: 2150 });
    expect((err as ComputerUseError).context?.hint).toContain('netstat');
  });

  it('does NOT retry on ComputerUseError validation/domain failure', async () => {
    const domainErr = new ComputerUseError('bad x coord', 'COMPUTER_USE_VALIDATION_INVALID_COORD', 400);
    const fetchSpy = makeFetchSpy([{ throw: domainErr }]);
    const startSpy = vi.fn();
    const healthSpy = vi.fn();

    _setBridgeRecoveryDeps({
      fetch: fetchSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['fetch'],
      checkHealth: healthSpy as unknown as typeof HEALTHY extends infer T ? () => Promise<T> : never,
      start: startSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['start'],
    });

    await expect(bridgeFetch('http://localhost:2150/click')).rejects.toBe(domainErr);
    expect(startSpy).not.toHaveBeenCalled();
    expect(getBridgeRecoveryStats().state).toBe('HEALTHY'); // never transitioned
  });

  it('initial transient — bridge already healthy by recovery probe → no restart needed', async () => {
    // Fetch fails once, but checkHealth in attemptRecovery sees the bridge come back.
    // No startBridge call — recovered:true, restarted:false.
    const fetchSpy = makeFetchSpy([
      { throw: new Error('fetch failed') },
      { resolve: SUCCESS_RES },
    ]);
    const startSpy = vi.fn();
    const healthSpy = vi.fn(async () => HEALTHY); // already healthy on first probe

    _setBridgeRecoveryDeps({
      fetch: fetchSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['fetch'],
      checkHealth: healthSpy,
      start: startSpy as unknown as Parameters<typeof _setBridgeRecoveryDeps>[0]['start'],
    });

    const res = await bridgeFetch('http://localhost:2150/click');
    expect(res.ok).toBe(true);
    expect(startSpy).not.toHaveBeenCalled(); // §4: re-probe before restart
    expect(getBridgeRecoveryStats().successfulRecoveries).toBe(1);
  });
});

// ─── Stats surface ──────────────────────────────────────────────────────────

describe('getBridgeRecoveryStats', () => {
  it('returns baseline state when nothing has happened', () => {
    const s = getBridgeRecoveryStats();
    expect(s.state).toBe('HEALTHY');
    expect(s.totalRecoveryAttempts).toBe(0);
    expect(s.successfulRecoveries).toBe(0);
    expect(s.failedRecoveries).toBe(0);
    expect(s.lastRecoveryAt).toBeNull();
    expect(s.cooldownExpiresAt).toBeNull();
  });
});
