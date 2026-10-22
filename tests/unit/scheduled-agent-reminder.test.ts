import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  root: '',
  hostCall: vi.fn(),
  hostIds: vi.fn(),
  getHostInfo: vi.fn(),
  emit: vi.fn(),
  deliver: vi.fn(),
  prepare: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/lib/data-paths', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/data-paths')>();
  return {
    ...actual,
    DataPaths: {
      ...actual.DataPaths,
      get collabChannels() { return path.join(mocks.root, 'channels.json'); },
      get collabMessages() { return mocks.root || os.tmpdir(); },
      get cronJobs() { return path.join(mocks.root, 'jobs.json'); },
      get cronLogs() { return mocks.root; },
    },
    collabMessageFile: (id: string) => path.join(mocks.root, `${id}.json`),
    cronLogFile: (id: string) => path.join(mocks.root, `${id}-log.json`),
  };
});
vi.mock('@/lib/event-bus', () => ({ eventBus: { emitEvent: mocks.emit }, emitCollabError: vi.fn() }));
vi.mock('@/lib/log-writer', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/collab-delivery', () => ({ deliverMessage: mocks.deliver }));
vi.mock('@/lib/collab-delivery-ledger', () => ({
  prepareDurableDelivery: mocks.prepare, enqueueDurableDeliveries: mocks.enqueue,
}));
vi.mock('@/lib/host-executor', () => ({ hostCall: mocks.hostCall }));
vi.mock('@/lib/host-registry', () => ({ hostIds: mocks.hostIds, getHostInfo: mocks.getHostInfo }));

import { resolveScheduledAgentTarget, sendScheduledAgentReminder } from '@/lib/scheduled-agent-reminder';
import { jsonCache } from '@/lib/data-io';
import { cronScheduler } from '@/lib/cron-scheduler';
import type { CollabChannelsData } from '@/lib/types';

const input = {
  channelId: 'ledgeros', participantId: 'roster-architect-ledger', text: 'Test reminder',
  jobId: 'job', executionId: 'execution',
};
const workspace = '/home/user/ledgeros/Team/Architect';
function dataFor(options: {
  channelId?: string; participantId?: string; agentType?: 'codex' | 'claude' | 'gemini';
  deliveryProtocol?: 'ledger-v1'; status?: 'running' | 'stopped';
} = {}): CollabChannelsData {
  const channelId = options.channelId || input.channelId;
  const participantId = options.participantId || input.participantId;
  return {
    channels: [{
      id: channelId, name: 'LedgerOS', createdAt: '', lastActivity: '', messages: [],
      settings: { autoRespond: false },
      participants: [{
        id: participantId, name: 'Architect', type: 'claude-terminal', status: 'online',
        joinedAt: '', lastSeen: new Date().toISOString(), projectPath: workspace,
        host: { hostId: 'self-reported-name', tmuxSession: 'collab-agent-ledger', cwd: workspace },
      }],
      roster: { lastUpdated: '', agents: [{
        id: 'agent-architect', participantId, channelId, name: 'Architect',
        agentType: options.agentType ?? 'codex', deliveryProtocol: options.deliveryProtocol,
        status: options.status ?? 'running', workingDirectory: '/home/user/ledgeros',
        effectiveWorkingDirectory: workspace, tmuxSessionName: 'collab-agent-ledger',
        color: '#fff', autoResume: false, useCollabWrapper: true,
        dangerouslySkipPermissions: false, createdAt: '', crashCount: 0,
      }] },
    }], lastUpdated: '',
  } as unknown as CollabChannelsData;
}
async function save(data = dataFor({ agentType: 'claude' })) {
  await fs.writeFile(path.join(mocks.root, 'channels.json'), JSON.stringify(data));
  jsonCache.clear();
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-reminder-'));
  mocks.hostIds.mockReturnValue(['desktop']);
  mocks.getHostInfo.mockReturnValue({ fresh: true, sessions: ['collab-agent-ledger'] });
  mocks.hostCall.mockReset().mockResolvedValue({ appended: true, committed_ms: Date.now() });
  mocks.prepare.mockImplementation((_sender, message) => {
    message.metadata.durableDelivery = 'ledger-v1';
    return [input.participantId];
  });
  mocks.enqueue.mockResolvedValue([{ id: 'durable-record', participantId: input.participantId, state: 'pending' }]);
  await save();
});
afterEach(async () => { jsonCache.clear(); await fs.rm(mocks.root, { recursive: true, force: true }); });

describe('exact scheduled reminder target', () => {
  it('resolves a stopped ledger-v1 Codex owner', () => {
    const target = resolveScheduledAgentTarget(dataFor({ deliveryProtocol: 'ledger-v1', status: 'stopped' }), input.channelId, input.participantId);
    expect(target.agent.status).toBe('stopped');
  });
  it('accepts a Claude wrapper even with a stale Codex protocol field', () => {
    expect(resolveScheduledAgentTarget(dataFor({ agentType: 'claude', deliveryProtocol: 'ledger-v1' }), input.channelId, input.participantId).agent.agentType).toBe('claude');
  });
  it('does not cross channels for another Architect', () => {
    expect(() => resolveScheduledAgentTarget(dataFor({ channelId: 'other', deliveryProtocol: 'ledger-v1' }), input.channelId, input.participantId)).toThrow('channel not found');
  });
  it('rejects the wrong participant on the correct channel', () => {
    expect(() => resolveScheduledAgentTarget(dataFor({ deliveryProtocol: 'ledger-v1' }), input.channelId, 'roster-other-architect')).toThrow('is not in channel');
  });
  it.each(['codex', 'gemini'] as const)('rejects unsupported %s delivery', agentType => {
    expect(() => resolveScheduledAgentTarget(dataFor({ agentType }), input.channelId, input.participantId)).toThrow('does not support');
  });
});

describe('scheduled Claude delivery', () => {
  it('awaits the exact host inbox and reports queued, without a Codex record', async () => {
    await save(dataFor({ agentType: 'claude', deliveryProtocol: 'ledger-v1' }));
    const result = await sendScheduledAgentReminder(input);
    expect(result).toMatchObject({
      messageId: 'scheduled-reminder-execution', channelId: input.channelId,
      participantId: input.participantId, deliveryState: 'queued', deliveryTransport: 'host-inbox',
      deliveryHost: 'desktop', queuedWhileStopped: false,
    });
    expect(result.deliveryRecordId).toBeUndefined();
    expect(mocks.hostCall).toHaveBeenCalledWith('desktop', 'inbox-append', expect.objectContaining({
      dir: workspace, participantId: input.participantId,
      entry: expect.objectContaining({ id: result.messageId, channelId: input.channelId, recipients: [input.participantId], mentions: [input.participantId] }),
    }), 20_000);
    expect(mocks.hostCall.mock.calls[0][2].entry.metadata.durableDelivery).toBeUndefined();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });
  it('accepts an existing host inbox entry as a confirmed handoff', async () => {
    mocks.hostCall.mockResolvedValue({ appended: false, duplicate: true });
    expect((await sendScheduledAgentReminder(input)).deliveryState).toBe('queued');
  });
  it('deduplicates concurrent and later calls even after channel history rotates', async () => {
    const results = await Promise.all([sendScheduledAgentReminder(input), sendScheduledAgentReminder(input)]);
    expect(results[0]).toEqual(results[1]);
    await fs.writeFile(path.join(mocks.root, 'ledgeros.json'), JSON.stringify({ channelId: 'ledgeros', messages: [], lastUpdated: '' }));
    jsonCache.clear();
    expect(await sendScheduledAgentReminder(input)).toEqual(results[0]);
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });
  it('rejects execution-ID reuse with changed content', async () => {
    await sendScheduledAgentReminder(input);
    await expect(sendScheduledAgentReminder({ ...input, text: 'Different reminder' })).rejects.toThrow('reused');
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
  });
  it('does not emit or report success before the host acknowledges', async () => {
    let acknowledge!: (value: { appended: boolean }) => void;
    mocks.hostCall.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    const sending = sendScheduledAgentReminder(input);
    await vi.waitFor(() => expect(mocks.hostCall).toHaveBeenCalledTimes(1));
    expect(mocks.emit).not.toHaveBeenCalled();
    acknowledge({ appended: true });
    expect((await sending).deliveryState).toBe('queued');
  });
  it('fails before dispatch if execution receipts cannot be persisted', async () => {
    await fs.writeFile(path.join(mocks.root, 'scheduled-reminder-receipts'), 'blocked');
    await expect(sendScheduledAgentReminder(input)).rejects.toThrow();
    expect(mocks.hostCall).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('preserves a corrupt execution receipt and refuses re-injection', async () => {
    await sendScheduledAgentReminder(input);
    const directory = path.join(mocks.root, 'scheduled-reminder-receipts');
    const receipt = path.join(directory, (await fs.readdir(directory))[0]);
    await fs.writeFile(receipt, '{invalid');
    await expect(sendScheduledAgentReminder(input)).rejects.toThrow();
    expect(await fs.readFile(receipt, 'utf8')).toBe('{invalid');
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
  });
  it.each(['stopped', 'missing participant', 'stale heartbeat', 'away', 'wrong runtime', 'wrong cwd', 'wrong session', 'wrong workspace', 'no wrapper'])('explicitly fails an unavailable Claude seat: %s', async reason => {
    const data = dataFor({ agentType: 'claude' });
    const channel = data.channels[0];
    const participant = channel.participants[0];
    const agent = channel.roster!.agents[0];
    if (reason === 'stopped') agent.status = 'stopped';
    if (reason === 'missing participant') channel.participants = [];
    if (reason === 'stale heartbeat') participant.lastSeen = '2000-01-01T00:00:00Z';
    if (reason === 'away') participant.status = 'away';
    if (reason === 'wrong runtime') participant.type = 'codex';
    if (reason === 'wrong cwd') participant.host!.cwd = '/home/user/other';
    if (reason === 'wrong session') participant.host!.tmuxSession = 'collab-agent-other';
    if (reason === 'wrong workspace') participant.projectPath = '/home/user/other';
    if (reason === 'no wrapper') agent.useCollabWrapper = false;
    await save(data);
    await expect(sendScheduledAgentReminder(input)).rejects.toThrow();
    expect(mocks.hostCall).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it.each(['absent', 'stale', 'ambiguous', 'wrong session'])('never guesses a host or uses the server inbox when ownership is %s', async reason => {
    if (reason === 'absent') mocks.hostIds.mockReturnValue([]);
    if (reason === 'stale') mocks.getHostInfo.mockReturnValue({ fresh: false, sessions: ['collab-agent-ledger'] });
    if (reason === 'ambiguous') mocks.hostIds.mockReturnValue(['desktop', 'other']);
    if (reason === 'wrong session') mocks.getHostInfo.mockReturnValue({ fresh: true, sessions: ['collab-agent-other'] });
    await expect(sendScheduledAgentReminder(input)).rejects.toThrow('host');
    expect(mocks.hostCall).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it.each([new Error('host timeout'), new Error('inbox permission denied'), null, { appended: false }, { appended: 'true' }])('propagates an unconfirmed host handoff and does not retry it (%s)', async failure => {
    if (failure instanceof Error) mocks.hostCall.mockRejectedValue(failure);
    else mocks.hostCall.mockResolvedValue(failure);
    await expect(sendScheduledAgentReminder(input)).rejects.toThrow();
    await expect(sendScheduledAgentReminder(input)).rejects.toThrow('unconfirmed');
    expect(mocks.hostCall).toHaveBeenCalledTimes(1);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe('Codex delivery is preserved', () => {
  it.each(['running', 'stopped'] as const)('keeps ledger delivery for a %s seat', async status => {
    const data = dataFor({ deliveryProtocol: 'ledger-v1', status });
    if (status === 'stopped') data.channels[0].participants = [];
    await save(data);
    const result = await sendScheduledAgentReminder(input);
    expect(result).toMatchObject({ deliveryRecordId: 'durable-record', deliveryState: 'pending', queuedWhileStopped: status === 'stopped' });
    await sendScheduledAgentReminder(input);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.hostCall).not.toHaveBeenCalled();
  });
});

describe('original scheduler path', () => {
  it.each([true, false])('records the actual Claude delivery outcome (host accepted: %s)', async accepted => {
    await fs.writeFile(path.join(mocks.root, 'jobs.json'), JSON.stringify({ jobs: [{
      id: input.jobId, name: 'test', jobType: 'agent-reminder', enabled: false,
      schedule: '0 9 * * 1', reminderChannelId: input.channelId,
      reminderParticipantId: input.participantId, reminderText: input.text,
    }], lastUpdated: '' }));
    if (!accepted) mocks.hostCall.mockRejectedValue(new Error('inbox permission denied'));
    const execution = await cronScheduler.executeJob(input.jobId, 'manual');
    expect(execution.status).toBe(accepted ? 'success' : 'failed');
    if (accepted) expect(JSON.parse(execution.output!)).toMatchObject({ deliveryState: 'queued', messageId: `scheduled-reminder-${execution.id}` });
    else expect(execution.error).toContain('inbox permission denied');
    const history = JSON.parse(await fs.readFile(path.join(mocks.root, 'job-log.json'), 'utf8'));
    expect(history.executions).toHaveLength(1);
    expect(history.executions[0].status).toBe(execution.status);
  });
});
