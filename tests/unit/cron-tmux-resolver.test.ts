import { describe, it, expect } from 'vitest';
import { resolveAgentTmuxSessionFromData } from '@/lib/cron-scheduler';
import type { CollabChannelsData } from '@/lib/types';

function makeData(agents: Array<Partial<{ name: string; status: string; tmuxSessionName: string; channelId: string }>>): CollabChannelsData {
  return {
    channels: [
      {
        id: 'ch-1',
        name: 'Channel One',
        createdAt: '2026-01-01T00:00:00Z',
        lastActivity: '2026-01-01T00:00:00Z',
        participants: [],
        messages: [],
        settings: { autoRespond: false },
        roster: {
          lastUpdated: '2026-01-01T00:00:00Z',
          agents: agents.map((a, i) => ({
            id: `agent-${i}`,
            name: a.name || `Agent${i}`,
            workingDirectory: '/tmp',
            channelId: 'ch-1',
            participantId: `roster-${i}`,
            color: '#000000',
            status: (a.status as 'running' | 'stopped' | 'away' | 'error' | 'starting') || 'stopped',
            autoResume: true,
            useCollabWrapper: true,
            dangerouslySkipPermissions: true,
            claudeFlags: [],
            createdAt: '2026-01-01T00:00:00Z',
            crashCount: 0,
            tmuxSessionName: a.tmuxSessionName,
          })),
        },
      },
    ],
    lastUpdated: '2026-01-01T00:00:00Z',
  } as unknown as CollabChannelsData;
}

describe('resolveAgentTmuxSessionFromData', () => {
  it('returns the live tmuxSessionName for a running agent matched by name', () => {
    const data = makeData([
      { name: 'Commander', status: 'running', tmuxSessionName: 'collab-agent-cc6393c6' },
    ]);
    expect(resolveAgentTmuxSessionFromData(data, 'Commander')).toBe('collab-agent-cc6393c6');
  });

  it('returns null when the agent name is not found', () => {
    const data = makeData([
      { name: 'Commander', status: 'running', tmuxSessionName: 'collab-agent-cc6393c6' },
    ]);
    expect(resolveAgentTmuxSessionFromData(data, 'Teyla')).toBeNull();
  });

  it('returns null when the matched agent has no tmuxSessionName', () => {
    const data = makeData([
      { name: 'Commander', status: 'running' },
    ]);
    expect(resolveAgentTmuxSessionFromData(data, 'Commander')).toBeNull();
  });

  it('prefers a running agent over a stopped agent of the same name', () => {
    // Same name appearing in two channels — running entry must win
    const data = {
      channels: [
        {
          id: 'ch-1', name: 'A', createdAt: '', lastActivity: '', participants: [], messages: [], settings: { autoRespond: false },
          roster: {
            lastUpdated: '', agents: [{
              id: 'a1', name: 'Commander', workingDirectory: '/tmp', channelId: 'ch-1',
              participantId: 'roster-a1', color: '#000', status: 'stopped',
              autoResume: true, useCollabWrapper: true, dangerouslySkipPermissions: true,
              claudeFlags: [], createdAt: '', crashCount: 0, tmuxSessionName: 'stale-session',
            }],
          },
        },
        {
          id: 'ch-2', name: 'B', createdAt: '', lastActivity: '', participants: [], messages: [], settings: { autoRespond: false },
          roster: {
            lastUpdated: '', agents: [{
              id: 'a2', name: 'Commander', workingDirectory: '/tmp', channelId: 'ch-2',
              participantId: 'roster-a2', color: '#000', status: 'running',
              autoResume: true, useCollabWrapper: true, dangerouslySkipPermissions: true,
              claudeFlags: [], createdAt: '', crashCount: 0, tmuxSessionName: 'live-session',
            }],
          },
        },
      ],
      lastUpdated: '',
    } as unknown as CollabChannelsData;
    expect(resolveAgentTmuxSessionFromData(data, 'Commander')).toBe('live-session');
  });

  it('falls back to a stopped agents tmuxSessionName when nothing is running', () => {
    const data = makeData([
      { name: 'Commander', status: 'stopped', tmuxSessionName: 'collab-agent-last-known' },
    ]);
    expect(resolveAgentTmuxSessionFromData(data, 'Commander')).toBe('collab-agent-last-known');
  });

  it('returns null for empty input', () => {
    expect(resolveAgentTmuxSessionFromData({ channels: [], lastUpdated: '' } as unknown as CollabChannelsData, 'Commander')).toBeNull();
  });

  it('returns null for empty or whitespace agentName', () => {
    const data = makeData([
      { name: 'Commander', status: 'running', tmuxSessionName: 'collab-agent-cc6393c6' },
    ]);
    expect(resolveAgentTmuxSessionFromData(data, '')).toBeNull();
    expect(resolveAgentTmuxSessionFromData(data, '   ')).toBeNull();
  });

  it('matches exact name (case-sensitive)', () => {
    const data = makeData([
      { name: 'Commander', status: 'running', tmuxSessionName: 'collab-agent-cc6393c6' },
    ]);
    expect(resolveAgentTmuxSessionFromData(data, 'commander')).toBeNull();
    expect(resolveAgentTmuxSessionFromData(data, 'Commander')).toBe('collab-agent-cc6393c6');
  });
});
