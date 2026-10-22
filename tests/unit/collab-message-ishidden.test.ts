/**
 * Unit tests for isHidden field in collab.message action (T1.1).
 *
 * Verifies that when isHidden: true is passed in the request body,
 * metadata.isHidden is set on the stored message; and absent otherwise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks (vi.mock factories are hoisted — variables must be too) ───

const { mockAppendMessage, mockReadJsonFile } = vi.hoisted(() => ({
  mockAppendMessage: vi.fn().mockResolvedValue(undefined),
  mockReadJsonFile: vi.fn(),
}));

vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: mockAppendMessage,
  appendSilentMessage: vi.fn().mockResolvedValue(undefined),
  archiveOldMessages: vi.fn().mockResolvedValue(undefined),
  findMessage: vi.fn().mockResolvedValue(null),
  findRecentDuplicate: vi.fn().mockResolvedValue(null),
  updateMessage: vi.fn(),
  getMessagesPaginated: vi.fn(),
  readChannelMessages: vi.fn().mockResolvedValue({ messages: [] }),
  deleteChannelMessages: vi.fn(),
  writeChannelMessages: vi.fn(),
}));

vi.mock('@/lib/collab-delivery', () => ({
  computeRecipients: vi.fn().mockReturnValue(undefined),
  readRolesData: vi.fn().mockResolvedValue([]),
  deliverMessage: vi.fn(),
}));

vi.mock('@/lib/collab-utils', () => ({
  parseAtMentions: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: { emitEvent: vi.fn() },
}));

vi.mock('@/lib/log-emitter', () => ({
  emitApiEvent: vi.fn(),
}));

vi.mock('@/lib/data-io', () => ({
  readJsonFile: mockReadJsonFile,
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn().mockImplementation(
    (_path: string, fn: () => Promise<unknown>) => fn()
  ),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import type { CollabMessage, CollabChannel, CollabChannelsData } from '@/lib/types';
import { message } from '@/app/api/agent/actions/collab';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CHANNEL_ID = 'test-channel-id';
const PARTICIPANT_ID = 'test-participant-id';

function makeChannelData(): CollabChannelsData {
  const channel: CollabChannel = {
    id: CHANNEL_ID,
    name: 'Test Channel',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    ownerId: PARTICIPANT_ID,
    participants: [
      {
        id: PARTICIPANT_ID,
        type: 'claude',
        name: 'Builder',
        source: 'WSL',
        joinedAt: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
    ],
    messages: [],
    settings: { autoRespond: false },
  };
  return {
    channels: [channel],
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
}

const mockAuth = {
  tokenId: 'tok-test',
  tokenName: 'test',
  scope: 'write' as const,
  createdBy: 'test',
  requestId: 'req-test',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('collab.message — isHidden field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonFile.mockResolvedValue(makeChannelData());
  });

  it('stores metadata.isHidden = true when isHidden: true is passed', async () => {
    const result = await message(
      { action: 'collab.message', channelId: CHANNEL_ID, participantId: PARTICIPANT_ID, content: 'hello', isHidden: true },
      mockAuth
    );

    expect(result.sent).toBe(true);
    expect(mockAppendMessage).toHaveBeenCalledOnce();

    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.metadata?.isHidden).toBe(true);
  });

  it('omits metadata.isHidden when isHidden is absent', async () => {
    const result = await message(
      { action: 'collab.message', channelId: CHANNEL_ID, participantId: PARTICIPANT_ID, content: 'hello' },
      mockAuth
    );

    expect(result.sent).toBe(true);
    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.metadata?.isHidden).toBeUndefined();
  });

  it('omits metadata.isHidden when isHidden is false', async () => {
    const result = await message(
      { action: 'collab.message', channelId: CHANNEL_ID, participantId: PARTICIPANT_ID, content: 'hello', isHidden: false },
      mockAuth
    );

    expect(result.sent).toBe(true);
    const storedMsg = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(storedMsg.metadata?.isHidden).toBeUndefined();
  });
});
