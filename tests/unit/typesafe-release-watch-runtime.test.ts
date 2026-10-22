import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ root: '', resolve: vi.fn(), records: vi.fn(), message: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/data-paths', () => ({ DataPaths: { get appData() { return mocks.root; }, get collabChannels() { return path.join(mocks.root, 'channels.json'); }, get cronLogs() { return mocks.root; } } }));
vi.mock('@/lib/collab-message-io', () => ({ findMessage: mocks.message }));
vi.mock('@/lib/collab-delivery-ledger', () => ({ getDeliveryRecords: mocks.records }));
vi.mock('@/lib/scheduled-agent-reminder', () => ({ resolveScheduledAgentTarget: mocks.resolve, sendScheduledAgentReminder: mocks.send }));
import { reconcileWatchDelivery } from '@/lib/typesafe-release-watch-runtime';
import { digest, messageId, WATCH_CHANNEL, WATCH_RECIPIENTS, type WatchEvent } from '@/lib/typesafe-release-watch';
const id = WATCH_RECIPIENTS[0];
let event: WatchEvent;
beforeEach(async () => {
  vi.clearAllMocks(); mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-reconcile-'));
  await fs.writeFile(path.join(mocks.root, 'channels.json'), '{}');
  event = { id: 'fixture', kind: 'change', message: 'Document change.', observedAt: new Date().toISOString(), changes: [], deliveries: { [id]: { status: 'sending', attempts: 1 } } };
  mocks.resolve.mockReturnValue({ channel: { participants: [{ id, name: 'Builder' }] }, agent: { status: 'running', name: 'Builder', agentType: 'codex' } });
  mocks.records.mockResolvedValue([]); mocks.message.mockResolvedValue(undefined);
});
afterEach(async () => { await fs.rm(mocks.root, { recursive: true, force: true }); });
it('checks the exact ledger tuple and returns queued acceptance, including stopped seats', async () => {
  mocks.resolve.mockReturnValue({ channel: {}, agent: { status: 'stopped' } });
  mocks.records.mockResolvedValue([{ id: 'row', state: 'pending' }]);
  const result = await reconcileWatchDelivery(event, id);
  expect(mocks.records).toHaveBeenCalledWith({ channelId: WATCH_CHANNEL, participantId: id, messageId: messageId(event, id) });
  expect(result).toMatchObject({ kind: 'accepted', receipt: { deliveryState: 'pending', queuedWhileStopped: true } });
});
it('keeps unavailable exact targets and terminal failures explicit', async () => {
  mocks.resolve.mockImplementationOnce(() => { throw new Error('missing'); });
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('failed');
  mocks.records.mockResolvedValue([{ state: 'dead_letter' }]);
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('failed');
});
it('does not redispatch a canonical message lacking a delivery receipt', async () => {
  mocks.message.mockResolvedValue({ id: messageId(event, id) });
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('ambiguous');
});
it('reconciles acknowledged Claude receipts and holds unconfirmed claims', async () => {
  const dir = path.join(mocks.root, 'scheduled-reminder-receipts'); await fs.mkdir(dir);
  const file = path.join(dir, digest(messageId(event, id)) + '.json');
  const requestHash = digest(JSON.stringify([WATCH_CHANNEL, [id], '@Builder ' + event.message, 'typesafe-release-watch']));
  await fs.writeFile(file, JSON.stringify({ requestHash }));
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('ambiguous');
  await fs.writeFile(file, JSON.stringify({ requestHash, result: { messageId: messageId(event, id), channelId: WATCH_CHANNEL, participantId: id, deliveryState: 'queued' } }));
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('accepted');
  await fs.writeFile(file, JSON.stringify({ requestHash: 'different', result: {} }));
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('ambiguous');
});
it('does not retry an old ambiguous attempt after receipt retention may have elapsed', async () => {
  event.deliveries[id].attemptedAt = '2020-01-01T00:00:00Z';
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('ambiguous');
});
it('allows a known fresh attempt with no prior message or claim', async () => {
  expect(await reconcileWatchDelivery(event, id)).toEqual({ kind: 'retryable' });
});
it('allows a Claude retry after a long outage only when no persistent claim or message exists', async () => {
  event.deliveries[id].attemptedAt = '2020-01-01T00:00:00Z';
  mocks.resolve.mockReturnValue({ channel: { participants: [{ id, name: 'Builder' }] }, agent: { status: 'running', name: 'Builder', agentType: 'claude' } });
  expect(await reconcileWatchDelivery(event, id)).toEqual({ kind: 'retryable' });
  mocks.message.mockResolvedValue({ id: messageId(event, id) });
  expect((await reconcileWatchDelivery(event, id)).kind).toBe('ambiguous');
});
