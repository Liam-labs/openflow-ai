import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabChannel, CollabChannelsData, Config } from '@/lib/types';
import { homedir } from 'node:os';
const HOME = homedir();

const hostCall = vi.fn();
let config: Config;
let archives: { archives: Array<{ channel: CollabChannel }> };

vi.mock('@/lib/host-executor', () => ({ defaultHost: () => 'desktop-1-wsl', hostCall: (...a: unknown[]) => hostCall(...a) }));
vi.mock('@/lib/config', () => ({ loadConfig: async () => config, saveConfig: vi.fn(async (c: Config) => { config = c; }) }));
vi.mock('@/lib/data-io', () => ({ readJsonFile: async () => archives }));

const { getChannelWorkspaceStatus, deleteChannelWorkspace } = await import('@/lib/channel-workspace');

function channel(id: string, projectPath?: string, extra: Partial<CollabChannel> = {}): CollabChannel {
  return { id, name: id, projectPath, projectId: id, createdAt: '', lastActivity: '', participants: [], messages: [], settings: { autoRespond: false }, ...extra } as CollabChannel;
}
const live = (...channels: CollabChannel[]): CollabChannelsData => ({ channels } as CollabChannelsData);

beforeEach(() => {
  hostCall.mockReset();
  config = { projects: [], settings: { refreshInterval: 2000, defaultCategory: 'all' } } as Config;
  archives = { archives: [] };
});

describe('channel workspace', () => {
  it('offers delete for a channel-owned folder in home and reports host details', async () => {
    hostCall.mockResolvedValue({ exists: true, bytes: 2048, files: 3, gitIssues: [] });
    const status = await getChannelWorkspaceStatus('spanish', live(channel('spanish', `${HOME}/Spanish-Learning`)));
    expect(status).toMatchObject({ eligible: true, path: `${HOME}/Spanish-Learning`, exists: true, files: 3 });
    expect(hostCall).toHaveBeenCalledWith('desktop-1-wsl', 'project-info', { path: `${HOME}/Spanish-Learning` }, 120_000);
  });

  it('keeps a folder another live channel uses, a nested folder, and a registered app folder', async () => {
    const shared = await getChannelWorkspaceStatus('a', live(channel('a', `${HOME}/Shared`), channel('b', `${HOME}/Shared`)));
    expect(shared).toMatchObject({ eligible: false, reason: 'Also used by the "b" channel.' });

    const nested = await getChannelWorkspaceStatus('cv', live(channel('cv', `${HOME}/Games/Costa-Vida`)));
    expect(nested.eligible).toBe(false);

    config.projects.push({ id: 'portal', name: 'Portal', path: `${HOME}/Portal` } as Config['projects'][number]);
    const app = await getChannelWorkspaceStatus('p', live(channel('p', `${HOME}/Portal`)));
    expect(app).toMatchObject({ eligible: false, reason: 'Registered DevFlow project "Portal" lives there.' });
    expect(hostCall).not.toHaveBeenCalled();
  });

  it('a roster agent working inside the folder from another channel also keeps it', async () => {
    const other = channel('other', `${HOME}/SG-1`, { roster: { agents: [{ name: 'Dave', workingDirectory: `${HOME}/Spanish-Learning` }] } as CollabChannel['roster'] });
    const status = await getChannelWorkspaceStatus('spanish', live(channel('spanish', `${HOME}/Spanish-Learning`), other));
    expect(status.eligible).toBe(false);
  });

  it('deletes an archived channel folder on the host and drops its own project registration', async () => {
    archives.archives.push({ channel: channel('spanish-learning', `${HOME}/Spanish-Learning`) });
    config.projects.push({ id: 'spanish-learning', name: 'Spanish Learning', path: `${HOME}/Spanish-Learning`, healthChecks: [] } as unknown as Config['projects'][number]);
    hostCall.mockResolvedValue({ removed: true });

    const result = await deleteChannelWorkspace('spanish-learning', live());
    expect(result).toEqual({ removed: true, path: `${HOME}/Spanish-Learning` });
    expect(hostCall).toHaveBeenCalledWith('desktop-1-wsl', 'project-remove', { path: `${HOME}/Spanish-Learning` }, 300_000);
    expect(config.projects).toHaveLength(0);
  });

  it('tells the host to discard unsaved git work only when asked, and reports what was discarded', async () => {
    archives.archives.push({ channel: channel('showcase', `${HOME}/Acmework-Showcase`) });
    hostCall.mockResolvedValue({ removed: true, discarded: ['.: uncommitted changes'] });

    const result = await deleteChannelWorkspace('showcase', live(), { discardUnsavedGit: true });
    expect(hostCall).toHaveBeenCalledWith('desktop-1-wsl', 'project-remove', { path: `${HOME}/Acmework-Showcase`, discardUnsavedGit: true }, 300_000);
    expect(result).toEqual({ removed: true, path: `${HOME}/Acmework-Showcase`, discarded: ['.: uncommitted changes'] });
  });

  it('never sends the override unless it was asked for', async () => {
    archives.archives.push({ channel: channel('showcase', `${HOME}/Acmework-Showcase`) });
    hostCall.mockResolvedValue({ removed: true });
    await deleteChannelWorkspace('showcase', live(), { discardUnsavedGit: false });
    await deleteChannelWorkspace('showcase', live(), {});
    for (const call of hostCall.mock.calls) expect(call[2]).toEqual({ path: `${HOME}/Acmework-Showcase` });
  });

  it('still refuses an ineligible folder even when the override is asked for', async () => {
    await expect(deleteChannelWorkspace('a', live(channel('a', `${HOME}/SG-1`)), { discardUnsavedGit: true })).rejects.toThrow(/never deleted/);
    expect(hostCall).not.toHaveBeenCalled();
  });

  it('refuses to delete an ineligible folder without touching the host', async () => {
    await expect(deleteChannelWorkspace('a', live(channel('a', `${HOME}/SG-1`)))).rejects.toThrow(/never deleted/);
    expect(hostCall).not.toHaveBeenCalled();
  });
});
