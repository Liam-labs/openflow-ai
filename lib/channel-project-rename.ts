import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig, saveConfig } from '@/lib/config';
import { trustCodexWorkspace } from '@/lib/codex-workspace-trust';
import type { CollabChannelsData, Config } from '@/lib/types';
import { getHomeDir } from '@/lib/home-dir';

export interface ChannelProjectRenameRequest {
  projectId?: string;
  currentName: string;
  newName: string;
  currentPath?: string;
  requestedPath?: string;
}

export interface ChannelProjectRenameResult {
  oldPath?: string;
  newPath?: string;
  moved: boolean;
  rollback: () => Promise<void>;
}

export interface ChannelProjectRenameDeps {
  homeDirectory: string;
  loadConfig: () => Promise<Config>;
  saveConfig: (config: Config) => Promise<void>;
  lstat: (target: string) => Promise<{ isDirectory(): boolean }>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  trustWorkspace: (directory: string) => Promise<void>;
}

const defaultDeps: ChannelProjectRenameDeps = {
  homeDirectory: getHomeDir(),
  loadConfig,
  saveConfig,
  lstat: target => fs.lstat(target),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  trustWorkspace: trustCodexWorkspace,
};

function httpError(message: string, statusCode: number): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

export function channelDirectorySlug(name: string): string {
  return name
    .trim()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/^-|-$/g, '') || 'AgentChat-Project';
}

function isInsideHome(target: string, homeDirectory: string): boolean {
  const resolvedHome = path.resolve(homeDirectory);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget !== resolvedHome && resolvedTarget.startsWith(`${resolvedHome}${path.sep}`);
}

async function pathExists(
  target: string,
  lstat: ChannelProjectRenameDeps['lstat'],
): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Rename the project directory and its project-registry record as one operation.
 * The caller owns the channel-data write and can use the returned rollback if it
 * fails, keeping the filesystem, project registry and channel registry aligned.
 */
export async function renameChannelProjectDirectory(
  request: ChannelProjectRenameRequest,
  deps: ChannelProjectRenameDeps = defaultDeps,
): Promise<ChannelProjectRenameResult> {
  const config = await deps.loadConfig();
  const configBefore = structuredClone(config);
  const project = request.projectId
    ? config.projects.find(candidate => candidate.id === request.projectId)
    : undefined;
  const currentPath = request.currentPath?.trim() || project?.path?.trim();

  if (!currentPath) {
    if (project) {
      project.name = request.newName;
      await deps.saveConfig(config);
    }
    return {
      moved: false,
      rollback: async () => {
        if (project) await deps.saveConfig(configBefore);
      },
    };
  }

  const requestedPath = request.requestedPath?.trim();
  const derivedPath = path.join(path.dirname(currentPath), channelDirectorySlug(request.newName));
  // The settings form sends the current path back unchanged. In that case a
  // channel-name change still means "rename the project directory".
  const nextPath = path.resolve(
    requestedPath && path.resolve(requestedPath) !== path.resolve(currentPath)
      ? requestedPath
      : derivedPath,
  );
  const oldPath = path.resolve(currentPath);

  if (!isInsideHome(oldPath, deps.homeDirectory) || !isInsideHome(nextPath, deps.homeDirectory)) {
    throw httpError(`Project directories can only be renamed within ${deps.homeDirectory}`, 403);
  }

  const source = await deps.lstat(oldPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw httpError(`Project directory does not exist: ${oldPath}`, 409);
    }
    throw error;
  });
  if (!source.isDirectory()) {
    throw httpError(`Project path is not a directory: ${oldPath}`, 409);
  }

  const moved = oldPath !== nextPath;
  if (moved && await pathExists(nextPath, deps.lstat)) {
    throw httpError(`Cannot rename project: destination already exists: ${nextPath}`, 409);
  }

  if (moved) await deps.rename(oldPath, nextPath);

  try {
    await deps.trustWorkspace(nextPath);
    if (project) {
      project.name = request.newName;
      project.path = nextPath;
      await deps.saveConfig(config);
    }
  } catch (error) {
    if (moved) await deps.rename(nextPath, oldPath).catch(() => {});
    throw error;
  }

  let rolledBack = false;
  return {
    oldPath,
    newPath: nextPath,
    moved,
    rollback: async () => {
      if (rolledBack) return;
      rolledBack = true;
      if (project) await deps.saveConfig(configBefore);
      if (moved) await deps.rename(nextPath, oldPath);
    },
  };
}

export function replaceProjectPathPrefix(
  value: string | undefined,
  oldPath: string,
  newPath: string,
): string | undefined {
  if (!value) return value;
  const normalizedOld = path.resolve(oldPath);
  const normalizedValue = path.resolve(value);
  if (normalizedValue === normalizedOld) return newPath;
  if (!normalizedValue.startsWith(`${normalizedOld}${path.sep}`)) return value;
  return path.join(newPath, path.relative(normalizedOld, normalizedValue));
}

/** Update every live reference to a moved project root, including other channels
 * linked to the same project and each agent's personal Team directory. */
export function rewriteChannelProjectPaths(
  data: CollabChannelsData,
  oldPath: string,
  newPath: string,
  projectId?: string,
): void {
  for (const channel of data.channels) {
    const linked = Boolean(projectId && channel.projectId === projectId);
    const rewrittenChannelPath = replaceProjectPathPrefix(channel.projectPath, oldPath, newPath);
    if (linked && rewrittenChannelPath === channel.projectPath) {
      channel.projectPath = newPath;
    } else if (rewrittenChannelPath !== channel.projectPath) {
      channel.projectPath = rewrittenChannelPath;
    }

    for (const participant of channel.participants) {
      participant.projectPath = replaceProjectPathPrefix(participant.projectPath, oldPath, newPath);
    }
    for (const agent of channel.roster?.agents || []) {
      agent.workingDirectory = replaceProjectPathPrefix(
        agent.workingDirectory,
        oldPath,
        newPath,
      ) || agent.workingDirectory;
      agent.effectiveWorkingDirectory = replaceProjectPathPrefix(
        agent.effectiveWorkingDirectory,
        oldPath,
        newPath,
      );
    }
  }
}
