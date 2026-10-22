/**
 * Chooses which machine's files the Live Feed reads for an agent (see lib/agent-stream-fs.ts), then resolves the session there.
 * It follows where the agent's FILES are (filesHostFor), not where its process runs: an agent that runs on the server but works on the
 * desktop's folders through the share still writes its transcript into the desktop's ~/.claude/projects.
 */
import { localStreamFs, remoteStreamFs, StreamHostOfflineError, type StreamFs } from '@/lib/agent-stream-fs';
import { resolveAgentStreamSource, type ResolvedAgentStream, type RuntimeResolverOptions } from '@/lib/agent-stream-runtime';
import { filesHostFor } from '@/lib/host-executor';
import type { AgentRosterEntry } from '@/lib/types';

export interface ChosenAgentStream {
  fsx: StreamFs;
  resolved: ResolvedAgentStream;
}

export interface ChooseOptions extends RuntimeResolverOptions {
  /** Test seams: the machine holding the agent's files (default: filesHostFor) and its file reader. */
  host?: string | null;
  remoteFsFor?: (host: string) => StreamFs;
}

/**
 * Pick where an agent's transcript lives and resolve it there. An agent whose files are on the agent host is read through that host;
 * one whose files are on this machine, or that the host has no session for, is read locally. A host that does not answer throws
 * StreamHostOfflineError (unless the local copy has the session), so the caller can say "agent host offline" instead of "no session".
 */
export async function chooseAgentStreamSource(
  agent: AgentRosterEntry,
  options?: ChooseOptions,
): Promise<ChosenAgentStream | null> {
  const host = options && 'host' in options ? options.host ?? null : filesHostFor(agent);
  let offline: StreamHostOfflineError | null = null;
  if (host) {
    const fsx = (options?.remoteFsFor ?? remoteStreamFs)(host);
    try {
      const resolved = await resolveAgentStreamSource(agent, { ...options, fsx });
      if (resolved) return { fsx, resolved };
    } catch (error) {
      if (!(error instanceof StreamHostOfflineError)) throw error;
      offline = error;
    }
  }
  const local = localStreamFs();
  const resolved = await resolveAgentStreamSource(agent, { ...options, fsx: local });
  if (resolved) return { fsx: local, resolved };
  if (offline) throw offline;
  return null;
}
