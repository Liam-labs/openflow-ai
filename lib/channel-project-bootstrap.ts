import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig, saveConfig } from '@/lib/config';
import { ensureHostProjectFolder } from '@/lib/channel-workspace';
import { trustCodexWorkspace } from '@/lib/codex-workspace-trust';
import type { Config, Project } from '@/lib/types';
import { getHomeDir } from '@/lib/home-dir';

export interface ChannelProjectBootstrapRequest {
  channelName: string;
  projectId?: string;
  projectPath?: string;
}

export interface ChannelProjectBootstrapResult {
  projectId?: string;
  projectPath?: string;
  created: boolean;
}

export interface ChannelProjectBootstrapDeps {
  homeDirectory: string;
  loadConfig: () => Promise<Config>;
  saveConfig: (config: Config) => Promise<void>;
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>;
  trustWorkspace: (directory: string) => Promise<void>;
  /** Agents run on the PC host: create the folder there too (best effort). */
  ensureHostFolder?: (directory: string) => Promise<void>;
}

const defaultDeps: ChannelProjectBootstrapDeps = {
  homeDirectory: getHomeDir(),
  loadConfig,
  saveConfig,
  mkdir: (directory, options) => fs.mkdir(directory, options),
  trustWorkspace: trustCodexWorkspace,
  ensureHostFolder: ensureHostProjectFolder,
};

async function ensureOnHost(deps: ChannelProjectBootstrapDeps, directory: string): Promise<void> {
  // A host that is offline must not block channel creation; the first agent spawn creates the folder anyway.
  await deps.ensureHostFolder?.(directory).catch(error => {
    console.error('[channel-project] host folder create failed:', directory, error instanceof Error ? error.message : error);
  });
}

function projectIdSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'agentchat-project';
}

function directorySlug(name: string): string {
  return name
    .trim()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/^-|-$/g, '') || 'AgentChat-Project';
}

function buildProject(id: string, name: string, projectPath: string): Project {
  return {
    id,
    name,
    description: '',
    path: projectPath,
    category: 'tool',
    tags: [],
    healthChecks: [],
    links: {},
  };
}

/**
 * Resolve a channel's linked project or create one automatically.
 *
 * A channel created without a project selection is treated as a new AgentChat
 * project. Its directory and registry entry are created before the channel is
 * persisted, so every new top-level channel has a usable project root.
 */
export async function ensureChannelProject(
  request: ChannelProjectBootstrapRequest,
  deps: ChannelProjectBootstrapDeps = defaultDeps,
): Promise<ChannelProjectBootstrapResult> {
  const config = await deps.loadConfig();
  const requestedPath = request.projectPath?.trim();

  if (request.projectId) {
    const linkedProject = config.projects.find(project => project.id === request.projectId);
    const projectPath = requestedPath || linkedProject?.path;
    if (projectPath) await deps.trustWorkspace(projectPath);
    return {
      projectId: request.projectId,
      projectPath,
      created: false,
    };
  }

  // An explicit path is a deliberate unregistered-project override. Preserve
  // it rather than creating a second project beside it.
  if (requestedPath) {
    await deps.trustWorkspace(requestedPath);
    await ensureOnHost(deps, requestedPath);
    return { projectPath: requestedPath, created: false };
  }

  const channelName = request.channelName.trim();
  const existing = config.projects.find(
    project => project.name.trim().toLowerCase() === channelName.toLowerCase(),
  );
  if (existing) {
    await deps.trustWorkspace(existing.path);
    return {
      projectId: existing.id,
      projectPath: existing.path,
      created: false,
    };
  }

  const baseId = projectIdSlug(channelName);
  const baseDirectory = directorySlug(channelName);
  let suffix = 1;
  let projectId = baseId;
  let projectPath = path.join(deps.homeDirectory, baseDirectory);

  while (config.projects.some(project => project.id === projectId || project.path === projectPath)) {
    suffix += 1;
    projectId = `${baseId}-${suffix}`;
    projectPath = path.join(deps.homeDirectory, `${baseDirectory}-${suffix}`);
  }

  await deps.mkdir(projectPath, { recursive: true });
  await ensureOnHost(deps, projectPath);
  await deps.trustWorkspace(projectPath);
  config.projects.push(buildProject(projectId, channelName, projectPath));
  await deps.saveConfig(config);

  return { projectId, projectPath, created: true };
}
