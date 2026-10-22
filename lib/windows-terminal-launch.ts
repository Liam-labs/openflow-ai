/**
 * Build a Windows-host launch command from a WSL-hosted DevFlow process.
 *
 * The `wt.exe` app-execution alias can report success while doing nothing when
 * invoked from WSL. Resolve the installed package executable on the Windows
 * host, start it with PowerShell, and require a WindowsTerminal process before
 * the caller treats the launch as successful.
 */
export function buildWindowsTerminalAttachLaunch({
  title,
  tmuxSession,
}: {
  title: string;
  tmuxSession: string;
}): { file: 'powershell.exe'; args: string[] } {
  const safeTitle = title.replace(/["\r\n]/g, '');
  const terminalArgs = [
    '-w', '0', 'new-tab', '-p', 'Ubuntu', '--title', safeTitle,
    // Do not rely on the Windows Terminal tab inheriting a usable PATH from
    // the WSL-hosted DevFlow process. `wsl.exe` is guaranteed at this path on
    // supported Windows hosts, while a PATH lookup can produce 0x80070002.
    '--', 'C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--', 'tmux', 'attach', '-t', tmuxSession,
  ].map(argument => `'${argument.replace(/'/g, "''")}'`).join(', ');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$package = Get-AppxPackage Microsoft.WindowsTerminal | Select-Object -First 1',
    "if ($null -eq $package) { throw 'Windows Terminal is not installed' }",
    "$wt = Join-Path $package.InstallLocation 'wt.exe'",
    "if (-not (Test-Path $wt)) { throw 'Windows Terminal executable not found' }",
    "Set-Location 'C:\\'",
    `$wtArgs = @(${terminalArgs})`,
    // Start-Process flattens an argument array into one command-line string,
    // losing the title/command boundary. Native PowerShell invocation preserves
    // each Windows Terminal argument as a distinct argv element.
    '& $wt @wtArgs',
    'Start-Sleep -Milliseconds 1500',
    "if ($null -eq (Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue)) { throw 'Windows Terminal process did not start' }",
  ].join('; ');

  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ],
  };
}
