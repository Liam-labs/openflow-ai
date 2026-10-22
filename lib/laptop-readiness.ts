/**
 * Can this roster agent be set to run on the laptop (roster `runLocation: 'server'`)? Two jobs:
 *   1. GET /api/system/laptop-agents: is the laptop set up to run agents, and what can they reach from there?
 *   2. refuse a roster add/update that would be wrong: PowerShell on the laptop, moving a running agent, or choosing the laptop before it is ready.
 * The contract (field, codes, response shape) is on the board task "UI: 'Runs on' choice"; an agent's lib/laptop-agents.ts reads it.
 * The decisions are pure functions; the two readers at the bottom do the I/O.
 */
import { readJsonFile } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { appPath } from '@/lib/app-paths';
import type { CollabChannelsData } from '@/lib/types';

export type LaptopMode = 'files-only' | 'files-and-commands';
export interface Check { id: string; label: string; ok: boolean; detail: string }
export interface Readiness { ready: boolean; mode: LaptopMode; checks: Check[] }
export interface ProbeLite { state: string; detail: string }
export interface Refusal { status: number; code: 'RUN_LOCATION_POWERSHELL' | 'RUN_LOCATION_REQUIRES_STOP' | 'LAPTOP_NOT_READY'; message: string; details?: Check[] }

/** Checks run in this order and the UI shows the first one that fails, so put the root cause first. */
export function evaluateReadiness(input: { probes: Record<'claude' | 'codex', ProbeLite | null>; fileShare: boolean; desktopCommands: boolean }): Readiness {
  const seen = Object.values(input.probes).filter((p): p is ProbeLite => !!p && p.state !== 'unknown');
  const installed = seen.length > 0;
  const signedIn = seen.some(p => p.state === 'ok');
  const checks: Check[] = [
    { id: 'program', label: 'Claude or Codex installed on the Remote server', ok: installed,
      detail: installed ? 'Installed' : 'Claude and Codex are not installed on the Remote server yet.' },
    { id: 'signed-in', label: 'Signed in on the Remote server', ok: signedIn,
      detail: signedIn ? 'Signed in' : installed ? 'Nothing is signed in on the Remote server yet.' : 'Nothing can be signed in until a program is installed.' },
    { id: 'file-share', label: 'Desktop folders shared to the Remote server', ok: input.fileShare,
      detail: input.fileShare ? 'Shared' : "The shared desktop folders aren't set up on the Remote server yet." },
  ];
  return { ready: checks.every(c => c.ok), mode: input.desktopCommands ? 'files-and-commands' : 'files-only', checks };
}

const isStopped = (status: unknown) => status === 'stopped' || status === 'crashed';

/** Decide a roster change of "where the agent runs". null means allowed. Moving back to the desktop never needs the laptop to be ready. */
export function decideRunLocationChange(input: {
  wanted: 'server' | 'desktop'; current: 'server' | 'desktop'; status: unknown; spawnMode: unknown; readiness: Readiness;
}): Refusal | null {
  if (input.wanted === input.current) return null;
  if (!isStopped(input.status)) {
    return { status: 409, code: 'RUN_LOCATION_REQUIRES_STOP', message: 'Stop the agent to move it.' };
  }
  if (input.wanted === 'server') {
    if (input.spawnMode === 'powershell') {
      return { status: 400, code: 'RUN_LOCATION_POWERSHELL', message: "The Remote server can't run PowerShell agents. Choose WSL, or keep this agent on the desktop." };
    }
    if (!input.readiness.ready) {
      const failing = input.readiness.checks.filter(c => !c.ok);
      return { status: 409, code: 'LAPTOP_NOT_READY', message: failing[0]?.detail ?? "The Remote server isn't ready to run agents yet.", details: failing };
    }
  }
  return null;
}

// ── The two readers ──────────────────────────────────────────────────────────

export interface ReadinessDeps {
  probes: () => Promise<Record<'claude' | 'codex', ProbeLite | null>>;
  flags: () => Promise<{ fileShare: boolean; desktopCommands: boolean }>;
}

async function registryFlags(): Promise<{ fileShare: boolean; desktopCommands: boolean }> {
  const registry = await readJsonFile<{ remote?: { fileShare?: unknown; desktopCommands?: unknown } }>(appPath('data', 'scaffolding', 'service-locations.json'), {});
  return { fileShare: registry.remote?.fileShare === true, desktopCommands: registry.remote?.desktopCommands === true };
}

/** Loaded on demand: the harness service pulls in the channel store, which a plain readiness unit test does not need. */
async function serverProbes(): Promise<Record<'claude' | 'codex', ProbeLite | null>> {
  const { probeServerHarnesses } = await import('@/lib/harness-auth/service');
  return probeServerHarnesses();
}

export const defaultReadinessDeps: ReadinessDeps = { probes: serverProbes, flags: registryFlags };

export async function laptopReadiness(deps: ReadinessDeps = defaultReadinessDeps): Promise<Readiness> {
  const [probes, flags] = await Promise.all([deps.probes(), deps.flags()]);
  return evaluateReadiness({ probes, ...flags });
}

/** The roster add/update guard. Returns a refusal to send back, or null to carry on. */
export async function refuseRunLocationChange(
  body: { channelId?: unknown; agentId?: unknown; runLocation?: unknown; spawnMode?: unknown },
  deps: ReadinessDeps = defaultReadinessDeps,
): Promise<Refusal | null> {
  const wanted = body.runLocation === 'server' ? 'server' : 'desktop';
  let current: 'server' | 'desktop' = 'desktop';
  let status: unknown = 'stopped';
  let spawnMode: unknown = body.spawnMode;
  if (body.agentId !== undefined) {                       // an update: compare with what the agent is now
    const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
    const agent = data.channels.find(c => c.id === body.channelId)?.roster?.agents.find(a => a.id === body.agentId);
    if (!agent) return null;                              // the update handler reports "not found"
    current = agent.runLocation === 'server' ? 'server' : 'desktop';
    status = agent.status;
    spawnMode = body.spawnMode !== undefined ? body.spawnMode : agent.spawnMode;
  }
  const needsReadiness = wanted === 'server' && current !== 'server';
  const readiness = needsReadiness ? await laptopReadiness(deps) : { ready: true, mode: 'files-only' as LaptopMode, checks: [] };
  return decideRunLocationChange({ wanted, current, status, spawnMode, readiness });
}
