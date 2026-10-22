import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import {
  _unlinkWithRetry,
  getBridgeUnlinkFailures,
  _resetBridgeUnlinkFailures,
} from '@/lib/computer-use-bridge';

describe('bridgeFetch temp-file unlink — retry + degraded surfacing', () => {
  let unlinkSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetBridgeUnlinkFailures();
    unlinkSpy = vi.spyOn(fs, 'unlink');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('happy path — unlink succeeds first try, no warning, no failure counted', async () => {
    unlinkSpy.mockResolvedValueOnce(undefined);

    await _unlinkWithRetry('/tmp/foo.json');

    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(getBridgeUnlinkFailures().count).toBe(0);
  });

  it('ENOENT on first try is idempotent success — no retry, no warning', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    unlinkSpy.mockRejectedValueOnce(err);

    await _unlinkWithRetry('/tmp/already-gone.json');

    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getBridgeUnlinkFailures().count).toBe(0);
  });

  it('EBUSY on first try, success on retry — warning logged, no failure counted', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    unlinkSpy.mockRejectedValueOnce(err);
    unlinkSpy.mockResolvedValueOnce(undefined);

    await _unlinkWithRetry('/tmp/busy.json');

    expect(unlinkSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('EBUSY');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(getBridgeUnlinkFailures().count).toBe(0);
  });

  it('persistent failure — warning + error logged, count and timestamp surface as degraded', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    unlinkSpy.mockRejectedValue(err);

    await _unlinkWithRetry('/tmp/persistent.json');

    expect(unlinkSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('cumulativeFailures=1');

    const state = getBridgeUnlinkFailures();
    expect(state.count).toBe(1);
    expect(state.lastAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('multiple persistent failures accumulate the count', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    unlinkSpy.mockRejectedValue(err);

    await _unlinkWithRetry('/tmp/a.json');
    await _unlinkWithRetry('/tmp/b.json');
    await _unlinkWithRetry('/tmp/c.json');

    expect(getBridgeUnlinkFailures().count).toBe(3);
  });
});
