/**
 * T3: Verify handleMessage() uses deliverMessage() from collab-delivery
 * instead of inline inbox write logic.
 *
 * RED: deliverMessage is NOT called by messaging.ts before the refactor.
 * GREEN: after refactor, deliverMessage is called with (senderId, message, channel).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const voiceMocks = vi.hoisted(() => ({
  validateVoiceReplyContext: vi.fn(),
}));
const ledgerMocks = vi.hoisted(() => ({
  enqueueDurableDeliveries: vi.fn(),
}));

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/collab-delivery', () => ({
  deliverMessage: vi.fn(),
  computeRecipients: vi.fn().mockReturnValue(undefined), // broadcast
  readRolesData: vi.fn().mockResolvedValue([]),
  writeToParticipantInbox: vi.fn().mockResolvedValue(undefined),
  writeToGeminiBridge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/collab-delivery-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collab-delivery-ledger')>()),
  enqueueDurableDeliveries: ledgerMocks.enqueueDurableDeliveries,
}));

vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: vi.fn().mockResolvedValue(undefined),
  appendMessageIfAbsent: vi.fn().mockImplementation(async (_channelId, message) => ({
    message,
    appended: true,
  })),
  appendMessages: vi.fn().mockResolvedValue(undefined),
  appendSilentMessage: vi.fn().mockResolvedValue(undefined),
  archiveOldMessages: vi.fn().mockResolvedValue(undefined),
  findMessage: vi.fn().mockResolvedValue(null),
  findRecentDuplicate: vi.fn().mockResolvedValue(null),
  updateMessage: vi.fn().mockResolvedValue(true),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ask-owner/store', () => ({
  recordQuestion: vi.fn().mockResolvedValue(undefined),
  markAnswered: vi.fn().mockResolvedValue(null),
  findRecentDuplicate: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: {
    emitEvent: vi.fn().mockReturnValue({ id: '1', type: 'test', data: {}, timestamp: '' }),
  },
  emitCollabError: vi.fn(),
}));

vi.mock('@/lib/collab-pty', () => ({
  sendToPty: vi.fn().mockReturnValue(true),
  isPtySessionActive: vi.fn().mockReturnValue(false),
}));

vi.mock('@/teams-integration/lib/teams-bridge', () => ({
  forwardToTeams: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/teams-integration/lib/teams-auth', () => ({
  isTeamsConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('@/slack-integration/lib/slack-bridge', () => ({
  forwardToSlack: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/slack-integration/lib/slack-auth', () => ({
  isSlackConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/collab-utils', () => ({
  parseAtMentions: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/claude-session', () => ({
  spawnCollabAgentSmart: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return { ...real };
});

// The handler saves through the channel store; these tests only need the save to succeed.
vi.mock('@/lib/collab-channel-store', () => ({
  saveChannels: vi.fn().mockResolvedValue(undefined),
  mutateChannels: vi.fn(),
}));

// Mock the shared collab helpers
vi.mock('@/app/api/collab/_collab-shared', () => ({
  markAgentAwayInOtherChannels: vi.fn(),
  invalidateUnreadCache: vi.fn(),
  computePresenceStatus: vi.fn(),
  withTimeout: vi.fn().mockImplementation((_promise: Promise<unknown>) => _promise),
  saveFileToDisk: vi.fn().mockResolvedValue(null),
  MAX_FILES_PER_MESSAGE: 5,
}));

vi.mock('path', async (importOriginal) => {
  return await importOriginal<typeof import('path')>();
});

vi.mock('@/lib/voice/turn-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/turn-control')>()),
  validateVoiceReplyContext: voiceMocks.validateVoiceReplyContext,
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { handleMessage } from '@/app/api/collab/_handlers/messaging';
import { saveChannels } from '@/lib/collab-channel-store';
import { computeRecipients, deliverMessage } from '@/lib/collab-delivery';
import { filterHiddenMessages } from '@/lib/hidden-messages';
import {
  appendMessage,
  appendMessageIfAbsent,
  archiveOldMessages,
  findMessage,
} from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { VoiceTurnConflictError } from '@/lib/voice/turn-control';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SENDER_ID = 'participant-sender';
const CHANNEL_ID = 'channel-001';

function makeChannel(extras: object = {}) {
  return {
    id: CHANNEL_ID,
    name: 'test-channel',
    participants: [
      {
        id: SENDER_ID,
        name: 'Alice',
        type: 'user',
        joinedAt: '2025-01-01T00:00:00Z',
        lastSeen: '2025-01-01T00:00:00Z',
      },
    ],
    messages: [],
    lastActivity: '2025-01-01T00:00:00Z',
    createdAt: '2025-01-01T00:00:00Z',
    settings: { autoRespond: false },
    ...extras,
  };
}

function makeData(channel = makeChannel()) {
  return { channels: [channel], lastUpdated: '2025-01-01T00:00:00Z' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleMessage — delivery path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerMocks.enqueueDurableDeliveries.mockResolvedValue([]);
    voiceMocks.validateVoiceReplyContext.mockResolvedValue({
      replyTo: 'voice-turn-1',
      voice: {
        kind: 'riley.voice.response',
        label: 'Riley Voice',
        conversationSessionId: 'conversation-1',
        audioTurnId: 'audio-1',
        revision: 1,
        inReplyToMessageId: 'voice-turn-1',
      },
    });
  });

  it('finishes saving the channel before it returns, so the write cannot land after the lock is released', async () => {
    // The old handler started the write and carried on; the lock was freed while it was still
    // running, and a later writer's change could be overwritten when it finally landed.
    let finishSave: () => void = () => {};
    let saved = false;
    vi.mocked(saveChannels).mockImplementationOnce(() => new Promise<void>(resolve => {
      finishSave = () => { saved = true; resolve(); };
    }));
    const data = makeData(makeChannel());
    const body = { action: 'message' as const, channelId: CHANNEL_ID, participantId: SENDER_ID, content: 'hello world' };

    let returned = false;
    const pending = handleMessage(data as never, body as never, new Date().toISOString()).then(response => {
      returned = true;
      return response;
    });
    // Wait until the handler has reached its save, then give it time to (wrongly) carry on.
    await vi.waitFor(() => expect(saveChannels).toHaveBeenCalledWith(data), { timeout: 3000 });
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(returned).toBe(false);
    expect(deliverMessage).not.toHaveBeenCalled();

    finishSave();
    const response = await pending;
    expect(saved).toBe(true);
    expect((await response.json()).success).toBe(true);
    expect(deliverMessage).toHaveBeenCalledOnce();
  });

  it('calls deliverMessage() for a non-silent message', async () => {
    const channel = makeChannel();
    const data = makeData(channel);

    const body = {
      action: 'message' as const,
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: 'hello world',
    };

    const res = await handleMessage(data as never, body as never, new Date().toISOString());
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(deliverMessage).toHaveBeenCalledOnce();

    const [calledSenderId, calledMessage, calledChannel] = (deliverMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledSenderId).toBe(SENDER_ID);
    expect(calledMessage.content).toBe('hello world');
    expect(calledChannel.id).toBe(CHANNEL_ID);
  });

  it('preserves the helper hidden flag for a service sender without suppressing agent delivery', async () => {
    const channel = makeChannel();
    channel.participants[0].type = 'service';
    channel.participants[0].name = 'Dashboard';
    vi.mocked(computeRecipients).mockReturnValueOnce(['agent-target']);

    const res = await handleMessage(makeData(channel) as never, {
      action: 'message',
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: '@Jack Dashboard chase',
      mentions: ['agent-target'],
      isHidden: true,
    } as never, '2026-10-09T09:12:22.443Z');

    expect((await res.json()).success).toBe(true);
    const stored = vi.mocked(appendMessage).mock.calls[0][1];
    expect(stored.metadata?.isHidden).toBe(true);
    expect(stored.silent).toBeUndefined();
    expect(stored.recipients).toEqual(['agent-target']);
    expect(ledgerMocks.enqueueDurableDeliveries).toHaveBeenCalledWith(SENDER_ID, stored, channel);
    expect(deliverMessage).toHaveBeenCalledWith(SENDER_ID, stored, channel);
    expect(eventBus.emitEvent).toHaveBeenCalledWith('collab:message', expect.objectContaining({ message: stored }));
    expect(filterHiddenMessages([stored], false)).toEqual([]);
    expect(filterHiddenMessages([stored], true)).toEqual([stored]);
  });

  it.each([undefined, false, 'true'])('keeps ordinary messages visible for isHidden=%s', async (isHidden) => {
    await handleMessage(makeData() as never, {
      action: 'message', channelId: CHANNEL_ID, participantId: SENDER_ID,
      content: 'Visible question or build note', isHidden,
    } as never, '2026-10-09T09:12:22.443Z');

    const stored = vi.mocked(appendMessage).mock.calls[0][1];
    expect(stored.metadata?.isHidden).toBeUndefined();
    expect(filterHiddenMessages([stored], false)).toEqual([stored]);
    expect(deliverMessage).toHaveBeenCalledWith(SENDER_ID, stored, expect.any(Object));
  });

  it('does NOT call deliverMessage() for a silent message', async () => {
    const channel = makeChannel();
    const data = makeData(channel);

    const body = {
      action: 'message' as const,
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: 'silent ping',
      silent: true,
    };

    await handleMessage(data as never, body as never, new Date().toISOString());

    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('passes the fully-built message (with id, timestamp, channelId) to deliverMessage', async () => {
    const channel = makeChannel();
    const data = makeData(channel);

    const now = '2025-06-01T10:00:00.000Z';
    const body = {
      action: 'message' as const,
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: 'structured message',
    };

    await handleMessage(data as never, body as never, now);

    const [, calledMessage] = (deliverMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledMessage.id).toBeDefined();
    expect(calledMessage.channelId).toBe(CHANNEL_ID);
    expect(calledMessage.timestamp).toBe(now);
  });

  it('attaches server-validated reply and voice metadata for an active inbound turn', async () => {
    const channel = makeChannel();
    const data = makeData(channel);
    (findMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'voice-turn-1',
      from: { id: 'owner', name: 'Owner', type: 'user' },
      content: 'Voice request',
    });
    const context = {
      recordId: 'delivery-1',
      messageId: 'voice-turn-1',
      conversationSessionId: 'conversation-1',
      audioTurnId: 'audio-1',
      revision: 1,
    };

    const response = await handleMessage(data as never, {
      action: 'message',
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: 'Voice response',
      voiceResponseContext: context,
      metadata: { voice: { kind: 'untrusted' } },
    } as never, new Date().toISOString());

    expect(response.status).toBe(200);
    expect(voiceMocks.validateVoiceReplyContext).toHaveBeenCalledTimes(2);
    expect(voiceMocks.validateVoiceReplyContext.mock.calls[1][0]).toMatchObject({
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      context,
    });
    expect(voiceMocks.validateVoiceReplyContext.mock.calls[1][0].responseMessageId).toBeTypeOf('string');
    const persisted = (appendMessageIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(persisted.replyTo.id).toBe('voice-turn-1');
    expect(persisted.metadata.voice).toMatchObject({
      kind: 'riley.voice.response',
      revision: 1,
      inReplyToMessageId: 'voice-turn-1',
    });
    expect(archiveOldMessages).toHaveBeenCalledOnce();
  });

  it('rejects a response when cancellation wins the late-reply fence', async () => {
    voiceMocks.validateVoiceReplyContext
      .mockResolvedValueOnce({
        replyTo: 'voice-turn-1',
        voice: {
          kind: 'riley.voice.response',
          label: 'Riley Voice',
          conversationSessionId: 'conversation-1',
          audioTurnId: 'audio-1',
          revision: 1,
          inReplyToMessageId: 'voice-turn-1',
        },
      })
      .mockRejectedValueOnce(new VoiceTurnConflictError('Voice revision no longer accepts replies'));

    const response = await handleMessage(makeData() as never, {
      action: 'message',
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: 'Too late',
      voiceResponseContext: {
        recordId: 'delivery-1',
        messageId: 'voice-turn-1',
        conversationSessionId: 'conversation-1',
        audioTurnId: 'audio-1',
        revision: 1,
      },
    } as never, new Date().toISOString());

    expect(response.status).toBe(409);
    expect(appendMessage).not.toHaveBeenCalled();
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('retries an append failure with the same correlated ID and rejects changed content', async () => {
    let acceptedResponseId: string | undefined;
    voiceMocks.validateVoiceReplyContext.mockImplementation(async (input) => {
      if (input.responseMessageId) {
        if (acceptedResponseId && input.responseMessageId !== acceptedResponseId) {
          throw new VoiceTurnConflictError('Voice revision already has a correlated response');
        }
        acceptedResponseId = input.responseMessageId;
      }
      return {
        replyTo: 'voice-turn-1',
        voice: {
          kind: 'riley.voice.response',
          label: 'Riley Voice',
          conversationSessionId: 'conversation-1',
          audioTurnId: 'audio-1',
          revision: 1,
          inReplyToMessageId: 'voice-turn-1',
        },
      };
    });
    const appendIfAbsent = appendMessageIfAbsent as ReturnType<typeof vi.fn>;
    appendIfAbsent
      .mockRejectedValueOnce(new Error('simulated append failure'))
      .mockImplementation(async (_channelId, message) => ({ message, appended: true }));
    const context = {
      recordId: 'delivery-1',
      messageId: 'voice-turn-1',
      conversationSessionId: 'conversation-1',
      audioTurnId: 'audio-1',
      revision: 1,
    };
    const body = {
      action: 'message' as const,
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: 'Recoverable response',
      voiceResponseContext: context,
    };

    await expect(handleMessage(
      makeData() as never,
      body as never,
      new Date().toISOString(),
    )).rejects.toThrow('simulated append failure');
    const retry = await handleMessage(
      makeData() as never,
      body as never,
      new Date().toISOString(),
    );

    expect(retry.status).toBe(200);
    expect(appendIfAbsent.mock.calls[0][1].id).toBe(appendIfAbsent.mock.calls[1][1].id);

    const changed = await handleMessage(makeData() as never, {
      ...body,
      content: 'Different response',
    } as never, new Date().toISOString());
    expect(changed.status).toBe(409);
    expect(appendIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('repairs durable delivery before succeeding on an appended:false exact retry', async () => {
    const targetId = 'participant-target';
    const channel = makeChannel({
      participants: [
        ...makeChannel().participants,
        {
          id: targetId,
          name: 'Target',
          type: 'codex',
          deliveryProtocol: 'ledger-v1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeen: '2025-01-01T00:00:00Z',
        },
      ],
    });
    const { computeRecipients } = await import('@/lib/collab-delivery');
    (computeRecipients as ReturnType<typeof vi.fn>).mockReturnValueOnce([targetId]);
    const appendIfAbsent = appendMessageIfAbsent as ReturnType<typeof vi.fn>;
    appendIfAbsent.mockImplementationOnce(async (_channelId, message) => ({
      message: structuredClone(message),
      appended: false,
    }));

    const response = await handleMessage(makeData(channel) as never, {
      action: 'message',
      channelId: CHANNEL_ID,
      participantId: SENDER_ID,
      content: '@Target recovered response',
      voiceResponseContext: {
        recordId: 'delivery-1',
        messageId: 'voice-turn-1',
        conversationSessionId: 'conversation-1',
        audioTurnId: 'audio-1',
        revision: 1,
      },
    } as never, new Date().toISOString());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      deduplicated: true,
    });
    expect(ledgerMocks.enqueueDurableDeliveries).toHaveBeenCalledOnce();
    const [, recoveredMessage, recoveredChannel] = ledgerMocks.enqueueDurableDeliveries.mock.calls[0];
    expect(recoveredMessage).toMatchObject({
      content: '@Target recovered response',
      recipients: [targetId],
      metadata: { voice: { kind: 'riley.voice.response' } },
    });
    expect(recoveredChannel.id).toBe(CHANNEL_ID);
    expect(archiveOldMessages).not.toHaveBeenCalled();
    expect(eventBus.emitEvent).not.toHaveBeenCalled();
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('rejects a foreign participant ID when only the destination name matches', async () => {
    const sourceJack = {
      id: 'ledgeros-jack',
      name: 'Jack',
      type: 'claude-terminal',
      projectPath: '/projects/ledgeros/Team/Jack',
      joinedAt: '2025-01-01T00:00:00Z',
      lastSeen: '2025-01-01T00:00:00Z',
    };
    const destinationJack = {
      id: 'zoho-jack',
      name: 'Jack',
      type: 'claude-terminal',
      projectPath: '/projects/zoho/Team/Jack',
      joinedAt: '2025-01-01T00:00:00Z',
      lastSeen: '2025-01-01T00:00:00Z',
    };
    const source = makeChannel({
      id: 'ledgeros-channel',
      name: 'LedgerOS',
      participants: [sourceJack],
    });
    const destination = makeChannel({ participants: [destinationJack] });
    const data = { channels: [source, destination], lastUpdated: '2025-01-01T00:00:00Z' };

    const res = await handleMessage(data as never, {
      action: 'message',
      channelId: CHANNEL_ID,
      participantId: sourceJack.id,
      content: '@Jack unsafe override',
    } as never, new Date().toISOString());

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'Participant not found in channel',
    });
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('targets Ask-Owner question cards to the human participant instead of broadcasting to agents', async () => {
    const agentId = 'roster-daniel';
    const humanId = 'browser-user-owner';
    const channel = makeChannel({
      participants: [
        {
          id: agentId,
          name: 'Daniel',
          type: 'codex',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeen: '2025-01-01T00:00:00Z',
        },
        {
          id: humanId,
          name: 'Owner',
          type: 'user',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeen: '2025-01-01T00:00:00Z',
        },
      ],
    });
    const data = makeData(channel);
    const question = {
      id: 'question-1',
      questionText: 'Restart now?',
      options: [{ id: 'yes', label: 'Yes' }],
      allowOther: true,
      multiSelect: false,
      askedBy: { participantId: agentId, name: 'Daniel' },
      channelId: CHANNEL_ID,
      status: 'pending',
      answer: null,
      createdAt: '2025-06-01T10:00:00.000Z',
    };

    await handleMessage(data as never, {
      action: 'message',
      channelId: CHANNEL_ID,
      participantId: agentId,
      content: 'Question for Owner: Restart now?',
      metadata: { client: { kind: 'ask-owner.question', payload: question } },
    } as never, question.createdAt);

    const [, deliveredMessage] = (deliverMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(deliveredMessage.recipients).toEqual([humanId]);
    expect(deliveredMessage.metadata.deliveryMode).toBe('targeted');
  });
});
