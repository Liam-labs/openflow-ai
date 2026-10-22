import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  readData: vi.fn(),
  readChannelMessages: vi.fn(),
  setCachedUnreadCounts: vi.fn(),
  resolveWebGateIdentity: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  requireAuthOrLocal: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/api-tracking', () => ({
  withTiming: vi.fn().mockImplementation((_: string, handler: unknown) => handler),
}));

vi.mock('@/lib/error-rate-tracker', () => ({ trackResponse: vi.fn() }));
vi.mock('@/lib/event-bus', () => ({ emitCollabError: vi.fn() }));

vi.mock('@/lib/data-io', () => ({
  readJsonFile: vi.fn(),
  withFileLock: vi.fn().mockImplementation(
    (_path: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock('@/lib/collab-message-io', () => ({
  readChannelMessages: mocks.readChannelMessages,
  getMessagesPaginated: vi.fn(),
}));

vi.mock('@/lib/webgate-identity', () => ({
  resolveWebGateIdentity: mocks.resolveWebGateIdentity,
}));

vi.mock('@/app/api/collab/_collab-shared', () => ({
  DATA_PATH: '/tmp/collab-sidebar-route-test.json',
  readData: mocks.readData,
  writeData: vi.fn(),
  cleanupStaleParticipants: vi.fn(),
  migrateMessagesToSeparateFiles: vi.fn().mockResolvedValue(undefined),
  getCachedUnreadCounts: vi.fn().mockReturnValue(null),
  getCachedLastMessageAt: vi.fn(),
  getCachedLastMessagePreview: vi.fn(),
  setCachedUnreadCounts: mocks.setCachedUnreadCounts,
  computeUnreadCounts: vi.fn().mockImplementation((channel: {
    participants: Array<{ unreadCount?: number }>;
  }) => {
    channel.participants[0].unreadCount = 4;
  }),
  computePresenceStatus: vi.fn(),
  toSlimMessages: vi.fn((messages: unknown[]) => messages),
}));

vi.mock('@/app/api/collab/_handlers/lifecycle', () => ({
  handleCreate: vi.fn(), handleJoin: vi.fn(), handleLeave: vi.fn(),
  handleDelete: vi.fn(), handleArchive: vi.fn(), handleRestore: vi.fn(),
  handleListArchived: vi.fn(), handlePermanentlyDelete: vi.fn(),
}));

vi.mock('@/app/api/collab/_handlers/messaging', () => ({
  handleMessage: vi.fn(), handleReact: vi.fn(), handlePin: vi.fn(),
  handleEdit: vi.fn(), handleDeleteMessage: vi.fn(), handleRecall: vi.fn(),
}));

vi.mock('@/app/api/collab/_handlers/settings', () => ({
  handleUpdateSettings: vi.fn(), handleMarkRead: vi.fn(), handleHeartbeat: vi.fn(),
  handleRename: vi.fn(), handleCreateSubchannel: vi.fn(), handleReparent: vi.fn(),
  handleRenameParticipant: vi.fn(),
}));

describe('GET /api/collab sidebar metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWebGateIdentity.mockResolvedValue({
      email: 'owner@example.com',
      canonicalParticipantId: 'user-owner-doe',
      canonicalName: 'Owner',
    });
    mocks.readData.mockResolvedValue({
      channels: [{
        id: 'channel-1',
        name: 'Channel One',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-07-18T12:25:00.000Z',
        participants: [{
          id: 'user-owner-doe',
          name: 'Owner',
          type: 'user',
          joinedAt: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-07-18T12:00:00.000Z',
        }],
        messages: [],
        settings: { autoRespond: false },
      }],
      lastUpdated: '2026-07-18T12:00:00.000Z',
    });
    mocks.readChannelMessages.mockResolvedValue({
      messages: [
        { timestamp: '2026-07-18T09:00:00.000Z', from: { id: 'agent-1', name: 'Jack Carter' }, content: 'build is green' },
        { timestamp: '2026-07-18T10:00:00.000Z', from: { id: 'system' } },
      ],
    });
  });

  it('returns the canonical identity, unread count, and latest visible message time', async () => {
    const { GET } = await import('@/app/api/collab/route');
    const request = new NextRequest(
      'http://localhost:3000/api/collab?participantId=browser-user-local',
    );

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.participantId).toBe('user-owner-doe');
    expect(body.channels[0].participants[0].unreadCount).toBe(4);
    expect(body.channels[0].lastMessageAt).toBe('2026-07-18T09:00:00.000Z');
    expect(body.channels[0].lastMessagePreview).toBe('Jack: build is green');
    expect(mocks.setCachedUnreadCounts).toHaveBeenCalledWith(
      'channel-1',
      expect.any(Map),
      '2026-07-18T09:00:00.000Z',
      'Jack: build is green',
    );
  });
});
