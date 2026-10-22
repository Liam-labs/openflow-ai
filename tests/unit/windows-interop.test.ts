import { describe, expect, it, vi } from 'vitest';
import { selectWorkingWslInterop } from '@/lib/windows-interop';

describe('selectWorkingWslInterop', () => {
  it('skips stale sockets and returns the first endpoint that can launch a Windows command', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('Invalid argument'))
      .mockResolvedValueOnce(undefined);

    await expect(selectWorkingWslInterop([
      '/run/WSL/6909_interop',
      '/run/WSL/15807_interop',
    ], probe)).resolves.toBe('/run/WSL/15807_interop');

    expect(probe).toHaveBeenNthCalledWith(1, '/run/WSL/6909_interop');
    expect(probe).toHaveBeenNthCalledWith(2, '/run/WSL/15807_interop');
  });

  it('fails before launch when every available endpoint is unusable', async () => {
    await expect(selectWorkingWslInterop(
      ['/run/WSL/1_interop', '/run/WSL/2_interop'],
      vi.fn().mockRejectedValue(new Error('Invalid argument')),
    )).rejects.toThrow('No working WSL interop endpoint');
  });
});
