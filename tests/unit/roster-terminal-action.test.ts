import { describe, expect, it, vi } from 'vitest';
import { requestRosterTerminal } from '@/lib/roster-terminal-action';

describe('requestRosterTerminal', () => {
  it('surfaces a failed roster_open_terminal response through the supplied toast callback', async () => {
    const toastError = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: 'No working WSL interop endpoint' }),
    });

    await expect(requestRosterTerminal(fetcher, 'channel-1', 'agent-1', toastError)).resolves.toBe(false);

    expect(fetcher).toHaveBeenCalledWith('/api/collab/pty', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'roster_open_terminal', channelId: 'channel-1', agentId: 'agent-1' }),
    }));
    expect(toastError).toHaveBeenCalledWith('No working WSL interop endpoint');
  });
});
