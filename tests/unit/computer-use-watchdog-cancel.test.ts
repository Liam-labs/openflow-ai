/**
 * Unit tests for the max-backend watchdog cancel propagation (audit c13b9b8c).
 *
 * Covers:
 * - Cancel call succeeds first try
 * - Cancel succeeds after one retry (transient network error)
 * - Cancel fails all retries → fallback path
 * - Bounded retries (does not retry forever)
 * - Token + URL composition for the cancel POST
 * - Tmux session name lookup for the fallback path
 */

import { describe, it, expect, vi } from 'vitest';
import {
  cancelTerminalTaskWithRetries,
  getTerminalTaskTmuxName,
} from '@/app/api/agent/actions/computer-use';

const noSleep = (_ms: number) => Promise.resolve();

describe('cancelTerminalTaskWithRetries', () => {
  it('returns ok=true on first successful attempt', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await cancelTerminalTaskWithRetries('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and succeeds on attempt 2', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await cancelTerminalTaskWithRetries('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('retries on non-2xx response and gives up after maxAttempts', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const result = await cancelTerminalTaskWithRetries('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
      sleep: noSleep,
      maxAttempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('returns ok=false when network is fully unreachable for all retries', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await cancelTerminalTaskWithRetries('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
      sleep: noSleep,
      maxAttempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('respects custom maxAttempts', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await cancelTerminalTaskWithRetries('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
      sleep: noSleep,
      maxAttempts: 5,
    });
    expect(result.attempts).toBe(5);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('sends Authorization header with token and the right body', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await cancelTerminalTaskWithRetries('term-XYZ', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'my-secret-token',
      baseUrl: 'http://test:3000',
      sleep: noSleep,
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test:3000/api/terminal-tasks');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-secret-token');
    expect(init.body).toBe(JSON.stringify({ action: 'cancel', taskId: 'term-XYZ' }));
  });

  it('sends no Authorization header when token resolution returns null', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await cancelTerminalTaskWithRetries('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => null,
      baseUrl: 'http://localhost:3000',
      sleep: noSleep,
    });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('uses exponential backoff between attempts', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn().mockRejectedValue(new Error('boom'));
    await cancelTerminalTaskWithRetries('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
      sleep: async (ms: number) => { sleeps.push(ms); },
      maxAttempts: 3,
    });
    // 3 attempts → 2 sleeps between them: 200, 400
    expect(sleeps).toEqual([200, 400]);
  });
});

describe('getTerminalTaskTmuxName', () => {
  it('returns the tmux session name on success', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ task: { tmuxSessionName: 'terminal-task-abc123' } }),
    });
    const name = await getTerminalTaskTmuxName('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
    });
    expect(name).toBe('terminal-task-abc123');
  });

  it('returns null when the response is non-2xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const name = await getTerminalTaskTmuxName('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
    });
    expect(name).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const name = await getTerminalTaskTmuxName('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
    });
    expect(name).toBeNull();
  });

  it('returns null when payload has no task or no tmuxSessionName', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ task: {} }),
    });
    const name = await getTerminalTaskTmuxName('term-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://localhost:3000',
    });
    expect(name).toBeNull();
  });
});
