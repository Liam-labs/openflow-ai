import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readChannelsData: vi.fn(),
  writeChannelsData: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: {
    stat: mocks.stat,
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    writeFile: vi.fn(),
  },
}));

vi.mock('@/lib/config', () => ({ loadConfig: mocks.loadConfig }));

vi.mock('@/lib/data-io', () => ({
  withFileLock: vi.fn().mockImplementation(
    (_path: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock('@/lib/collab-pty', () => ({
  forceKillByTmuxName: vi.fn(),
  safeKillProcess: vi.fn(),
  cleanupTempFiles: vi.fn(),
  killOrphanedWrapperProcesses: vi.fn(),
  sweepStaleCollabFiles: vi.fn(),
  validateClaudeFlags: vi.fn().mockReturnValue([]),
  tmuxSessionExists: vi.fn(),
}));

vi.mock('@/lib/collab-utils', () => ({
  generateAgentColor: vi.fn().mockReturnValue('#123456'),
}));

vi.mock('@/lib/system-ownership', () => ({
  readSystemOwnership: vi.fn(),
  writeSystemOwnership: vi.fn(),
}));

vi.mock('@/lib/log-writer', () => ({ logEvent: vi.fn() }));
vi.mock('@/lib/model-registry', () => ({
  inferAgentTypeForModel: vi.fn(),
  isAgentTypeCompatibleWith: vi.fn(),
}));

vi.mock('@/app/api/collab/pty/_pty-shared', () => ({
  CHANNELS_PATH: '/tmp/channels.json',
  readChannelsData: mocks.readChannelsData,
  writeChannelsData: mocks.writeChannelsData,
  isAllowedWorkingDirectory: vi.fn().mockReturnValue(true),
  findPersonalityFile: vi.fn().mockResolvedValue(null),
}));

import {
  handleRosterAdd,
  handleRosterAddFromParticipant,
} from '@/app/api/collab/pty/_handlers/roster-ops';

describe('roster_add project working-directory default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const channelData = {
      channels: [{
        id: 'channel-1',
        name: 'Marketing',
        projectId: 'marketing',
        projectPath: '/home/user/Marketing',
        participants: [],
        messages: [],
        settings: { autoRespond: true },
      }],
      lastUpdated: '2026-07-25T00:00:00.000Z',
    };
    mocks.readChannelsData.mockResolvedValue(channelData);
    mocks.loadConfig.mockResolvedValue({ projects: [], settings: {} });
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
    mocks.writeChannelsData.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue(JSON.stringify({ roles: [{ id: 'known-role' }] }));
  });

  it('uses the channel project path when the caller omits workingDirectory', async () => {
    const response = await handleRosterAdd({
      action: 'roster_add',
      channelId: 'channel-1',
      name: 'Architect',
    }, '2026-07-25T20:00:00.000Z');
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.agent.workingDirectory).toBe('/home/user/Marketing');
    expect(mocks.stat).toHaveBeenCalledWith('/home/user/Marketing');
    expect(mocks.writeChannelsData).toHaveBeenCalledOnce();
  });

  it('uses the channel project path when promoting a participant without a project path', async () => {
    mocks.readChannelsData.mockResolvedValue({
      channels: [{
        id: 'channel-1',
        name: 'Marketing',
        projectId: 'marketing',
        projectPath: '/home/user/Marketing',
        participants: [{
          id: 'participant-1',
          name: 'Architect',
          type: 'claude-terminal',
          joinedAt: '2026-07-25T00:00:00.000Z',
          lastSeen: '2026-07-25T00:00:00.000Z',
        }],
        messages: [],
        settings: { autoRespond: true },
      }],
      lastUpdated: '2026-07-25T00:00:00.000Z',
    });

    const response = await handleRosterAddFromParticipant({
      action: 'roster_add_from_participant',
      channelId: 'channel-1',
      participantId: 'participant-1',
    }, '2026-07-25T20:00:00.000Z');
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.agent.workingDirectory).toBe('/home/user/Marketing');
    expect(mocks.writeChannelsData).toHaveBeenCalledOnce();
  });

  it('rejects an unknown roleId before creating a roster entry', async () => {
    const response = await handleRosterAdd({
      action: 'roster_add',
      channelId: 'channel-1',
      name: 'Architect',
      roleId: 'deleted-role',
    }, '2026-07-25T20:00:00.000Z');
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.error).toContain('Unknown roleId');
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.writeChannelsData).not.toHaveBeenCalled();
  });
});
