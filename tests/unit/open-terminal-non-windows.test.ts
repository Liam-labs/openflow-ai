import { describe, expect, it, vi } from 'vitest';
import { isWslVersionText, runsOnWsl, noWindowReply, NO_WINDOW_MESSAGE } from '@/lib/terminal-attach';
import { attachCommand } from '@/lib/attach-command';
import { requestRosterTerminal } from '@/lib/roster-terminal-action';

describe('Open terminal on a computer that is not Windows', () => {
  it('only a Windows (WSL) kernel counts as able to open a Windows Terminal window', async () => {
    expect(isWslVersionText('Linux version 5.15.90.1-microsoft-standard-WSL2')).toBe(true);
    expect(isWslVersionText('Linux version 6.8.0-45-generic (buildd@lcy02)')).toBe(false);
    expect(await runsOnWsl(async () => 'Linux version 6.8.0-45-generic')).toBe(false);
    expect(await runsOnWsl(async () => { throw new Error('no /proc'); })).toBe(false); // a Mac has no /proc/version
    expect(await runsOnWsl(async () => 'Linux version 5.15-microsoft-standard-WSL2')).toBe(true);
  });

  it('says plainly that no window can open, with the exact command, and never mentions Windows Terminal', () => {
    const plain = noWindowReply(attachCommand('agent-7', false));
    expect(plain).toEqual({ success: false, error: NO_WINDOW_MESSAGE, command: 'tmux attach -t agent-7' });
    expect(NO_WINDOW_MESSAGE).not.toMatch(/windows|wsl|scandir/i);
    expect(noWindowReply(attachCommand('agent-7', true)).command).toBe('docker compose exec -it openflow tmux attach -t agent-7');
  });

  it('leaves the command out when the session name is not a plain tmux name', () => {
    expect(noWindowReply(attachCommand('a b; rm -rf /', false))).toEqual({ success: false, error: NO_WINDOW_MESSAGE });
  });

  it('hands the message and the command to the dialog instead of a Windows error toast', async () => {
    const showError = vi.fn();
    const showCommand = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({ ok: false, json: async () => noWindowReply('tmux attach -t agent-7') });
    await expect(requestRosterTerminal(fetcher, 'c1', 'a1', showError, showCommand)).resolves.toBe(false);
    expect(showCommand).toHaveBeenCalledWith(NO_WINDOW_MESSAGE, 'tmux attach -t agent-7');
    expect(showError).not.toHaveBeenCalled();
  });

  it('still shows an ordinary failure as an error, and an old caller with no dialog still gets the message', async () => {
    const showError = vi.fn();
    const showCommand = vi.fn();
    const plain = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ success: false, error: 'Agent has no active tmux session' }) });
    await requestRosterTerminal(plain, 'c1', 'a1', showError, showCommand);
    expect(showError).toHaveBeenCalledWith('Agent has no active tmux session');
    expect(showCommand).not.toHaveBeenCalled();
    const withCommand = vi.fn().mockResolvedValue({ ok: false, json: async () => noWindowReply('tmux attach -t x') });
    const err2 = vi.fn();
    await requestRosterTerminal(withCommand, 'c1', 'a1', err2);
    expect(err2).toHaveBeenCalledWith(NO_WINDOW_MESSAGE);
  });
});
