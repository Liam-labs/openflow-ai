/**
 * Windows Terminal Integration
 *
 * Uses UI Automation via PowerShell to get tab names from Windows Terminal.
 * Each tab in Windows Terminal appears as a separate "window" to UI Automation.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';

const execAsync = promisify(exec);

export interface WindowsTerminalTab {
  name: string;
  processId: number;
  isActive: boolean;
}

/**
 * Get all Windows Terminal tab names via UI Automation
 */
export async function getWindowsTerminalTabs(): Promise<WindowsTerminalTab[]> {
  try {
    // Write script to temp file to avoid shell escaping issues with $variables
    const scriptPath = '/tmp/get-wt-tabs.ps1';
    const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$automation = [System.Windows.Automation.AutomationElement]
$desktop = $automation::RootElement

$classCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    "CASCADIA_HOSTING_WINDOW_CLASS"
)
$wtWindows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $classCondition)

$tabs = @()
$index = 0
foreach ($wt in $wtWindows) {
    $rect = $wt.Current.BoundingRectangle
    # Check if tab is visible (has reasonable bounds) and has keyboard focus
    $hasKeyboardFocus = $wt.Current.HasKeyboardFocus
    $isVisible = ($rect.Width -gt 0 -and $rect.Width -lt 10000 -and $rect.X -gt -1000)
    $tabs += @{
        name = $wt.Current.Name
        processId = $wt.Current.ProcessId
        isActive = $hasKeyboardFocus
        isVisible = $isVisible
        index = $index
    }
    $index++
}

$tabs | ConvertTo-Json -Depth 2 -Compress
`;

    // Write the script to a temp file
    await fs.writeFile(scriptPath, psScript);

    // Convert WSL path to Windows path and execute
    const windowsPath = scriptPath.replace('/tmp', 'C:\\temp');
    await execAsync(`mkdir -p /mnt/c/temp && cp ${scriptPath} /mnt/c/temp/get-wt-tabs.ps1`, { timeout: 8000 });

    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\temp\\get-wt-tabs.ps1"`,
      { timeout: 10000 }
    );

    if (!stdout.trim()) {
      return [];
    }

    const parsed = JSON.parse(stdout.trim());
    // Handle single item (not array)
    const tabsArray = Array.isArray(parsed) ? parsed : [parsed];

    return tabsArray.map((tab: { name: string; processId: number; isActive: boolean }) => ({
      name: tab.name || 'Untitled',
      processId: tab.processId,
      isActive: tab.isActive,
    }));
  } catch (error) {
    console.error('[WindowsTerminal] Failed to get tabs:', error);
    return [];
  }
}

/**
 * Set the title of the current terminal tab (works from WSL)
 */
export function setTerminalTitle(title: string): void {
  // This escape sequence sets the terminal title
  process.stdout.write(`\x1b]0;${title}\x07`);
}

/**
 * Get a mapping suggestion based on working directory
 */
export async function suggestTabMapping(
  projectPath: string,
  tabs: WindowsTerminalTab[]
): Promise<WindowsTerminalTab | null> {
  // Extract project name from path
  const projectName = projectPath.split('/').filter(Boolean).pop() || '';

  // Look for a tab name that contains the project name
  const match = tabs.find(tab =>
    tab.name.toLowerCase().includes(projectName.toLowerCase())
  );

  return match || null;
}
