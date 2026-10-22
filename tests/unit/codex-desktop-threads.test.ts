import { describe, expect, it, vi } from 'vitest';

import {
  createCodexDesktopProcessEnvironment,
  createCodexDesktopBridgeThreadCreator,
  createCodexDesktopThreadLister,
  ensureCodexDesktopBridgeThread,
} from '@/lib/codex-desktop-threads';

describe('Codex Desktop thread list', () => {
  it('replaces a stale inherited WSL interop socket before launching Codex Desktop', async () => {
    const resolveInterop = vi.fn().mockResolvedValue('/run/WSL/26189_interop');

    await expect(createCodexDesktopProcessEnvironment(resolveInterop)).resolves.toMatchObject({
      WSL_INTEROP: '/run/WSL/26189_interop',
    });
    expect(resolveInterop).toHaveBeenCalledOnce();
  });

  it('returns bounded user-facing metadata for Windows Desktop chats', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        id: 'thread-1', sessionId: 'session-1', name: ' Build the portal ',
        preview: 'Finish the dashboard\nwith a clean picker',
        cwd: 'C:\\Users\\winuser\\Documents\\Codex\\portal',
        updatedAt: 1786521600,
        source: 'vscode', ephemeral: false, historyMode: 'paginated',
      }, {
        id: 'cli-thread', sessionId: 'cli-thread', name: 'CLI work', preview: '',
        cwd: 'C:\\Users\\winuser', updatedAt: 1786521500, source: 'cli', ephemeral: false,
      }],
    });
    const list = createCodexDesktopThreadLister({ rpc });

    await expect(list()).resolves.toEqual([{
      id: 'thread-1', sessionId: 'session-1', title: 'Build the portal',
      project: 'portal', updatedAt: '2026-08-12T08:00:00.000Z',
      cwd: 'C:\\Users\\winuser\\Documents\\Codex\\portal', historyMode: 'paginated',
    }]);
  });

  it('creates a named legacy bridge thread for a paginated Desktop chat', async () => {
    const source = {
      id: 'thread-1', sessionId: 'session-1', title: 'Life Admin', project: 'you-x20',
      updatedAt: '2026-08-29T12:18:41.000Z', cwd: 'C:\\Users\\winuser\\Documents\\Codex\\you-x20',
      historyMode: 'paginated' as const,
    };
    const rpc = vi.fn().mockResolvedValue({
      thread: { id: 'thread-bridge', sessionId: 'session-bridge' },
    });
    const createBridge = createCodexDesktopBridgeThreadCreator({ rpc });

    await expect(ensureCodexDesktopBridgeThread(source, createBridge)).resolves.toMatchObject({
      id: 'thread-bridge', sessionId: 'session-bridge', title: 'Life Admin · AgentChat',
      historyMode: 'legacy', cwd: source.cwd,
    });
    expect(rpc).toHaveBeenCalledWith({ cwd: source.cwd, name: 'Life Admin · AgentChat' });
  });

  it('reuses an existing legacy Desktop chat without creating a replacement', async () => {
    const source = {
      id: 'thread-1', sessionId: 'session-1', title: 'Drone Hub', project: 'drone-hub',
      updatedAt: '2026-08-29T12:18:41.000Z', cwd: 'C:\\projects\\drone-hub',
      historyMode: 'legacy' as const,
    };
    const createBridge = vi.fn();

    await expect(ensureCodexDesktopBridgeThread(source, createBridge)).resolves.toBe(source);
    expect(createBridge).not.toHaveBeenCalled();
  });

  it('fails closed on malformed app-server thread identities', async () => {
    const list = createCodexDesktopThreadLister({ rpc: async () => ({
      data: [{ id: '../bad', sessionId: 'session-1', source: 'vscode' }],
    }) });

    await expect(list()).resolves.toEqual([]);
  });
});
