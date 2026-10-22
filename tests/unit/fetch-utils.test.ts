import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateBodySize, fetchWithTimeout } from '@/lib/fetch-utils';

describe('validateBodySize', () => {
  it('returns null when Content-Length is absent', () => {
    const req = new Request('http://localhost/', { method: 'POST' });
    expect(validateBodySize(req)).toBeNull();
  });

  it('returns null when Content-Length is within default limit', () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-length': '999999' },
    });
    expect(validateBodySize(req)).toBeNull();
  });

  it('returns null when Content-Length equals the limit (not strictly over)', () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-length': '1000000' },
    });
    expect(validateBodySize(req)).toBeNull();
  });

  it('returns 413 when Content-Length exceeds default 1MB limit', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-length': '1000001' },
    });
    const result = validateBodySize(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(413);
    const body = await result!.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('too large');
  });

  it('respects a custom maxBytes limit', () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-length': '501' },
    });
    expect(validateBodySize(req, 500)).not.toBeNull();
    expect(validateBodySize(req, 1000)).toBeNull();
  });

  it('returns null for non-numeric Content-Length', () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-length': 'banana' },
    });
    expect(validateBodySize(req)).toBeNull();
  });
});

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls global fetch with an AbortSignal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    await fetchWithTimeout('http://example.com/');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes through additional fetch options', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    await fetchWithTimeout('http://example.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('returns the response from fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
    ));

    const res = await fetchWithTimeout('http://example.com/');
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('uses the default 10s timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await fetchWithTimeout('http://example.com/');

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('respects a custom timeout value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await fetchWithTimeout('http://example.com/', {}, 30_000);

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });
});
