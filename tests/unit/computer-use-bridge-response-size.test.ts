import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { _loadBridgeResponseBody } from '@/lib/computer-use-bridge';

describe('bridgeFetch response size cap (1303dca0 maxBuffer fix)', () => {
  let statSpy: ReturnType<typeof vi.spyOn>;
  let readSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    statSpy = vi.spyOn(fs, 'stat');
    readSpy = vi.spyOn(fs, 'readFile');
  });

  afterEach(() => {
    statSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('reads the response file when within cap', async () => {
    statSpy.mockResolvedValueOnce({ size: 1024 } as Awaited<ReturnType<typeof fs.stat>>);
    readSpy.mockResolvedValueOnce('{"success":true}' as never);

    const body = await _loadBridgeResponseBody('/tmp/resp.bin', 200 * 1024 * 1024);

    expect(body).toBe('{"success":true}');
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('returns empty string for empty response file (e.g. HTTP 204 No Content)', async () => {
    statSpy.mockResolvedValueOnce({ size: 0 } as Awaited<ReturnType<typeof fs.stat>>);

    const body = await _loadBridgeResponseBody('/tmp/empty.bin', 200 * 1024 * 1024);

    expect(body).toBe('');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('throws when response exceeds the byte cap (server-side validation)', async () => {
    const cap = 200 * 1024 * 1024;
    statSpy.mockResolvedValueOnce({ size: cap + 1 } as Awaited<ReturnType<typeof fs.stat>>);

    await expect(_loadBridgeResponseBody('/tmp/huge.bin', cap)).rejects.toThrow(/exceeds .* byte cap/);
    // Critical: never load oversized payload into memory
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('returns empty string when curl never wrote the file (ENOENT — network abort)', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    statSpy.mockRejectedValueOnce(err);

    const body = await _loadBridgeResponseBody('/tmp/missing.bin', 200 * 1024 * 1024);

    expect(body).toBe('');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('propagates non-ENOENT fs errors (e.g. permission denied)', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    statSpy.mockRejectedValueOnce(err);

    await expect(_loadBridgeResponseBody('/tmp/nopriv.bin', 200 * 1024 * 1024)).rejects.toThrow('EACCES');
  });

  it('handles a payload right at the cap boundary (cap exactly == size is allowed)', async () => {
    const cap = 100;
    statSpy.mockResolvedValueOnce({ size: cap } as Awaited<ReturnType<typeof fs.stat>>);
    readSpy.mockResolvedValueOnce('x'.repeat(cap) as never);

    const body = await _loadBridgeResponseBody('/tmp/edge.bin', cap);

    expect(body).toHaveLength(cap);
  });
});
