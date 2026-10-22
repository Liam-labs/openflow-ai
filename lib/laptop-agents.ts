// "Runs on" for roster agents: Desktop (WSL), Desktop (PowerShell) or Laptop.
// The roster field is `runLocation`: 'server' = the agent program runs on the laptop
// (the DevFlow server); unset = the desktop. Pure helpers, no React.

export type RunsOn = 'wsl' | 'powershell' | 'laptop';
export type LaptopMode = 'files-only' | 'files-and-commands';

export interface LaptopStatus {
  ready: boolean;
  mode: LaptopMode | null;
  /** Why the laptop option is off (empty when ready). */
  reason: string;
  /** Id of the first failing readiness check, e.g. 'program' or 'signed-in'. */
  failingCheckId?: string;
}

export const LAPTOP_NOT_SET_UP = "Laptop agents aren't set up yet.";

/** Turn the GET /api/system/laptop-agents response into what the UI needs. A 404 or any failure means not ready. */
export function parseLaptopStatus(httpOk: boolean, body: unknown): LaptopStatus {
  if (!httpOk || !body || typeof body !== 'object') return { ready: false, mode: null, reason: LAPTOP_NOT_SET_UP };
  const data = body as { ready?: unknown; mode?: unknown; checks?: unknown };
  const mode: LaptopMode | null = data.mode === 'files-only' || data.mode === 'files-and-commands' ? data.mode : null;
  if (data.ready === true) return { ready: true, mode, reason: '' };
  const checks = Array.isArray(data.checks) ? data.checks as Array<{ id?: unknown; ok?: unknown; detail?: unknown; label?: unknown }> : [];
  const failing = checks.find(check => check && check.ok === false);
  const reason = (failing && (typeof failing.detail === 'string' && failing.detail ? failing.detail : typeof failing.label === 'string' ? failing.label : '')) || LAPTOP_NOT_SET_UP;
  const failingCheckId = failing && typeof failing.id === 'string' ? failing.id : undefined;
  return { ready: false, mode, reason, ...(failingCheckId ? { failingCheckId } : {}) };
}

/** Tooltip for the Laptop badge and the Laptop option, by mode. */
export function laptopTooltip(mode: LaptopMode | null): string {
  return mode === 'files-and-commands'
    ? 'Runs on the Remote server. Files and commands go to the desktop.'
    : 'Runs on the Remote server. Files are shared from the desktop; commands run on the server.';
}

export function runsOnOf(agent: { runLocation?: string | null; spawnMode?: string | null }): RunsOn {
  if (agent.runLocation === 'server') return 'laptop';
  return agent.spawnMode === 'powershell' ? 'powershell' : 'wsl';
}

/** What to send to the roster add/update calls for a choice. `runLocation: null` clears it. */
export function runsOnFields(choice: RunsOn): { spawnMode: 'wsl' | 'powershell'; runLocation: 'server' | null } {
  if (choice === 'laptop') return { spawnMode: 'wsl', runLocation: 'server' };
  return { spawnMode: choice === 'powershell' ? 'powershell' : 'wsl', runLocation: null };
}

/** Plain-English text for the server's three refusals; anything else keeps the server's own message. */
export function describeRunLocationError(code: unknown, fallback: unknown): string {
  switch (code) {
    case 'RUN_LOCATION_POWERSHELL': return 'The Remote server can\'t run PowerShell agents. Choose WSL, or keep this agent on the desktop.';
    case 'RUN_LOCATION_REQUIRES_STOP': return 'Stop the agent to move it.';
    case 'LAPTOP_NOT_READY': return 'The Remote server isn\'t ready to run agents yet.';
    default: return typeof fallback === 'string' && fallback ? fallback : 'Could not save where this agent runs.';
  }
}
