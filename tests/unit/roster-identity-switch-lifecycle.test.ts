import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { CollabChannelsData } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  state: {} as CollabChannelsData,
  kill: vi.fn(), orphan: vi.fn(), update: vi.fn(),
}));
vi.mock('@/app/api/collab/pty/_pty-shared', async importOriginal => ({
  ...await importOriginal<object>(),
  // Match the production JSON cache: successive reads can share an object.
  readChannelsData: async () => mocks.state,
  writeChannelsData: async (data: CollabChannelsData) => { mocks.state = structuredClone(data); },
  findPersonalityFile: async (name: string) => name === 'Jack' ? '/preset/Jack.md' : null,
}));
vi.mock('@/lib/data-io', async importOriginal => ({ ...await importOriginal<object>(), withFileLock: async (_: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/log-writer', () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/collab-pty', async importOriginal => ({
  ...await importOriginal<object>(),
  forceKillByTmuxName: mocks.kill,
  killOrphanedWrapperProcesses: mocks.orphan,
  sweepStaleCollabFiles: vi.fn(async () => {}),
  tmuxSessionExists: vi.fn(async () => false),
}));
vi.mock('@/app/api/collab/pty/_handlers/roster-ops', () => ({ handleRosterUpdate: mocks.update }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.kill.mockResolvedValue(undefined);
  mocks.orphan.mockResolvedValue(0);
  mocks.update.mockImplementation(async body => NextResponse.json({ success: true, agent: { id: body.agentId, name: body.name } }));
  mocks.state = { channels: [{ id: 'channel', name: 'Test', participants: [], messages: [], createdAt: '', lastActivity: '', settings: { autoRespond: false }, roster: { agents: [{ id: 'agent', channelId: 'channel', name: 'Sheppard', personality: 'Sheppard', workingDirectory: '/tmp/project', participantId: 'roster-stable', status: 'running', autoResume: true, tmuxSessionName: 'collab-agent-old', pid: 42, color: '#888', useCollabWrapper: true, dangerouslySkipPermissions: true, createdAt: '', crashCount: 0 }], lastUpdated: '' } }], lastUpdated: '' };
});
const request = { action: 'roster_identity_switch', channelId: 'channel', agentId: 'agent', name: 'Jack', personality: 'Jack' };
describe('identity switch lifecycle', () => {
  it('stops the exact old runtime before saving and returns an explicit fresh-restart requirement', async () => {
    const { handleRosterIdentitySwitchAction } = await import('@/app/api/collab/pty/_handlers/message-inject');
    const response = await handleRosterIdentitySwitchAction(request, 'now');
    expect(await response.json()).toMatchObject({ success: true, identityRestartRequired: true });
    expect(mocks.kill).toHaveBeenCalledWith('collab-agent-old', 42);
    expect(mocks.orphan).toHaveBeenCalledWith('Sheppard', 'channel');
    expect(mocks.kill.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jack', personality: 'Jack', autoResume: true }), 'now');
  });
  it('does not start or stop a stopped agent', async () => {
    mocks.state.channels[0].roster!.agents[0].status = 'stopped';
    const { handleRosterIdentitySwitchAction } = await import('@/app/api/collab/pty/_handlers/message-inject');
    expect(await (await handleRosterIdentitySwitchAction(request, 'now')).json()).toMatchObject({ identityRestartRequired: false });
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it('rejects an unavailable preset before killing anything', async () => {
    const { handleRosterIdentitySwitchAction } = await import('@/app/api/collab/pty/_handlers/message-inject');
    const response = await handleRosterIdentitySwitchAction({ ...request, personality: 'Unknown' }, 'now');
    expect(response.status).toBe(400);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects a duplicate before killing anything', async () => {
    mocks.state.channels[0].roster!.agents.push({ ...mocks.state.channels[0].roster!.agents[0], id: 'other', name: 'Jack' });
    const { handleRosterIdentitySwitchAction } = await import('@/app/api/collab/pty/_handlers/message-inject');
    await expect(handleRosterIdentitySwitchAction(request, 'now')).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it('rejects a shared project workspace in another channel before killing anything', async () => {
    const other = structuredClone(mocks.state.channels[0]);
    other.id = 'other-channel';
    other.roster!.agents[0].name = 'Jack';
    other.roster!.agents[0].id = 'other-agent';
    mocks.state.channels.push(other);
    const { handleRosterIdentitySwitchAction } = await import('@/app/api/collab/pty/_handlers/message-inject');
    await expect(handleRosterIdentitySwitchAction(request, 'now')).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it('reports a preparation failure honestly and leaves the old runtime stopped', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Scaffold validation failed'));
    const { handleRosterIdentitySwitchAction } = await import('@/app/api/collab/pty/_handlers/message-inject');
    const response = await handleRosterIdentitySwitchAction(request, 'now');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, agentStopped: true, error: 'The old agent is stopped. Scaffold validation failed' });
    expect(mocks.state.channels[0].roster!.agents[0].status).toBe('stopped');
  });
});
