import { beforeEach, describe, expect, it, vi } from 'vitest';

const forceKillPtySession = vi.fn();
const forceKillByTmuxName = vi.fn();
const safeKillProcess = vi.fn();
const cleanupTempFiles = vi.fn();

vi.mock('@/lib/collab-pty', async () => {
  const actual = await vi.importActual<typeof import('@/lib/collab-pty')>('@/lib/collab-pty');
  return {
    ...actual,
    forceKillPtySession,
    forceKillByTmuxName,
    safeKillProcess,
    cleanupTempFiles,
  };
});

describe('roster PowerShell runtime shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forceKillPtySession.mockResolvedValue(true);
    forceKillByTmuxName.mockResolvedValue(true);
    safeKillProcess.mockResolvedValue(undefined);
    cleanupTempFiles.mockResolvedValue(undefined);
  });

  it('kills the exact Windows PTY before roster metadata is cleared', async () => {
    const { stopRosterAgentRuntime } = await import(
      '@/app/api/collab/pty/_handlers/message-inject'
    );

    await stopRosterAgentRuntime({
      spawnMode: 'powershell',
      ptySessionId: 'windows-session-1',
    });

    expect(forceKillPtySession).toHaveBeenCalledOnce();
    expect(forceKillPtySession).toHaveBeenCalledWith('windows-session-1');
    expect(forceKillByTmuxName).not.toHaveBeenCalled();
    expect(safeKillProcess).not.toHaveBeenCalled();
  });
});
