import { beforeEach, describe, expect, it, vi } from 'vitest';

const ioMocks = vi.hoisted(() => ({ readJsonFile: vi.fn() }));

vi.mock('@/lib/data-io', () => ({
  readJsonFile: ioMocks.readJsonFile,
  writeJsonFile: vi.fn(),
  withFileLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/event-bus', () => ({ emitCollabError: vi.fn() }));

import { getMessagesPaginated } from '@/lib/collab-message-io';

const messages = Array.from({ length: 60 }, (_, index) => ({
  id: `message-${index}`,
  channelId: 'channel-1',
  from: { id: 'user-owner', name: 'Owner', type: 'user' },
  content: `message ${index}`,
  timestamp: new Date(Date.UTC(2026, 7, 4, 10, 0, index)).toISOString(),
}));

describe('oldest-first polling pagination', () => {
  beforeEach(() => {
    ioMocks.readJsonFile.mockResolvedValue({
      channelId: 'channel-1',
      messages,
      lastUpdated: messages.at(-1)!.timestamp,
    });
  });

  it('pages forward without hiding the oldest backlog records', async () => {
    const first = await getMessagesPaginated('channel-1', {
      since: new Date(Date.UTC(2026, 7, 4, 9, 59, 59)).toISOString(),
      limit: 50,
      oldestFirst: true,
    });
    expect(first.messages[0].id).toBe('message-0');
    expect(first.messages.at(-1)!.id).toBe('message-49');
    expect(first.hasMore).toBe(true);

    const second = await getMessagesPaginated('channel-1', {
      since: first.messages.at(-1)!.timestamp,
      limit: 50,
      oldestFirst: true,
    });
    expect(second.messages.map(message => message.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `message-${index + 50}`),
    );
    expect(second.hasMore).toBe(false);
  });
});
