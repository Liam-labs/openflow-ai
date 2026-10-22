import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabChannelActionRequest, CollabChannelsData } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  renameDirectory: vi.fn(),
  rollback: vi.fn().mockResolvedValue(undefined),
  writeData: vi.fn().mockResolvedValue(undefined),
  appendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/channel-project-rename', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/channel-project-rename')>();
  return { ...actual, renameChannelProjectDirectory: mocks.renameDirectory };
});

vi.mock('@/app/api/collab/_collab-shared', () => ({
  writeData: mocks.writeData,
  invalidateUnreadCache: vi.fn(),
}));

vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: mocks.appendMessage,
  appendMessages: vi.fn(),
  readChannelMessages: vi.fn(),
}));

vi.mock('@/teams-integration/lib/teams-auto-sync', () => ({
  onChannelCreated: vi.fn(),
  onChannelRenamed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/slack-integration/lib/slack-auto-sync', () => ({
  onChannelCreated: vi.fn(),
  onChannelRenamed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/channels-registry', () => ({
  onChannelUpdated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: vi.fn() } }));

import { handleRename } from '@/app/api/collab/_handlers/settings';

function channels(): CollabChannelsData {
  return {
    channels: [{
      id: 'channel-1',
      name: 'Money & Accounts',
      projectId: 'money-accounts',
      projectPath: '/home/user/Money--Accounts',
      createdAt: '',
      lastActivity: '',
      participants: [{
        id: 'agent-1', type: 'codex', name: 'Architect', source: 'DevFlow',
        joinedAt: '', lastSeen: '', projectPath: '/home/user/Money--Accounts/Team/Architect',
      }],
      messages: [],
      roster: {
        lastUpdated: '',
        agents: [{
          id: 'agent-1', name: 'Architect', workingDirectory: '/home/user/Money--Accounts',
          effectiveWorkingDirectory: '/home/user/Money--Accounts/Team/Architect',
          channelId: 'channel-1', participantId: 'agent-1', color: '#fff', status: 'running',
          autoResume: true, useCollabWrapper: true, dangerouslySkipPermissions: true,
          createdAt: '', crashCount: 0,
        }],
      },
      settings: { autoRespond: true },
    }],
    lastUpdated: 'before',
  };
}

describe('channel rename keeps its project directory aligned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rollback.mockResolvedValue(undefined);
    mocks.writeData.mockResolvedValue(undefined);
    mocks.renameDirectory.mockResolvedValue({
      oldPath: '/home/user/Money--Accounts',
      newPath: '/home/user/LedgerOS',
      moved: true,
      rollback: mocks.rollback,
    });
  });

  it('renames the project before persisting the channel and rewrites agent workspaces', async () => {
    const data = channels();
    const response = await handleRename(data, {
      action: 'rename',
      channelId: 'channel-1',
      name: 'LedgerOS',
      projectPath: '/home/user/Money--Accounts',
    } as CollabChannelActionRequest, '2026-08-29T10:00:00.000Z');

    expect(response.status).toBe(200);
    expect(mocks.renameDirectory).toHaveBeenCalledWith({
      projectId: 'money-accounts',
      currentName: 'Money & Accounts',
      newName: 'LedgerOS',
      currentPath: '/home/user/Money--Accounts',
      requestedPath: '/home/user/Money--Accounts',
    });
    expect(data.channels[0].name).toBe('LedgerOS');
    expect(data.channels[0].projectPath).toBe('/home/user/LedgerOS');
    expect(data.channels[0].participants[0].projectPath).toBe('/home/user/LedgerOS/Team/Architect');
    expect(data.channels[0].roster?.agents[0].workingDirectory).toBe('/home/user/LedgerOS');
    expect(mocks.writeData).toHaveBeenCalledWith(data);
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('rolls the directory and in-memory channel state back if channel persistence fails', async () => {
    const data = channels();
    mocks.writeData.mockRejectedValueOnce(new Error('disk full'));

    await expect(handleRename(data, {
      action: 'rename',
      channelId: 'channel-1',
      name: 'LedgerOS',
    } as CollabChannelActionRequest, '2026-08-29T10:00:00.000Z')).rejects.toThrow('disk full');

    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(data.channels[0].name).toBe('Money & Accounts');
    expect(data.channels[0].projectPath).toBe('/home/user/Money--Accounts');
  });
});
