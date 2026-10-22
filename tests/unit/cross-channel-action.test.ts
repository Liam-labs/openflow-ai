import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppendMessage,
  mockComputeRecipients,
  mockDeliverMessage,
  mockFindMessage,
  mockFindRecentDuplicate,
  mockReadJsonFile,
  mockSaveFileToDisk,
  mockWriteJsonFile,
} = vi.hoisted(() => ({
  mockAppendMessage: vi.fn().mockResolvedValue(undefined),
  mockComputeRecipients: vi.fn().mockReturnValue(['roster-cjack', 'browser-user-owner']),
  mockDeliverMessage: vi.fn(),
  mockFindMessage: vi.fn().mockResolvedValue(null),
  mockFindRecentDuplicate: vi.fn().mockResolvedValue(undefined),
  mockReadJsonFile: vi.fn(),
  mockSaveFileToDisk: vi.fn(),
  mockWriteJsonFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/app/api/collab/_collab-shared', () => ({
  saveFileToDisk: mockSaveFileToDisk,
  MAX_FILES_PER_MESSAGE: 10,
}));

vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: mockAppendMessage,
  appendSilentMessage: vi.fn().mockResolvedValue(undefined),
  archiveOldMessages: vi.fn().mockResolvedValue(undefined),
  findMessage: mockFindMessage,
  findRecentDuplicate: mockFindRecentDuplicate,
  updateMessage: vi.fn(),
  getMessagesPaginated: vi.fn(),
  readChannelMessages: vi.fn().mockResolvedValue({ messages: [] }),
  deleteChannelMessages: vi.fn(),
}));

vi.mock('@/lib/collab-delivery', () => ({
  computeRecipients: mockComputeRecipients,
  readRolesData: vi.fn().mockResolvedValue([]),
  deliverMessage: mockDeliverMessage,
}));

vi.mock('@/lib/collab-delivery-ledger', () => ({
  prepareDurableDelivery: vi.fn(),
  enqueueDurableDeliveries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/collab-utils', () => ({
  parseAtMentions: vi.fn().mockReturnValue(['roster-cjack']),
}));

vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('@/lib/log-emitter', () => ({ emitApiEvent: vi.fn() }));
vi.mock('@/lib/path-linker-validate', () => ({ validateAndCanonicalize: vi.fn() }));
vi.mock('@/lib/channel-project-bootstrap', () => ({ ensureChannelProject: vi.fn() }));

vi.mock('@/lib/data-io', () => ({
  readJsonFile: mockReadJsonFile,
  writeJsonFile: mockWriteJsonFile,
  withFileLock: vi.fn().mockImplementation((_path: string, fn: () => Promise<unknown>) => fn()),
}));

import { message, presence } from '@/app/api/agent/actions/collab';
import type { CollabChannelsData, CollabMessage } from '@/lib/types';

const channels = (): CollabChannelsData => ({
  channels: [
    {
      id: 'channel-email',
      name: "Email's and Marketing",
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      messages: [],
      settings: { autoRespond: false },
      participants: [{
        id: 'roster-jack',
        name: 'Jack',
        type: 'claude-terminal',
        source: 'collab-claude wrapper',
        joinedAt: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
        pid: 71799,
        projectPath: '/home/user/Emails-and-Marketing/Team/Jack',
      }],
    },
    {
      id: 'channel-devflow',
      name: 'DevFlow',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      messages: [],
      settings: { autoRespond: false },
      participants: [
        {
          id: 'roster-cjack',
          name: 'CJack',
          type: 'codex',
          source: 'collab-codex wrapper',
          joinedAt: '2026-01-01T00:00:00.000Z',
          lastSeen: new Date().toISOString(), // online — the send gate refuses offline targets
        },
        {
          id: 'browser-user-owner',
          name: 'Owner',
          type: 'user',
          source: 'DevFlow UI',
          joinedAt: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  ],
  lastUpdated: '2026-01-01T00:00:00.000Z',
});

describe('collab.cross_channel_message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonFile.mockResolvedValue(channels());
    mockComputeRecipients.mockReturnValue(['roster-cjack', 'browser-user-owner']);
    mockFindMessage.mockResolvedValue(null);
    mockFindRecentDuplicate.mockResolvedValue(undefined);
  });

  it('preserves the source participant identity and injects the reverse route', async () => {
    const result = await message({
      action: 'collab.cross_channel_message',
      sourceChannelId: 'channel-email',
      sourceParticipantId: 'roster-jack',
      targetChannelId: 'channel-devflow',
      targetParticipantId: 'roster-cjack',
      content: '@CJack please check Graph',
    }, {
      tokenId: 'shared-token',
      tokenName: 'Setup Wizard',
      scope: 'write',
      createdBy: 'setup',
      requestId: 'request-1',
    });

    expect(result.sent).toBe(true);
    const stored = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(stored.from.id).toBe('roster-jack');
    expect(stored.from.name).toBe('Jack');
    expect(stored.from.name).not.toBe('Setup Wizard');
    expect(stored.metadata?.crossChannel).toMatchObject({
      sourceChannelId: 'channel-email',
      deliveryChannelId: 'channel-devflow',
      senderId: 'roster-jack',
      senderPid: 71799,
      targetParticipantId: 'roster-cjack',
      targetParticipantName: 'CJack',
    });
    expect(stored.metadata?.isHidden).toBeUndefined();
    expect(stored.content).toContain('sourceParticipantId: `roster-cjack`');
    expect(stored.content).toContain('targetParticipantId: `roster-jack`');
    expect(mockDeliverMessage).toHaveBeenCalledWith('roster-jack', stored, expect.objectContaining({ id: 'channel-devflow' }));
  });

  it('rejects a nonexistent claimed source participant instead of using the API token identity', async () => {
    await expect(message({
      action: 'collab.cross_channel_message',
      sourceChannelId: 'channel-email',
      sourceParticipantId: 'missing-agent',
      targetChannelId: 'channel-devflow',
      content: '@CJack hello',
    }, {
      tokenId: 'shared-token',
      tokenName: 'Setup Wizard',
      scope: 'write',
      createdBy: 'setup',
      requestId: 'request-2',
    })).rejects.toThrow('Source participant not found: missing-agent');
  });

  it('rejects an untargeted cross-channel broadcast', async () => {
    mockComputeRecipients.mockReturnValue(undefined);

    await expect(message({
      action: 'collab.cross_channel_message',
      sourceChannelId: 'channel-email',
      sourceParticipantId: 'roster-jack',
      targetChannelId: 'channel-devflow',
      content: 'hello everyone',
    }, {
      tokenId: 'shared-token',
      tokenName: 'Setup Wizard',
      scope: 'write',
      createdBy: 'setup',
      requestId: 'request-3',
    })).rejects.toThrow('Cross-channel messages must target a participant');
  });

  it('threads a cross-channel reply to the incoming message stored in the source channel', async () => {
    mockFindMessage.mockImplementation(async (channelId: string, messageId: string) => {
      if (channelId !== 'channel-email' || messageId !== 'incoming-cross-message') return null;
      return {
        id: messageId,
        channelId,
        from: channels().channels[0].participants[0],
        content: '@CJack incoming request',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
    });

    await message({
      action: 'collab.cross_channel_message',
      sourceChannelId: 'channel-email',
      sourceParticipantId: 'roster-jack',
      targetChannelId: 'channel-devflow',
      targetParticipantId: 'roster-cjack',
      replyTo: 'incoming-cross-message',
      content: '@CJack threaded reply',
    }, {
      tokenId: 'shared-token',
      tokenName: 'Setup Wizard',
      scope: 'write',
      createdBy: 'setup',
      requestId: 'request-4',
    });

    const stored = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(mockFindMessage).toHaveBeenCalledWith('channel-devflow', 'incoming-cross-message');
    expect(mockFindMessage).toHaveBeenCalledWith('channel-email', 'incoming-cross-message');
    expect(stored.replyTo).toMatchObject({
      id: 'incoming-cross-message',
      from: { id: 'roster-jack', name: 'Jack' },
    });
  });

  it('rejects name-only local fallback across different project identities', async () => {
    const data = channels();
    data.channels[1].participants.unshift({
      id: 'roster-other-jack',
      name: 'Jack',
      type: 'codex',
      source: 'collab-codex wrapper',
      joinedAt: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      projectPath: '/home/user/Another-Project/Team/Jack',
    });
    mockReadJsonFile.mockResolvedValue(data);

    await expect(message({
      action: 'collab.message',
      channelId: 'channel-devflow',
      participantId: 'roster-jack',
      content: '@CJack unsafe foreign-channel post',
    }, {
      tokenId: 'shared-token',
      tokenName: 'Setup Wizard',
      scope: 'write',
      createdBy: 'setup',
      requestId: 'request-5',
    })).rejects.toThrow('Participant not found: roster-jack');
  });

  it('deduplicates and re-enqueues an identical cross-channel retry', async () => {
    const duplicate = {
      id: 'existing-cross-message',
      channelId: 'channel-devflow',
      from: channels().channels[0].participants[0],
      content: 'existing envelope',
      timestamp: '2026-01-01T00:00:00.000Z',
    } as CollabMessage;
    mockFindRecentDuplicate.mockResolvedValue(duplicate);

    const result = await message({
      action: 'collab.cross_channel_message',
      sourceChannelId: 'channel-email',
      sourceParticipantId: 'roster-jack',
      targetChannelId: 'channel-devflow',
      targetParticipantId: 'roster-cjack',
      content: '@CJack please check Graph',
    }, {
      tokenId: 'shared-token',
      tokenName: 'Setup Wizard',
      scope: 'write',
      createdBy: 'setup',
      requestId: 'request-6',
    });

    expect(result).toEqual({ messageId: 'existing-cross-message', sent: true });
    expect(mockFindRecentDuplicate).toHaveBeenCalledWith(
      'channel-devflow', 'roster-jack', expect.stringContaining('@CJack please check Graph'), 60_000
    );
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });
});

describe('cross-channel recipient presence', () => {
  const auth = {
    tokenId: 'shared-token',
    tokenName: 'Setup Wizard',
    scope: 'write' as const,
    createdBy: 'setup',
    requestId: 'request-presence',
  };
  const send = (extra: Record<string, unknown> = {}) => message({
    action: 'collab.cross_channel_message',
    sourceChannelId: 'channel-email',
    sourceParticipantId: 'roster-jack',
    targetChannelId: 'channel-devflow',
    content: '@CJack @Heimdall please review',
    ...extra,
  }, auth);
  const withHeimdall = (heimdall: Partial<CollabChannelsData['channels'][0]['participants'][0]>, cjackOnline = true) => {
    const data = channels();
    const devflow = data.channels[1];
    if (!cjackOnline) devflow.participants[0].lastSeen = '2026-09-20T02:59:33.443Z';
    devflow.participants.push({
      id: 'roster-heimdall',
      name: 'Heimdall',
      type: 'claude-terminal',
      source: 'collab-claude wrapper',
      joinedAt: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-09-20T02:59:48.822Z',
      ...heimdall,
    });
    return data;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMessage.mockResolvedValue(null);
    mockFindRecentDuplicate.mockResolvedValue(undefined);
    mockComputeRecipients.mockReturnValue(['roster-cjack', 'roster-heimdall', 'browser-user-owner']);
  });

  it('refuses when every addressed agent is offline and names who is online instead', async () => {
    const data = withHeimdall({}, false);
    data.channels[1].participants.push({
      id: 'roster-vala', name: 'Vala', type: 'claude-terminal', source: 'collab-claude wrapper',
      joinedAt: '2026-01-01T00:00:00.000Z', lastSeen: new Date().toISOString(),
    });
    mockReadJsonFile.mockResolvedValue(data);

    const err = await send().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('RECIPIENTS_OFFLINE');
    expect(err.message).toContain('Offline: CJack (last seen');
    expect(err.message).toContain('Heimdall (last seen');
    expect(err.message).toContain('Online now: Vala');
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockDeliverMessage).not.toHaveBeenCalled();
  });

  it('sends when explicitly allowed to wait for an offline agent', async () => {
    mockReadJsonFile.mockResolvedValue(withHeimdall({}, false));
    const result = await send({ allowOffline: true });
    expect(result.sent).toBe(true);
    expect(result.offlineRecipients).toBeUndefined();
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends to a partly online audience and reports the offline agents', async () => {
    mockReadJsonFile.mockResolvedValue(withHeimdall({}));
    const result = await send();
    expect(result.sent).toBe(true);
    expect(result.offlineRecipients).toEqual(['Heimdall']);
  });

  it('counts an away agent as reachable when it is online in the channel it moved to', async () => {
    const data = withHeimdall({ status: 'away', awayInChannelId: 'channel-email', awayInChannelName: "Email's and Marketing" }, false);
    data.channels[0].participants.push({
      id: 'roster-heimdall-email', name: 'Heimdall', type: 'claude-terminal', source: 'collab-claude wrapper',
      joinedAt: '2026-01-01T00:00:00.000Z', lastSeen: new Date().toISOString(),
    });
    mockReadJsonFile.mockResolvedValue(data);
    const result = await send();
    expect(result.sent).toBe(true);
    expect(result.offlineRecipients).toEqual(['CJack']);
  });

  it('judges an agent with two participant IDs as online when either is live', async () => {
    const data = withHeimdall({ lastSeen: new Date().toISOString() });
    data.channels[1].participants.push({
      id: 'join-heimdall-old', name: 'Heimdall', type: 'claude-terminal', source: 'collab-claude wrapper',
      joinedAt: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
    });
    mockComputeRecipients.mockReturnValue(['roster-heimdall', 'join-heimdall-old', 'browser-user-owner']);
    mockReadJsonFile.mockResolvedValue(data);
    const result = await send({ content: '@Heimdall hi' });
    expect(result.offlineRecipients).toBeUndefined();
  });

  it('does not gate a message addressed only to the human', async () => {
    mockReadJsonFile.mockResolvedValue(withHeimdall({}, false));
    mockComputeRecipients.mockReturnValue(['browser-user-owner']);
    const result = await send({ content: '@Owner update' });
    expect(result.sent).toBe(true);
  });

  it('collab.presence lists online, away and offline participants', async () => {
    const data = withHeimdall({ status: 'away', awayInChannelId: 'channel-email', awayInChannelName: "Email's and Marketing" });
    data.channels[1].participants.find(p => p.id === 'roster-heimdall')!.lastSeen = '2026-09-20T02:59:48.822Z';
    data.channels[0].participants[0].lastSeen = new Date().toISOString();
    data.channels[0].participants.push({
      id: 'roster-heimdall-email', name: 'Heimdall', type: 'claude-terminal', source: 'collab-claude wrapper',
      joinedAt: '2026-01-01T00:00:00.000Z', lastSeen: new Date().toISOString(),
    });
    mockReadJsonFile.mockResolvedValue(data);
    const result = await presence({ action: 'collab.presence', channelId: 'channel-devflow' }, { ...auth, scope: 'read' });
    const byName = Object.fromEntries(result.participants.map(p => [p.name, p.status]));
    expect(byName).toMatchObject({ CJack: 'online', Heimdall: 'away', Owner: 'offline' });
    expect(result.online).toEqual(['CJack', 'Heimdall']);
  });
});

describe('collab.cross_channel_message attachments', () => {
  const auth = {
    tokenId: 'shared-token',
    tokenName: 'Setup Wizard',
    scope: 'write' as const,
    createdBy: 'setup',
    requestId: 'request-att',
  };
  const send = (extra: Record<string, unknown>) => message({
    action: 'collab.cross_channel_message',
    sourceChannelId: 'channel-email',
    sourceParticipantId: 'roster-jack',
    targetChannelId: 'channel-devflow',
    targetParticipantId: 'roster-cjack',
    content: '@CJack see attached',
    ...extra,
  }, auth);
  const png = (name: string) => ({
    data: 'data:image/png;base64,iVBORw0KGgo=',
    name,
    type: 'image/png',
    size: 8,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonFile.mockResolvedValue(channels());
    mockComputeRecipients.mockReturnValue(['roster-cjack', 'browser-user-owner']);
    mockFindMessage.mockResolvedValue(null);
    mockFindRecentDuplicate.mockResolvedValue(undefined);
    mockSaveFileToDisk.mockImplementation(async (_data: string, messageId: string, index: number, name?: string) => ({
      url: `/api/collab/images/${messageId}-${index}.png`,
      filename: `${name ?? 'x'}`,
    }));
  });

  it('saves uploaded data-URL images on a cross-channel message and reports them', async () => {
    const result = await send({ images: [png('a.png'), png('b.png')] });

    expect(mockSaveFileToDisk).toHaveBeenCalledTimes(2);
    expect(mockSaveFileToDisk.mock.calls[0][0]).toBe(png('a.png').data);
    expect(mockSaveFileToDisk.mock.calls[0][3]).toBe('a.png');
    expect(result.attachments).toEqual({ requested: 2, saved: 2, failed: [] });
    const stored = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(stored.images).toHaveLength(2);
    expect(stored.images?.[0]).toMatchObject({ name: 'a.png', type: 'image/png', size: 8 });
    expect(stored.images?.[0].url).toMatch(/^\/api\/collab\/images\/.+-0\.png$/);
    expect(stored.images?.[0].data).toBeUndefined();
    expect(stored.metadata?.imageUrls).toHaveLength(2);
  });

  it('reports a partial save instead of silently dropping the attachment', async () => {
    mockSaveFileToDisk.mockImplementationOnce(async (_d: string, messageId: string, index: number) => ({
      url: `/api/collab/images/${messageId}-${index}.png`,
      filename: 'ok.png',
    })).mockResolvedValueOnce(null);

    const result = await send({ images: [png('ok.png'), png('bad.png')] });

    expect(result.sent).toBe(true);
    expect(result.attachments?.requested).toBe(2);
    expect(result.attachments?.saved).toBe(1);
    expect(result.attachments?.failed).toEqual([
      { name: 'bad.png', reason: expect.stringContaining('invalid data URL') },
    ]);
    const stored = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(stored.images).toHaveLength(1);
  });

  it('reports filePaths the server cannot read and still posts the message', async () => {
    const result = await send({ filePaths: ['/home/desktop-only/shot.png'] });

    expect(result.sent).toBe(true);
    expect(result.attachments).toMatchObject({ requested: 1, saved: 0 });
    expect(result.attachments?.failed[0]).toMatchObject({ name: '/home/desktop-only/shot.png' });
    expect(result.attachments?.failed[0].reason).toContain('images');
    const stored = mockAppendMessage.mock.calls[0][1] as CollabMessage;
    expect(stored.images).toBeUndefined();
  });

  it('rejects attachments beyond the per-message limit in the report', async () => {
    const many = Array.from({ length: 12 }, (_, i) => png(`f${i}.png`));
    const result = await send({ images: many });

    expect(mockSaveFileToDisk).toHaveBeenCalledTimes(10);
    expect(result.attachments).toMatchObject({ requested: 12, saved: 10 });
    expect(result.attachments?.failed).toHaveLength(2);
  });

  it('omits the attachments report when nothing was attached', async () => {
    const result = await send({});
    expect(result.attachments).toBeUndefined();
  });

  it('also accepts uploaded images on a same-channel collab.message', async () => {
    const result = await message({
      action: 'collab.message',
      channelId: 'channel-email',
      participantId: 'roster-jack',
      content: 'local attachment',
      images: [png('local.png')],
    }, auth);
    expect(result.attachments).toEqual({ requested: 1, saved: 1, failed: [] });
  });
});
