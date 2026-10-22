
import { getWindowsProfileName } from '@/lib/home-dir';/**
 * Pure helpers for roster spawn-mode logic.
 * Used by RosterConfigModal (UNC validation, default PS path) and
 * handleRosterUpdate (spawn mode normalization).
 */

/** Returns true if path is a UNC path (\\server\share or //server/share). */
export function isUncPath(path: string): boolean {
  return path.startsWith('\\\\') || path.startsWith('//');
}

/** Default Windows working directory for a PowerShell-mode agent. */
export function getDefaultPsWorkingDirectory(agentName: string): string {
  return `C:\\Users\\${getWindowsProfileName()}\\Team\\${agentName}`;
}

/** Normalise spawnMode to a concrete value — defaults to 'wsl'. */
export function resolveSpawnMode(
  mode: 'wsl' | 'powershell' | undefined
): 'wsl' | 'powershell' {
  return mode === 'powershell' ? 'powershell' : 'wsl';
}

/**
 * PowerShell per-message mode is implemented only by the Claude harness.
 * Other harnesses (Codex, Gemini, Grok, Antigravity) always run in a
 * persistent WSL/tmux session, even if an old roster record still carries a
 * stale `spawnMode: "powershell"` from a previous Claude configuration.
 */
export function supportsPowerShellSpawn(agentType: string | undefined): boolean {
  return !agentType || agentType === 'claude';
}

/** True only when the roster entry actually uses Windows per-message mode. */
export function isWindowsPerMessageAgent(agent: {
  spawnMode?: 'wsl' | 'powershell';
  agentType?: string;
}): boolean {
  // The per-message Windows path is the CLAUDE-only claude.exe invocation
  // (spawn -p -> JSON -> --resume). Codex+powershell is a tmux-launched persistent
  // powershell.exe -> collab-codex-win.ps1 wrapper, tracked as a tmux session, so it
  // is deliberately NOT a per-message agent. Keep this claude-only and decoupled
  // from supportsPowerShellSpawn (the separate UI eligibility gate) so extending
  // that gate to Codex does not misroute Codex into the per-message path.
  return agent.spawnMode === 'powershell' && (!agent.agentType || agent.agentType === 'claude');
}
