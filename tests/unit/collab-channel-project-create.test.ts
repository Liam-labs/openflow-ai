import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabChannelActionRequest, CollabChannelsData } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  ensureChannelProject: vi.fn(),
  writeData: vi.fn().mockResolvedValue(undefined),
  registryOnCreated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/channel-project-bootstrap', () => ({
  ensureChannelProject: mocks.ensureChannelProject,
}));

vi.mock('@/app/api/collab/_collab-shared', () => ({
  writeData: mocks.writeData,
  generateStableParticipantId: vi.fn(),
  getNextColor: vi.fn(),
  markAgentAwayInOtherChannels: vi.fn(),
  generateChannelName: vi.fn().mockReturnValue('Generated Project'),
  ensureBrowserUserInChannel: vi.fn(),
}));

vi.mock('@/teams-integration/lib/teams-auto-sync', () => ({
  onChannelCreated: vi.fn().mockResolvedValue(undefined),
  onChannelDeleted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/slack-integration/lib/slack-auto-sync', () => ({
  onChannelCreated: vi.fn().mockResolvedValue(undefined),
  onChannelDeleted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/channels-registry', () => ({
  onChannelCreated: mocks.registryOnCreated,
  onChannelArchived: vi.fn(),
  onChannelRestored: vi.fn(),
  onChannelDeleted: vi.fn(),
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: { emitEvent: vi.fn() },
  emitCollabError: vi.fn(),
}));

import { handleCreate } from '@/app/api/collab/_handlers/lifecycle';

describe('AgentChat channel project bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureChannelProject.mockResolvedValue({
      projectId: 'email-s-and-marketing',
      projectPath: '/home/user/Emails-and-Marketing',
      created: true,
    });
  });

  it('persists the auto-created project id and working directory on the channel', async () => {
    const data: CollabChannelsData = {
      channels: [],
      lastUpdated: '2026-07-25T00:00:00.000Z',
    };
    const body = {
      action: 'create',
      name: "Email's and Marketing.",
      ownerId: 'browser-user-owner',
    } as CollabChannelActionRequest;

    const response = await handleCreate(data, body, '2026-07-25T20:00:00.000Z');
    const result = await response.json();

    expect(mocks.ensureChannelProject).toHaveBeenCalledWith({
      channelName: "Email's and Marketing.",
      projectId: undefined,
      projectPath: undefined,
    });
    expect(result.channel).toEqual(expect.objectContaining({
      name: "Email's and Marketing.",
      projectId: 'email-s-and-marketing',
      projectPath: '/home/user/Emails-and-Marketing',
    }));
    expect(data.channels).toHaveLength(1);
    expect(mocks.writeData).toHaveBeenCalledWith(data);
    expect(mocks.registryOnCreated).toHaveBeenCalledWith(result.channel);
  });
});
