/**
 * Agent JSONL transcript resolver.
 *
 * Sprint 36 Phase 1 — maps an agent name to its currently-active Claude Code
 * JSONL session transcript under `$HOME/.claude/projects/<project-key>/`.
 *
 * Resolution strategy (three-tier):
 *   1. Primary A — read `<agentDir>/.session-scratch/transcript-path`
 *      (populated by an agent's Phase 3 SessionStart hook). This is the
 *      absolute path to the live JSONL — skips project-key derivation.
 *   2. Primary B — read `<agentDir>/.session-scratch/session-id` and join
 *      with `$HOME/.claude/projects/<project-key>/<id>.jsonl`. Used when
 *      transcript-path is missing or points to a stale path.
 *   3. Fallback — pick the newest `.jsonl` by mtime in the project-key dir.
 *      Marks `fallback`. Covers agents whose scratch wasn't initialised.
 *
 * Consumers:
 *   - `/api/agent-stream` SSE endpoint (Phase 1 T2)
 *   - Any other helper that needs to tail a named agent's live transcript.
 *
 * All I/O is injectable via `ResolverOptions.home` / `rosterLoader` so tests
 * can sandbox HOME and pass a fake roster without touching collab-channels.json.
 */

import { join } from 'node:path';
import { readJsonFile } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { deriveAgentProjectKey } from '@/lib/agent-session-state';
import { localStreamFs, type StreamFs } from '@/lib/agent-stream-fs';
import type { AgentRosterEntry, CollabChannelsData } from '@/lib/types';

import { getHomeDir } from '@/lib/home-dir';
export type ResolvedVia = 'scratch' | 'fallback';

export interface ResolvedJsonl {
  path: string;
  resolvedVia: ResolvedVia;
}

export interface ResolverOptions {
  /** Override `$HOME` for test sandboxing. Defaults to `process.env.HOME`. */
  home?: string;
  /**
   * Injectable roster source. Defaults to flattening all agents across all
   * channels in `data/collab-channels.json`. Tests pass an async function
   * that returns a fixed array.
   */
  rosterLoader?: () => Promise<AgentRosterEntry[]>;
  /** When set, restrict name lookups to agents in this channel. */
  channelId?: string;
  /** Where the transcript files are read from. Defaults to this machine; the Live Feed passes the agent host's for agents that run there. */
  fsx?: StreamFs;
}

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date(0).toISOString(),
};

async function resolveHome(opts: ResolverOptions | undefined, fsx: StreamFs): Promise<string> {
  return opts?.home ?? (fsx.remote ? fsx.home() : getHomeDir());
}

/**
 * Default roster loader — reads collab-channels.json and flattens every
 * channel's roster into a single list. Agents appearing in multiple channels
 * (rare) will appear multiple times; the name-lookup prefers running entries.
 */
async function defaultRosterLoader(): Promise<AgentRosterEntry[]> {
  const data = await readJsonFile<CollabChannelsData>(
    DataPaths.collabChannels,
    DEFAULT_CHANNELS_DATA,
  );
  const entries: AgentRosterEntry[] = [];
  for (const channel of data.channels) {
    if (channel.roster?.agents) {
      entries.push(...channel.roster.agents);
    }
  }
  return entries;
}

/**
 * Find the effective working directory for a roster entry — prefer the
 * agent-specific `effectiveWorkingDirectory` if set, fall back to the
 * declared `workingDirectory`.
 */
function pickAgentDir(entry: AgentRosterEntry): string {
  return entry.effectiveWorkingDirectory && entry.effectiveWorkingDirectory.length > 0
    ? entry.effectiveWorkingDirectory
    : entry.workingDirectory;
}

/**
 * Look up an agent by display name in the roster. Case-insensitive. When
 * multiple entries share a name, the running one wins.
 */
export async function findAgentByName(
  name: string,
  opts?: ResolverOptions,
): Promise<AgentRosterEntry | null> {
  const loader = opts?.rosterLoader ?? defaultRosterLoader;
  const entries = await loader();
  const needle = name.toLowerCase();
  let matches = entries.filter((e) => e.name.toLowerCase() === needle);
  if (opts?.channelId) {
    matches = matches.filter((e) => e.channelId === opts.channelId);
  }
  if (matches.length === 0) return null;

  const running = matches.find((e) => e.status === 'running');
  return running ?? matches[0];
}

async function readScratchFile(fsx: StreamFs, agentDir: string, name: string): Promise<string | null> {
  const raw = await fsx.readText(join(agentDir, '.session-scratch', name));
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

async function findNewestJsonl(fsx: StreamFs, projectsDir: string): Promise<string | null> {
  const entries = await fsx.readdir(projectsDir);
  if (!entries) return null;
  let latestPath: string | null = null;
  let latestMtime = -Infinity;
  for (const entry of entries) {
    if (!entry.name.endsWith('.jsonl') || !entry.isFile) continue;
    if (entry.mtimeMs > latestMtime) {
      latestMtime = entry.mtimeMs;
      latestPath = join(projectsDir, entry.name);
    }
  }
  return latestPath;
}

/**
 * Resolve the active JSONL path for a given agent working directory.
 * Tries scratch → fallback. Returns null when neither path finds a jsonl.
 */
export async function resolveJsonlForDir(
  agentDir: string,
  opts?: ResolverOptions,
): Promise<ResolvedJsonl | null> {
  const fsx = opts?.fsx ?? localStreamFs();
  const home = await resolveHome(opts, fsx);
  const projectKey = deriveAgentProjectKey(agentDir);
  const projectsDir = join(home, '.claude', 'projects', projectKey);

  // Primary A: absolute transcript-path (an agent's Phase 3 hook, cleanest path)
  const transcriptPath = await readScratchFile(fsx, agentDir, 'transcript-path');
  if (transcriptPath && (await fsx.stat(transcriptPath))) {
    return { path: transcriptPath, resolvedVia: 'scratch' };
  }

  // Primary B: session-id + derived project-key join
  const sessionId = await readScratchFile(fsx, agentDir, 'session-id');
  if (sessionId) {
    const candidate = join(projectsDir, `${sessionId}.jsonl`);
    if (await fsx.stat(candidate)) {
      return { path: candidate, resolvedVia: 'scratch' };
    }
  }

  // Fallback: newest jsonl by mtime in project-key dir
  const newest = await findNewestJsonl(fsx, projectsDir);
  if (!newest) return null;
  return { path: newest, resolvedVia: 'fallback' };
}

/**
 * High-level resolver — agent display name → active JSONL path. Composes
 * `findAgentByName` + `resolveJsonlForDir`.
 */
export async function resolveAgentJsonlPath(
  agentName: string,
  opts?: ResolverOptions,
): Promise<ResolvedJsonl | null> {
  const agent = await findAgentByName(agentName, opts);
  if (!agent) return null;
  const agentDir = pickAgentDir(agent);
  return resolveJsonlForDir(agentDir, opts);
}
