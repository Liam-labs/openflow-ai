import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { readJsonFile, saveChannels, store } = vi.hoisted(() => ({
  readJsonFile: vi.fn(),
  saveChannels: vi.fn(),
  store: { data: { channels: [] as unknown[] } },
}));
vi.mock('@/lib/api-auth', () => ({ requireAuthOrLocal: async () => null }));
vi.mock('@/lib/data-io', () => ({ readJsonFile }));
vi.mock('@/lib/collab-channel-store', () => ({
  mutateChannels: async (_caller: string, fn: (data: unknown) => unknown) => fn(store.data),
  saveChannels,
}));

import { GET, POST } from '@/app/api/agent/context-health/route';

const agentRecord = () => store.data.channels[0] as { roster: { agents: Array<{ lastContextHealth?: Record<string, unknown> }> } };
const post = (body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/agent/context-health', { method: 'POST', body: JSON.stringify(body) }));
const get = (channelId: string) => GET(new NextRequest(`http://localhost/api/agent/context-health?channelId=${channelId}`));
const reading = { participantId: 'p1', channelId: 'c1', contextPercent: 27.5, turnCount: 190, model: 'claude-sonnet-5-5' };

describe('POST /api/agent/context-health', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    store.data = { channels: [{ id: 'c1', roster: { agents: [{ id: 'a1', name: 'Architect', participantId: 'p1' }] } }] };
  });

  it('stores the reading on the roster entry, with what the reporter measured', async () => {
    const response = await post({ ...reading, contextTokens: 275151.4, contextWindow: 1000000, source: 'transcript-sampler' });
    expect(response.status).toBe(200);
    expect(agentRecord().roster.agents[0].lastContextHealth).toMatchObject({
      percent: 28, turnCount: 190, model: 'claude-sonnet-5-5', tokens: 275151, window: 1000000, source: 'transcript-sampler',
    });
    expect(saveChannels).toHaveBeenCalledTimes(1);
  });

  it('replaces the whole stored reading, so detail from an earlier reporter never sits beside a newer percentage', async () => {
    await post({ ...reading, contextTokens: 275151, contextWindow: 1000000, source: 'transcript-sampler' });
    await post({ ...reading, contextPercent: 30 });
    const stored = agentRecord().roster.agents[0].lastContextHealth!;
    expect(stored.percent).toBe(30);
    expect(stored).not.toHaveProperty('tokens');
    expect(stored).not.toHaveProperty('window');
  });

  it.each([
    ['negative tokens', { contextTokens: -1 }],
    ['non-numeric tokens', { contextTokens: '5' }],
    ['zero window', { contextWindow: 0 }],
    ['infinite window', { contextWindow: Infinity }],
    ['empty source', { source: '' }],
    ['over-long source', { source: 'x'.repeat(41) }],
  ])('refuses %s', async (_label, extra) => {
    const response = await post({ ...reading, ...extra });
    expect(response.status).toBe(400);
    expect(saveChannels).not.toHaveBeenCalled();
  });

  it('still refuses a percentage outside 0-100 and a missing participant', async () => {
    expect((await post({ ...reading, contextPercent: 101 })).status).toBe(400);
    expect((await post({ ...reading, contextPercent: -1 })).status).toBe(400);
    expect((await post({ channelId: 'c1', contextPercent: 5 })).status).toBe(400);
  });
});

describe('GET /api/agent/context-health', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('says which readings are too old to show', async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    readJsonFile.mockResolvedValue({ channels: [{ id: 'c1', roster: { agents: [
      { id: 'live', name: 'Live', participantId: 'p1', lastContextHealth: { percent: 27, turnCount: 1, model: 'm', reportedAt: minutesAgo(1), tokens: 275151, window: 1000000 } },
      { id: 'old', name: 'Old', participantId: 'p2', lastContextHealth: { percent: 26, turnCount: 468, model: 'deepseek-v4-pro', reportedAt: minutesAgo(132_000) } },
      { id: 'none', name: 'None', participantId: 'p3' },
    ] } }] });
    const body = await (await get('c1')).json();
    const by = (name: string) => body.agents.find((a: { name: string }) => a.name === name);
    expect(by('Live')).toMatchObject({ stale: false, lastContextHealth: { tokens: 275151, window: 1000000 } });
    expect(by('Old').stale).toBe(true);
    expect(by('None')).toMatchObject({ stale: true, lastContextHealth: null });
  });
});
