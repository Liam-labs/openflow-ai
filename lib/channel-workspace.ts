import { promises as fs } from 'fs';
import path from 'path';

import { loadConfig, saveConfig } from '@/lib/config';
import { readJsonFile } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { defaultHost, hostCall } from '@/lib/host-executor';
import type { ArchivedChannelsData, CollabChannel, CollabChannelsData } from '@/lib/types';
import { getHomeDir } from '@/lib/home-dir';
import { PRODUCT_NAME } from '@/lib/brand';

/**
 * A channel's project folder ("working directory") lives on the agent host (the PC) and, as an empty
 * placeholder, on the DevFlow server. Deleting a channel lets the owner keep or delete that folder. Only a
 * folder directly in home that no other live channel or registered app uses may be deleted; the host
 * re-checks (protected names, unsaved git work, running programs) before removing anything.
 */

const HOME = getHomeDir();
const PROTECTED = new Set(['SG-1', 'DevFlow', 'bin', 'Games', 'Team', 'snap', 'go']);

export interface WorkspaceStatus {
  path?: string;
  /** Delete may be offered. */
  eligible: boolean;
  /** Why the folder must be kept, when not eligible. */
  reason?: string;
  exists?: boolean;
  bytes?: number;
  files?: number;
  gitIssues?: string[];
}

interface HostInfo { exists: boolean; bytes?: number; files?: number; gitIssues?: string[] }

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

function channelPaths(channel: CollabChannel): string[] {
  const paths = channel.projectPath ? [channel.projectPath] : [];
  for (const agent of channel.roster?.agents ?? []) {
    const wd = (agent as { effectiveWorkingDirectory?: string }).effectiveWorkingDirectory || agent.workingDirectory;
    if (wd) paths.push(wd);
  }
  return paths.map(p => path.normalize(p));
}

async function findChannel(channelId: string, live: CollabChannelsData): Promise<CollabChannel | null> {
  const current = live.channels.find(c => c.id === channelId);
  if (current) return current;
  const archived = await readJsonFile<ArchivedChannelsData>(DataPaths.collabArchivedChannels, { archives: [], lastUpdated: '' });
  return archived.archives.find(a => a.channel.id === channelId)?.channel ?? null;
}

/** Eligibility from DevFlow's own records (no filesystem access). */
async function checkEligibility(channel: CollabChannel, live: CollabChannelsData): Promise<WorkspaceStatus> {
  const root = channel.projectPath ? path.normalize(channel.projectPath) : '';
  if (!root) return { eligible: false, reason: 'This channel has no project folder.' };
  if (path.dirname(root) !== HOME || PROTECTED.has(path.basename(root))) {
    return { path: root, eligible: false, reason: 'Shared or system folder — it is never deleted with a channel.' };
  }
  const family = new Set([channel.id, ...live.channels.filter(c => c.parentChannelId === channel.id).map(c => c.id)]);
  const user = live.channels.find(c => !family.has(c.id) && channelPaths(c).some(p => inside(p, root) || inside(root, p)));
  if (user) return { path: root, eligible: false, reason: `Also used by the "${user.name}" channel.` };
  const config = await loadConfig();
  const app = config.projects.find(p => p.id !== channel.projectId && p.path && inside(path.normalize(p.path), root));
  if (app) return { path: root, eligible: false, reason: `Registered ${PRODUCT_NAME} project "${app.name}" lives there.` };
  return { path: root, eligible: true };
}

export async function getChannelWorkspaceStatus(channelId: string, live: CollabChannelsData): Promise<WorkspaceStatus> {
  const channel = await findChannel(channelId, live);
  if (!channel) return { eligible: false, reason: 'Channel not found.' };
  const status = await checkEligibility(channel, live);
  // Only a deletable folder needs the host's details; a kept folder shows just its reason.
  if (!status.eligible || !status.path) return status;
  const host = defaultHost();
  if (!host) {
    const exists = await fs.stat(status.path).then(s => s.isDirectory(), () => false);
    return { ...status, exists };
  }
  try {
    const info = await hostCall<HostInfo>(host, 'project-info', { path: status.path }, 120_000);
    return { ...status, ...info };
  } catch (error) {
    // A folder the host refuses to inspect (e.g. protected name) is never deletable.
    return { ...status, eligible: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** True when a directory tree holds no regular files (the server's empty placeholder). */
async function holdsNoFiles(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) return false;
    if (!(await holdsNoFiles(path.join(dir, entry.name)))) return false;
  }
  return true;
}

export async function deleteChannelWorkspace(
  channelId: string,
  live: CollabChannelsData,
  options: { discardUnsavedGit?: boolean } = {},
): Promise<{ removed: boolean; path?: string; discarded?: string[] }> {
  const channel = await findChannel(channelId, live);
  if (!channel) throw Object.assign(new Error('Channel not found.'), { statusCode: 404 });
  const status = await checkEligibility(channel, live);
  if (!status.eligible || !status.path) throw Object.assign(new Error(status.reason || 'Folder cannot be deleted.'), { statusCode: 409 });

  const host = defaultHost();
  let removed = false;
  let discarded: string[] | undefined;
  if (host) {
    // The host still refuses protected names, symlinks and running programs; only its unsaved-git-work refusal can be overridden.
    const args = options.discardUnsavedGit ? { path: status.path, discardUnsavedGit: true } : { path: status.path };
    const result = await hostCall<{ removed: boolean; discarded?: string[] }>(host, 'project-remove', args, 300_000);
    removed = result.removed;
    discarded = result.discarded;
    if (discarded?.length) console.warn(`[workspace] deleted ${status.path} with unsaved git work on request: ${discarded.join('; ')}`);
  }
  // The server-side copy is only the placeholder created with the channel; never delete real files here.
  if (await holdsNoFiles(status.path)) {
    await fs.rm(status.path, { recursive: true, force: true });
    removed = removed || !host;
  }
  // The channel's own auto-registered project now points at nothing.
  const config = await loadConfig();
  const own = config.projects.findIndex(p => p.id === channel.projectId && p.path && path.normalize(p.path) === status.path);
  if (own >= 0 && !(config.projects[own].healthChecks?.length)) {
    config.projects.splice(own, 1);
    await saveConfig(config);
  }
  return { removed, path: status.path, ...(discarded?.length ? { discarded } : {}) };
}

/** Create a new channel's project folder on the agent host too, so agents and the owner see it immediately. */
export async function ensureHostProjectFolder(projectPath: string): Promise<void> {
  const host = defaultHost();
  if (!host || path.dirname(path.normalize(projectPath)) !== HOME) return;
  await hostCall(host, 'project-mkdir', { path: projectPath }, 30_000);
}
