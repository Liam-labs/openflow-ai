import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppendMessage,
  mockDeliverMessage,
  mockEmitEvent,
  mockEnqueue,
  mockReadJsonFile,
  mockWriteJsonFile,
} = vi.hoisted(() => ({
  mockAppendMessage: vi.fn().mockResolvedValue(undefined),
  mockDeliverMessage: vi.fn(),
  mockEmitEvent: vi.fn(),
  mockEnqueue: vi.fn().mockResolvedValue(undefined),
  mockReadJsonFile: vi.fn(),
  mockWriteJsonFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/app/api/collab/_collab-shared', () => ({
  saveFileToDisk: vi.fn(),
  MAX_FILES_PER_MESSAGE: 10,
}));
vi.mock('@/lib/collab-message-io', () => ({
  appendMessage: mockAppendMessage,
  appendSilentMessage: vi.fn().mockResolvedValue(undefined),
  archiveOldMessages: vi.fn().mockResolvedValue(undefined),
  findMessage: vi.fn().mockResolvedValue(null),
  findRecentDuplicate: vi.fn().mockResolvedValue(undefined),
  updateMessage: vi.fn(),
  getMessagesPaginated: vi.fn(),
  readChannelMessages: vi.fn().mockResolvedValue({ messages: [] }),
  deleteChannelMessages: vi.fn(),
}));
vi.mock('@/lib/collab-delivery', async () => {
  const real = await vi.importActual<typeof import('@/lib/collab-delivery')>('@/lib/collab-delivery');
  return {
    computeRecipients: real.computeRecipients,
    readRolesData: vi.fn().mockResolvedValue([]),
    deliverMessage: mockDeliverMessage,
  };
});
vi.mock('@/lib/collab-delivery-ledger', () => ({
  prepareDurableDelivery: vi.fn(),
  enqueueDurableDeliveries: mockEnqueue,
}));
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: mockEmitEvent } }));
vi.mock('@/lib/log-emitter', () => ({ emitApiEvent: vi.fn() }));
vi.mock('@/lib/path-linker-validate', () => ({ validateAndCanonicalize: vi.fn() }));
vi.mock('@/lib/channel-project-bootstrap', () => ({ ensureChannelProject: vi.fn() }));
vi.mock('@/lib/data-io', () => ({
  readJsonFile: mockReadJsonFile,
  writeJsonFile: mockWriteJsonFile,
  withFileLock: vi.fn().mockImplementation((_path: string, fn: () => Promise<unknown>) => fn()),
}));

import {
  OFFLINE_NOTICE_KIND,
  OFFLINE_NOTICE_WINDOW_MS,
  findOfflineMentions,
  postOfflineMentionNotice,
  resetOfflineMentionRateLimit,
} from '@/lib/collab-offline-mention-notice';
import { message } from '@/app/api/agent/actions/collab';
import type { CollabChannel, CollabChannelsData, CollabParticipant } from '@/lib/types';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function participant(id: string, name: string, type: CollabParticipant['type'], lastSeenOffsetMs: number): CollabParticipant {
  return { id, name, type, source: 'test', joinedAt: iso(-86_400_000), lastSeen: iso(lastSeenOffsetMs) };
}

function makeData(): CollabChannelsData {
  const channel: CollabChannel = {
    id: 'ch-1',
    name: 'Test channel',
    createdAt: iso(-86_400_000),
    lastActivity: iso(0),
    messages: [],
    settings: { autoRespond: false },
    participants: [
      participant('p-alice', 'Alice', 'claude', -1_000),          // online, the sender
      participant('p-bob', 'Bob', 'claude', -3 * 60 * 60_000),    // offline: seen 3h ago
      participant('p-cara', 'Cara', 'claude', -2_000),            // online
      participant('u-owner', 'Owner', 'user', -3 * 60 * 60_000),    // human, stale lastSeen
    ],
    roster: {
      agents: [{ id: 'roster-bob', name: 'Bob', participantId: 'p-bob', channelId: 'ch-1', workingDirectory: '/x', color: '#fff', status: 'stopped' }],
      lastUpdated: iso(0),
    },
  } as unknown as CollabChannel;
  return { channels: [channel], lastUpdated: iso(0) };
}

const find = (over: Partial<Parameters<typeof findOfflineMentions>[0]> & { recipients: string[] | undefined }) => {
  const data = makeData();
  const channel = data.channels[0];
  return findOfflineMentions({
    channel,
    data,
    sender: channel.participants[0],
    message: {},
    now: NOW,
    ...over,
  });
};

describe('findOfflineMentions', () => {
  it('reports an offline agent and carries its roster agentId', () => {
    const result = find({ recipients: ['p-bob'] });
    expect(result).toEqual([expect.objectContaining({ name: 'Bob', agentId: 'roster-bob' })]);
  });

  it('reports nothing for an online agent', () => {
    expect(find({ recipients: ['p-cara'] })).toEqual([]);
  });

  it('only lists the offline one when online and offline agents are both mentioned', () => {
    expect(find({ recipients: ['p-cara', 'p-bob'] }).map(o => o.name)).toEqual(['Bob']);
  });

  it('never treats humans or the sender as offline agents', () => {
    expect(find({ recipients: ['u-owner', 'p-alice'] })).toEqual([]);
  });

  it('ignores system senders, silent messages and structured/automated messages', () => {
    const data = makeData();
    const channel = data.channels[0];
    const system = { ...participant('system', 'System', 'user', 0) };
    expect(find({ recipients: ['p-bob'], sender: system })).toEqual([]);
    expect(find({ recipients: ['p-bob'], message: { silent: true } })).toEqual([]);
    expect(find({ recipients: ['p-bob'], message: { metadata: { deliveryMode: 'targeted', client: { kind: OFFLINE_NOTICE_KIND } } } })).toEqual([]);
    expect(find({ recipients: ['p-bob'], message: { metadata: { deliveryMode: 'targeted', client: { kind: 'outlook.notification' } } } })).toEqual([]);
    expect(find({ recipients: undefined })).toEqual([]);
    expect(channel.participants).toHaveLength(4);
  });

  it('treats a stopped roster agent with no participant entry as offline', () => {
    const data = makeData();
    const channel = data.channels[0];
    channel.participants = channel.participants.filter(p => p.id !== 'p-bob');
    const result = findOfflineMentions({ channel, data, sender: channel.participants[0], message: {}, recipients: ['p-bob'], now: NOW });
    expect(result.map(o => o.name)).toEqual(['Bob']);
  });
});

describe('postOfflineMentionNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOfflineMentionRateLimit();
  });

  const setup = (senderIndex = 0) => {
    const data = makeData();
    const channel = data.channels[0];
    const sender = channel.participants[senderIndex];
    const offline = findOfflineMentions({ channel, data, sender, message: {}, recipients: ['p-bob'], now: NOW });
    return { channel, sender, offline };
  };

  it('sends the sender a system notice that names the agent and how to bring it online', async () => {
    const { channel, sender, offline } = setup();
    const id = await postOfflineMentionNotice({ channel, sender, offline, now: NOW });
    expect(id).toBeTruthy();

    const posted = mockAppendMessage.mock.calls[0][1];
    expect(mockAppendMessage.mock.calls[0][0]).toBe('ch-1');
    expect(posted.from).toMatchObject({ id: 'system', name: 'System' });
    expect(posted.content.startsWith('@Alice ')).toBe(true);
    expect(posted.content).toContain('Bob is offline');
    expect(posted.content).toContain("won't see your message until back online");
    expect(posted.content).toContain('without them');
    expect(posted.content).toContain('roster.spawn');
    expect(posted.content).toContain('roster-bob');
    expect(posted.content).not.toContain('@Bob');
    expect(posted.metadata.client.kind).toBe(OFFLINE_NOTICE_KIND);
  });

  it('is targeted at the sender only, so no offline or other agent is woken', async () => {
    const { channel, sender, offline } = setup();
    await postOfflineMentionNotice({ channel, sender, offline, now: NOW });
    const posted = mockAppendMessage.mock.calls[0][1];
    expect(posted.recipients).toEqual(['p-alice']);
    expect(posted.mentions).toEqual(['p-alice']);
    expect(posted.metadata.deliveryMode).toBe('targeted');
    expect(mockDeliverMessage).toHaveBeenCalledWith('system', posted, channel);
    expect(mockEmitEvent).toHaveBeenCalledWith('collab:message', expect.objectContaining({ channelId: 'ch-1' }));
  });

  it('gives a human sender a short notice without agent API instructions', async () => {
    const { channel, sender, offline } = setup(3); // Owner
    expect(sender.type).toBe('user');
    await postOfflineMentionNotice({ channel, sender, offline, now: NOW });
    const posted = mockAppendMessage.mock.calls[0][1];
    expect(posted.recipients).toEqual(['u-owner']);
    expect(posted.content).toContain('Bob is offline');
    expect(posted.content).toContain('agent roster');
    expect(posted.content).not.toContain('roster.spawn');
  });

  it('rate-limits to one notice per channel, sender and target per 10 minutes', async () => {
    const { channel, sender, offline } = setup();
    expect(await postOfflineMentionNotice({ channel, sender, offline, now: NOW })).toBeTruthy();
    expect(await postOfflineMentionNotice({ channel, sender, offline, now: NOW + OFFLINE_NOTICE_WINDOW_MS - 1 })).toBeNull();
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);

    // A different sender is a different key.
    const other = channel.participants[2];
    expect(await postOfflineMentionNotice({ channel, sender: other, offline, now: NOW + 1_000 })).toBeTruthy();

    // After the window the original sender is told again.
    expect(await postOfflineMentionNotice({ channel, sender, offline, now: NOW + OFFLINE_NOTICE_WINDOW_MS })).toBeTruthy();
    expect(mockAppendMessage).toHaveBeenCalledTimes(3);
  });

  it('does not consume the rate limit when posting fails', async () => {
    const { channel, sender, offline } = setup();
    mockAppendMessage.mockRejectedValueOnce(new Error('disk'));
    expect(await postOfflineMentionNotice({ channel, sender, offline, now: NOW })).toBeNull();
    expect(await postOfflineMentionNotice({ channel, sender, offline, now: NOW + 1 })).toBeTruthy();
  });
});

describe('collab.message end to end (Agent API path)', () => {
  const auth = { tokenId: 't', tokenName: 'test', scope: 'write', createdBy: 'test', requestId: 'req' } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    resetOfflineMentionRateLimit();
    const data = makeData();
    // collab.message stamps real "now", so make the fixture relative to real time.
    const shift = Date.now() - NOW;
    for (const p of data.channels[0].participants) p.lastSeen = new Date(Date.parse(p.lastSeen) + shift).toISOString();
    mockReadJsonFile.mockResolvedValue(data);
  });

  it('notifies the sender about an offline agent and returns offlineMentions; the message itself is unchanged', async () => {
    const result = await message({ action: 'collab.message', channelId: 'ch-1', participantId: 'p-alice', content: '@Bob please review' }, auth);
    expect(result).toMatchObject({ sent: true, offlineMentions: ['Bob'] });

    const [original, notice] = mockAppendMessage.mock.calls.map(c => c[1]);
    expect(original.from.id).toBe('p-alice');
    expect(original.recipients).toContain('p-bob');
    expect(notice.from.id).toBe('system');
    expect(notice.recipients).toEqual(['p-alice']);
  });

  it('adds no notice and no offlineMentions for an online agent', async () => {
    const result = await message({ action: 'collab.message', channelId: 'ch-1', participantId: 'p-alice', content: '@Cara hello' }, auth);
    expect(result).not.toHaveProperty('offlineMentions');
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not answer its own notice or a system message with another notice', async () => {
    // The notice is appended directly; a sender called System never triggers one.
    const data = makeData();
    data.channels[0].participants.push({ ...participant('system', 'System', 'user', 0), lastSeen: new Date().toISOString() });
    mockReadJsonFile.mockResolvedValue(data);
    const result = await message({ action: 'collab.message', channelId: 'ch-1', participantId: 'system', content: '@Bob wake up' }, auth);
    expect(result).not.toHaveProperty('offlineMentions');
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
  });
});
