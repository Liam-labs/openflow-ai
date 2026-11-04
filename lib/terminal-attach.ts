/**
 * "Open terminal" for a roster agent.
 *
 * OpenFlow can open a Windows Terminal window only when it runs inside Windows (WSL). On a Mac, a Linux server or inside the
 * container, trying that gave "Failed to open Windows Terminal tab ... scandir /run/WSL". There the person opens a terminal
 * themselves, so the server says so plainly and gives the exact command (lib/attach-command.ts, the same text the silent-agent
 * note shows).
 */
import { promises as fs } from 'fs';

export function isWslVersionText(procVersion: string): boolean {
  return /microsoft/i.test(procVersion);
}

export async function runsOnWsl(read: (file: string) => Promise<string> = (f) => fs.readFile(f, 'utf-8')): Promise<boolean> {
  try { return isWslVersionText(await read('/proc/version')); } catch { return false; }
}

export const NO_WINDOW_MESSAGE =
  "OpenFlow can't open a terminal window on this computer. Open a terminal yourself and run the command below to see this agent's screen.";

/** The reply for a computer that cannot open a window. `command` is absent when the session name is not a plain tmux name. */
export function noWindowReply(command: string | undefined): { success: false; error: string; command?: string } {
  return { success: false, error: NO_WINDOW_MESSAGE, ...(command ? { command } : {}) };
}
