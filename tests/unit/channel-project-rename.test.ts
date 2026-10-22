import { describe, expect, it, vi } from 'vitest';
import type { CollabChannelsData, Config } from '@/lib/types';
import {
  renameChannelProjectDirectory,
  rewriteChannelProjectPaths,
  type ChannelProjectRenameDeps,
} from '@/lib/channel-project-rename';

function config(): Config {
  return {
    projects: [{
      id: 'old-project',
      name: 'Old Project',
      description: '',
      path: '/home/user/Old-Project',
      category: 'tool',
      tags: [],
      healthChecks: [],
      links: {},
    }],
    settings: { refreshInterval: 2000, defaultCategory: 'all' },
  };
}

function deps(existing = ['/home/user/Old-Project']): ChannelProjectRenameDeps & {
  saveConfig: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  trustWorkspace: ReturnType<typeof vi.fn>;
} {
  const paths = new Set(existing);
  return {
    homeDirectory: '/home/user',
    loadConfig: vi.fn().mockResolvedValue(config()),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    lstat: vi.fn(async (target: string) => {
      if (!paths.has(target)) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return { isDirectory: () => true };
    }),
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      paths.delete(oldPath);
      paths.add(newPath);
    }),
    trustWorkspace: vi.fn().mockResolvedValue(undefined),
  };
}

describe('renameChannelProjectDirectory', () => {
  it('moves the directory and updates the linked project registry record', async () => {
    const io = deps();

    const result = await renameChannelProjectDirectory({
      projectId: 'old-project',
      currentName: 'Old Project',
      newName: 'New Project',
      currentPath: '/home/user/Old-Project',
      requestedPath: '/home/user/Old-Project',
    }, io);

    expect(result).toMatchObject({
      oldPath: '/home/user/Old-Project',
      newPath: '/home/user/New-Project',
      moved: true,
    });
    expect(io.rename).toHaveBeenCalledWith(
      '/home/user/Old-Project',
      '/home/user/New-Project',
    );
    expect(io.trustWorkspace).toHaveBeenCalledWith('/home/user/New-Project');
    const saved = io.saveConfig.mock.calls[0][0] as Config;
    expect(saved.projects[0]).toEqual(expect.objectContaining({
      id: 'old-project',
      name: 'New Project',
      path: '/home/user/New-Project',
    }));
  });

  it('uses an explicitly edited destination instead of the name-derived path', async () => {
    const io = deps();

    const result = await renameChannelProjectDirectory({
      projectId: 'old-project',
      currentName: 'Old Project',
      newName: 'New Project',
      currentPath: '/home/user/Old-Project',
      requestedPath: '/home/user/custom-ledger',
    }, io);

    expect(result.newPath).toBe('/home/user/custom-ledger');
    expect(io.rename).toHaveBeenCalledWith(
      '/home/user/Old-Project',
      '/home/user/custom-ledger',
    );
  });

  it('rejects an existing destination without moving or changing config', async () => {
    const io = deps(['/home/user/Old-Project', '/home/user/New-Project']);

    await expect(renameChannelProjectDirectory({
      projectId: 'old-project',
      currentName: 'Old Project',
      newName: 'New Project',
      currentPath: '/home/user/Old-Project',
    }, io)).rejects.toMatchObject({ statusCode: 409 });

    expect(io.rename).not.toHaveBeenCalled();
    expect(io.saveConfig).not.toHaveBeenCalled();
  });

  it('provides rollback when the subsequent channel-registry write fails', async () => {
    const io = deps();
    const result = await renameChannelProjectDirectory({
      projectId: 'old-project',
      currentName: 'Old Project',
      newName: 'New Project',
      currentPath: '/home/user/Old-Project',
    }, io);

    await result.rollback();

    expect(io.rename).toHaveBeenNthCalledWith(
      2,
      '/home/user/New-Project',
      '/home/user/Old-Project',
    );
    const restored = io.saveConfig.mock.calls[1][0] as Config;
    expect(restored.projects[0]).toEqual(expect.objectContaining({
      name: 'Old Project',
      path: '/home/user/Old-Project',
    }));
  });
});

describe('rewriteChannelProjectPaths', () => {
  it('updates the channel, participants and roster workspaces everywhere they reference the old root', () => {
    const data = {
      channels: [{
        id: 'channel-1',
        name: 'New Project',
        projectId: 'old-project',
        projectPath: '/home/user/Old-Project',
        createdAt: '',
        lastActivity: '',
        participants: [{
          id: 'agent-1', type: 'codex', name: 'Jack', source: 'DevFlow',
          joinedAt: '', lastSeen: '', projectPath: '/home/user/Old-Project/Team/Jack',
        }],
        messages: [],
        roster: {
          lastUpdated: '',
          agents: [{
            id: 'agent-1', name: 'Jack', workingDirectory: '/home/user/Old-Project',
            effectiveWorkingDirectory: '/home/user/Old-Project/Team/Jack',
            channelId: 'channel-1', participantId: 'agent-1', color: '#fff', status: 'running',
            autoResume: true, useCollabWrapper: true, dangerouslySkipPermissions: true,
            createdAt: '', crashCount: 0,
          }],
        },
        settings: { autoRespond: true },
      }],
      lastUpdated: '',
    } satisfies CollabChannelsData;

    rewriteChannelProjectPaths(
      data,
      '/home/user/Old-Project',
      '/home/user/New-Project',
      'old-project',
    );

    expect(data.channels[0].projectPath).toBe('/home/user/New-Project');
    expect(data.channels[0].participants[0].projectPath).toBe('/home/user/New-Project/Team/Jack');
    expect(data.channels[0].roster?.agents[0].workingDirectory).toBe('/home/user/New-Project');
    expect(data.channels[0].roster?.agents[0].effectiveWorkingDirectory).toBe('/home/user/New-Project/Team/Jack');
  });
});
