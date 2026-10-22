/**
 * T2.3 TDD — /invite hook in messaging handler
 *
 * Verifies that when a channel message contains /invite <capability>,
 * the server:
 *   1. posts the message normally (so sender sees it)
 *   2. finds the matching agent and writes the invite file
 *   3. posts a system notification to the channel
 *   4. posts an error notification when no agent is found
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockDispatchInvite,
  mockFindAgentByCapability,
  mockParseInviteCommand,
  mockAppendMessage,
  mockReadRoles,
} = vi.hoisted(() => ({
  mockDispatchInvite: vi.fn(),
  mockFindAgentByCapability: vi.fn(),
  mockParseInviteCommand: vi.fn(),
  mockAppendMessage: vi.fn(),
  mockReadRoles: vi.fn(),
}));

vi.mock('@/lib/invite-router', () => ({
  parseInviteCommand: mockParseInviteCommand,
  findAgentByCapability: mockFindAgentByCapability,
  dispatchInvite: mockDispatchInvite,
}));

vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: mockAppendMessage,
  appendSilentMessage: vi.fn(),
  archiveOldMessages: vi.fn(),
  findMessage: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  readChannelMessages: vi.fn().mockResolvedValue([]),
}));

// roles
vi.mock('@/lib/collab-delivery', () => ({
  deliverMessage: vi.fn(),
  computeRecipients: vi.fn().mockReturnValue(null),
  readRolesData: mockReadRoles,
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: { emitEvent: vi.fn() },
  emitCollabError: vi.fn(),
  emitApiEvent: vi.fn(),
}));

vi.mock('@/teams-integration/lib/teams-bridge', () => ({ forwardToTeams: vi.fn() }));
vi.mock('@/teams-integration/lib/teams-auth', () => ({ isTeamsConfigured: () => false }));
vi.mock('@/slack-integration/lib/slack-bridge', () => ({ forwardToSlack: vi.fn() }));
vi.mock('@/slack-integration/lib/slack-auth', () => ({ isSlackConfigured: () => false }));
vi.mock('@/lib/collab-utils', () => ({ parseAtMentions: vi.fn().mockReturnValue([]) }));
vi.mock('@/lib/claude-session', () => ({ spawnCollabAgentSmart: vi.fn() }));
vi.mock('../app/api/collab/_collab-shared', () => ({
  writeData: vi.fn(),
  markAgentAwayInOtherChannels: vi.fn(),
  invalidateUnreadCache: vi.fn(),
  computePresenceStatus: vi.fn(),
  withTimeout: vi.fn().mockImplementation((p: Promise<unknown>) => p),
  saveFileToDisk: vi.fn().mockResolvedValue(null),
  MAX_FILES_PER_MESSAGE: 5,
}));

// ─── Import subject ─────────────────────────────────────────────────────────

const { processInviteSlashCommand } = await import('@/lib/invite-slash-handler');

// ─── Fixtures ──────────────────────────────────────────────────────────────────

import type { AgentRosterEntry, AgentRole } from '@/lib/types';

const mockRole: AgentRole = {
  id: 'b10c5e8d-9f4a-4b1c-8d6e-3a7f9e2c1d05',
  name: 'Browser Dev',
  slug: 'browser-dev',
  mdPath: 'data/roles/browser-dev.md',
  capabilities: ['browser', 'chrome'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const mockBrowserAgent: AgentRosterEntry = {
  id: 'agent-browser',
  name: 'Browser',
  workingDirectory: '/home/user/DevFlow/Team/Browser',
  channelId: 'home-channel',
  participantId: 'roster-browser',
  color: '#0ea5e9',
  status: 'running',
  pid: 9999,
  useCollabWrapper: true,
  dangerouslySkipPermissions: false,
  autoResume: false,
  crashCount: 0,
  roleId: mockRole.id,
  createdAt: '2026-01-01T00:00:00Z',
};

function makeChannel(id = 'ch-test', name = 'Dev Channel') {
  return {
    id,
    name,
    participants: [],
    messages: [],
    roster: { agents: [mockBrowserAgent], lastUpdated: '2026-01-01T00:00:00Z' },
    settings: { autoRespond: false },
    createdAt: '2026-01-01T00:00:00Z',
    lastActivity: '2026-01-01T00:00:00Z',
    isActive: true,
    type: 'public' as const,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('processInviteSlashCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadRoles.mockResolvedValue([mockRole]);
    mockDispatchInvite.mockResolvedValue(true);
  });

  it('ignores non-invite messages', async () => {
    mockParseInviteCommand.mockReturnValue(null);
    const channel = makeChannel();
    await processInviteSlashCommand('hello world', 'Jack', channel);
    expect(mockDispatchInvite).not.toHaveBeenCalled();
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('finds agent and dispatches invite for matching capability', async () => {
    mockParseInviteCommand.mockReturnValue({ capability: 'browser', task: undefined });
    mockFindAgentByCapability.mockReturnValue(mockBrowserAgent);
    const channel = makeChannel();

    await processInviteSlashCommand('/invite browser', 'Jack', channel);

    expect(mockDispatchInvite).toHaveBeenCalledWith(
      mockBrowserAgent,
      channel.id,
      channel.name,
      undefined
    );
  });

  it('passes task description to dispatchInvite', async () => {
    mockParseInviteCommand.mockReturnValue({ capability: 'browser', task: 'automate the form' });
    mockFindAgentByCapability.mockReturnValue(mockBrowserAgent);
    const channel = makeChannel();

    await processInviteSlashCommand('/invite browser "automate the form"', 'Jack', channel);

    expect(mockDispatchInvite).toHaveBeenCalledWith(
      mockBrowserAgent,
      channel.id,
      channel.name,
      'automate the form'
    );
  });

  it('posts notification message to channel when invite succeeds', async () => {
    mockParseInviteCommand.mockReturnValue({ capability: 'browser', task: 'fill form' });
    mockFindAgentByCapability.mockReturnValue(mockBrowserAgent);
    mockDispatchInvite.mockResolvedValue(true);
    const channel = makeChannel();

    await processInviteSlashCommand('/invite browser "fill form"', 'Jack', channel);

    expect(mockAppendMessage).toHaveBeenCalledWith(
      channel.id,
      expect.objectContaining({
        content: expect.stringContaining('Browser'),
      })
    );
  });

  it('posts error notification when no agent found', async () => {
    mockParseInviteCommand.mockReturnValue({ capability: 'nonexistent', task: undefined });
    mockFindAgentByCapability.mockReturnValue(null);
    const channel = makeChannel();

    await processInviteSlashCommand('/invite nonexistent', 'Jack', channel);

    expect(mockDispatchInvite).not.toHaveBeenCalled();
    expect(mockAppendMessage).toHaveBeenCalledWith(
      channel.id,
      expect.objectContaining({
        content: expect.stringContaining('nonexistent'),
      })
    );
  });
});
