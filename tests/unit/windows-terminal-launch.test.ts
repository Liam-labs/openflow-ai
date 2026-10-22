import { describe, expect, it } from 'vitest';
import { buildWindowsTerminalAttachLaunch } from '@/lib/windows-terminal-launch';

describe('buildWindowsTerminalAttachLaunch', () => {
  it('uses the installed Windows Terminal executable and verifies its process starts', () => {
    const launch = buildWindowsTerminalAttachLaunch({
      title: 'Builder — SG-1',
      tmuxSession: 'collab-agent-df507ac9',
    });

    expect(launch.file).toBe('powershell.exe');
    expect(launch.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ]);
    const command = launch.args[5];
    expect(command).toContain('Get-AppxPackage Microsoft.WindowsTerminal');
    expect(command).toContain('$wtArgs = @(');
    expect(command).toContain('& $wt @wtArgs');
    expect(command).not.toContain('Start-Process -FilePath $wt');
    expect(command).toContain("Get-Process -Name 'WindowsTerminal'");
    expect(command).toContain("--title', 'Builder — SG-1'");
    expect(command).toContain("'C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu'");
    expect(command).toContain("'tmux', 'attach', '-t', 'collab-agent-df507ac9'");
  });
});
