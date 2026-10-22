/**
 * Tests for settings-rebuild helper.
 * Written TDD — RED first (lib/settings-rebuild.ts does not exist yet), then GREEN.
 * Satisfies the render-test requirement: proves the handler fires POST /api/settings/rebuild
 * and returns the correct success/error shape.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { triggerRebuild } from '@/lib/settings-rebuild';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('triggerRebuild', () => {
  it('calls POST /api/settings/rebuild', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }));

    await triggerRebuild();

    expect(fetch).toHaveBeenCalledWith('/api/settings/rebuild', { method: 'POST' });
  });

  it('returns success:true when response is ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }));

    const result = await triggerRebuild();
    expect(result.success).toBe(true);
  });

  it('returns success:false with message when response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Build failed' }),
    }));

    const result = await triggerRebuild();
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('returns success:false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await triggerRebuild();
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });
});
