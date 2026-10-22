import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stateDir: `/tmp/outlook-webhook-dispatcher-test-${process.pid}`,
  listEmails: vi.fn(),
  appendEntry: vi.fn(),
  listEntries: vi.fn(),
  readEmail: vi.fn(),
  emit: vi.fn(),
  readWatchStore: vi.fn(),
}));

vi.mock('@/lib/outlook-client', () => ({ readEmail: mocks.readEmail, getFolder: vi.fn(), listEmails: mocks.listEmails }));
vi.mock('@/lib/outlook-events', () => ({
  buildEvent: (e: Record<string, unknown>) => e,
  emit: mocks.emit,
}));
vi.mock('@/lib/outlook-watches-store', () => ({ readWatchStore: mocks.readWatchStore }));
vi.mock('../../services/outlook-watcher/src/identity.js', () => ({
  sendAsService: async (_channelId: string, send: (id: string) => Promise<unknown>) => send('p1'),
}));
vi.mock('../../services/outlook-graph-webhook/src/config.js', () => ({
  config: { defaultUserId: 'owner', devflowApiBase: 'http://x', devflowApiToken: 't', stateDir: mocks.stateDir },
}));
vi.mock('../../services/outlook-graph-webhook/src/watch-routing.js', () => ({
  matchingWatches: ({ watches }: { watches: unknown[] }) => watches,
}));
vi.mock('../../services/outlook-graph-webhook/src/spool.js', () => ({
  ackEntry: vi.fn(), bumpAttempt: vi.fn(), listEntries: mocks.listEntries, appendEntry: mocks.appendEntry,
}));

import { rmSync } from 'fs';
import { dispatchOne, resyncAfterMissed } from '../../services/outlook-graph-webhook/src/dispatcher';

const entry = {
  id: 'e1',
  payload: { emailId: 'm1', userId: 'owner', receivedAt: '2026-10-02T08:56:00Z', source: 'graph', watchId: 's1', tenantId: 't' },
} as never;

describe('outlook webhook dispatchOne', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listEntries.mockResolvedValue([]);
    mocks.readWatchStore.mockResolvedValue({ watches: [{ id: 'w1', channelId: 'c1' }] });
    mocks.emit.mockResolvedValue({ ok: true });
  });

  it('retries (ok:false) when reading the email fails, e.g. on the MCP rate limit', async () => {
    mocks.readEmail.mockRejectedValue(new Error('Rate limit exceeded. Try again in 40 seconds.'));
    const result = await dispatchOne(entry);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('read-failed: Rate limit exceeded');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('acknowledges a deleted item (sent-mail temp copy) without retrying', async () => {
    mocks.readEmail.mockRejectedValue(new Error('The specified object was not found in the store., ErrorItemNotFound'));
    const result = await dispatchOne(entry);
    expect(result.ok).toBe(true);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('retries when read_email returns no email', async () => {
    mocks.readEmail.mockResolvedValue('Rate limit exceeded');
    expect((await dispatchOne(entry)).ok).toBe(false);
  });

  it('emits for a readable matching email', async () => {
    mocks.readEmail.mockResolvedValue({ email: { id: 'm1', subject: 'Hi', from: { emailAddress: { address: 'a@b.c' } } } });
    expect((await dispatchOne(entry)).ok).toBe(true);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it('never alerts the same watch twice for one email', async () => {
    rmSync(mocks.stateDir, { recursive: true, force: true });
    const dupEntry = { ...entry, payload: { ...(entry as { payload: object }).payload, emailId: 'dup-1' } } as never;
    mocks.readEmail.mockResolvedValue({ email: { id: 'dup-1', subject: 'Hi', from: { emailAddress: { address: 'a@b.c' } } } });
    expect((await dispatchOne(dupEntry)).ok).toBe(true);
    expect((await dispatchOne(dupEntry)).ok).toBe(true);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it('resyncs only recent inbox mail after Graph reports missed notifications', async () => {
    const now = Date.now();
    mocks.listEmails.mockResolvedValue({ status: 'success', emails: [
      { id: 'recent', receivedDateTime: new Date(now - 60_000).toISOString() },
      { id: 'old', receivedDateTime: new Date(now - 7 * 60 * 60 * 1000).toISOString() },
      { id: 'dup-1', receivedDateTime: new Date(now - 30_000).toISOString() },
    ] });
    expect(await resyncAfterMissed({ id: 'sub-1', userId: 'owner' })).toBe(1);
    expect(mocks.appendEntry).toHaveBeenCalledTimes(1);
    expect(mocks.appendEntry.mock.calls[0][0].payload).toMatchObject({ emailId: 'recent', watchId: 'sub-1', userId: 'owner' });
  });

  it('fails the resync loudly when the inbox cannot be listed', async () => {
    mocks.listEmails.mockResolvedValue({ status: 'error', message: 'Rate limit exceeded' });
    await expect(resyncAfterMissed({ id: 'sub-1', userId: 'owner' })).rejects.toThrow(/Rate limit/);
  });
});
