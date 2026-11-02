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
  /** The DevFlow server's own host name (the laptop). A session that reports this host runs on the laptop; any other host is the desktop. */
  serverHost?: string;
}

export const LAPTOP_NOT_SET_UP = "Laptop agents aren't set up yet.";

/** Turn the GET /api/system/laptop-agents response into what the UI needs. A 404 or any failure means not ready. */
export function parseLaptopStatus(httpOk: boolean, body: unknown): LaptopStatus {
  if (!httpOk || !body || typeof body !== 'object') return { ready: false, mode: null, reason: LAPTOP_NOT_SET_UP };
  const data = body as { ready?: unknown; mode?: unknown; checks?: unknown; serverHost?: unknown };
  const mode: LaptopMode | null = data.mode === 'files-only' || data.mode === 'files-and-commands' ? data.mode : null;
  const host = typeof data.serverHost === 'string' && data.serverHost.trim() ? { serverHost: data.serverHost.trim() } : {};
  if (data.ready === true) return { ready: true, mode, reason: '', ...host };
  const checks = Array.isArray(data.checks) ? data.checks as Array<{ id?: unknown; ok?: unknown; detail?: unknown; label?: unknown }> : [];
  const failing = checks.find(check => check && check.ok === false);
  const reason = (failing && (typeof failing.detail === 'string' && failing.detail ? failing.detail : typeof failing.label === 'string' ? failing.label : '')) || LAPTOP_NOT_SET_UP;
  const failingCheckId = failing && typeof failing.id === 'string' ? failing.id : undefined;
  return { ready: false, mode, reason, ...(failingCheckId ? { failingCheckId } : {}), ...host };
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

export type RunsMachine = 'laptop' | 'desktop';

export interface ActualRunLocation {
  /** 'hidden': nothing to say (not running, or the session has not reported its host yet). 'match': saved setting and real machine agree. */
  kind: 'hidden' | 'match' | 'mismatch';
  saved: RunsMachine;
  actual: RunsMachine | null;
  host: string | null;
  message: string;
}

/**
 * Where a RUNNING agent's session really is, set against the saved "Where it runs" choice. The roster's `runLocation` is only the
 * setting used at the next start; the machine comes from the session's own report (participant host.hostId: DEVFLOW_HOST_ID or the
 * machine's host name). A host equal to the DevFlow server's own host name (serverHost) is the laptop; any other host is the desktop.
 * (23 Oct 2026: a session ran on the laptop for 21 hours while nothing on the Config page said so.)
 */
export function describeActualRunLocation(input: {
  saved?: string | null; hostId?: string | null; serverHost?: string | null; live: boolean;
}): ActualRunLocation {
  const saved: RunsMachine = input.saved === 'server' ? 'laptop' : 'desktop';
  const host = (input.hostId ?? '').trim();
  const server = (input.serverHost ?? '').trim();
  if (!input.live || !host || !server) return { kind: 'hidden', saved, actual: null, host: host || null, message: '' };
  const actual: RunsMachine = host.toLowerCase() === server.toLowerCase() ? 'laptop' : 'desktop';
  const where = `the ${actual} (${host})`;
  if (actual === saved) return { kind: 'match', saved, actual, host, message: `Running now on: ${where}.` };
  return {
    kind: 'mismatch', saved, actual, host,
    message: `Saved: ${saved === 'laptop' ? 'Run remote' : 'Run locally'}. Actually running on: ${where}.`,
  };
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
