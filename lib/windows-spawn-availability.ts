import { access } from 'fs/promises';
import { getWindowsHome } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';

/**
 * PowerShell (Windows per-message) agents run claude.exe from inside the DevFlow process, so they only work
 * where DevFlow itself runs on the Windows PC's WSL. Since DevFlow moved to the server there is no
 * claude.exe beside it, and a PowerShell agent used to sit in "starting" until the timeout.
 */
export const CLAUDE_EXE_WSL = `${getWindowsHome()}/.local/bin/claude.exe`;

export const WINDOWS_SPAWN_UNAVAILABLE =
  `PowerShell mode is unavailable: it runs Windows Claude inside ${PRODUCT_NAME}, and ${PRODUCT_NAME} now runs on the server. Use WSL mode (it can still drive Windows through powershell.exe).`;

export async function windowsSpawnAvailable(): Promise<boolean> {
  try {
    await access(CLAUDE_EXE_WSL);
    return true;
  } catch {
    return false;
  }
}
