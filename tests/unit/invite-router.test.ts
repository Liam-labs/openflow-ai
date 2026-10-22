/**
 * T2.3 TDD — /invite slash command + capability-match router
 *
 * Covers:
 *   1. parseInviteCommand: correct extraction of capability and optional task
 *   2. findAgentByCapability: capability match (case-insensitive, any token)
 *   3. findAgentByCapability: running-first priority over stopped
 *   4. findAgentByCapability: returns null when no match
 *   5. dispatchInvite: writes /tmp/collab-invite-{pid}.json with correct fields
 *   6. dispatchInvite: returns false if agent has no pid
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRosterEntry, AgentRole } from '@/lib/types';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

const { mockWriteFile } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
}));

// ─── Import subject ─────────────────────────────────────────────────────────

const { parseInviteCommand, findAgentByCapability, dispatchInvite } =
  await import('@/lib/invite-router');

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeRosterAgent(overrides: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    id: 'agent-001',
    name: 'Browser',
    workingDirectory: '/home/user/DevFlow/Team/Browser',
    channelId: 'home-channel',
    participantId: 'roster-browser-01',
    color: '#0ea5e9',
    status: 'running',
    pid: 9999,
    useCollabWrapper: true,
    dangerouslySkipPermissions: false,
    autoResume: false,
    crashCount: 0,
    roleId: 'b10c5e8d-9f4a-4b1c-8d6e-3a7f9e2c1d05',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const browserRole: AgentRole = {
  id: 'b10c5e8d-9f4a-4b1c-8d6e-3a7f9e2c1d05',
  name: 'Browser Dev',
  slug: 'browser-dev',
  mdPath: 'data/roles/browser-dev.md',
  capabilities: ['browser', 'chrome', 'edge', 'web', 'browser-automation'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const backendRole: AgentRole = {
  id: '42ebd7dd-fa24-4ede-82a4-323c547cb3e9',
  name: 'Backend Dev',
  slug: 'backend-dev',
  mdPath: 'data/roles/backend-dev.md',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseInviteCommand', () => {
  it('returns null for non-invite messages', () => {
    expect(parseInviteCommand('hello world')).toBeNull();
    expect(parseInviteCommand('/sprint-plan')).toBeNull();
    expect(parseInviteCommand('')).toBeNull();
  });

  it('parses /invite <capability>', () => {
    const result = parseInviteCommand('/invite browser');
    expect(result).toEqual({ capability: 'browser', task: undefined });
  });

  it('parses /invite <capability> with quoted task description', () => {
    const result = parseInviteCommand('/invite chrome "fill out the form on the dashboard"');
    expect(result).toEqual({
      capability: 'chrome',
      task: 'fill out the form on the dashboard',
    });
  });

  it('parses /invite with unquoted remainder as task', () => {
    const result = parseInviteCommand('/invite browser automate the login flow');
    expect(result).toEqual({
      capability: 'browser',
      task: 'automate the login flow',
    });
  });

  it('is case-insensitive on the /invite prefix', () => {
    expect(parseInviteCommand('/INVITE browser')).toEqual({ capability: 'browser', task: undefined });
  });
});

describe('findAgentByCapability', () => {
  const roles: AgentRole[] = [browserRole, backendRole];

  it('finds browser agent by "browser" capability', () => {
    const agents = [makeRosterAgent()];
    const result = findAgentByCapability('browser', agents, roles);
    expect(result?.id).toBe('agent-001');
  });

  it('finds browser agent by "chrome" (synonym) capability', () => {
    const agents = [makeRosterAgent()];
    const result = findAgentByCapability('chrome', agents, roles);
    expect(result?.id).toBe('agent-001');
  });

  it('capability match is case-insensitive', () => {
    const agents = [makeRosterAgent()];
    const result = findAgentByCapability('BROWSER', agents, roles);
    expect(result?.id).toBe('agent-001');
  });

  it('returns null when no agent has matching capability', () => {
    const agents = [makeRosterAgent()];
    const result = findAgentByCapability('nonexistent', agents, roles);
    expect(result).toBeNull();
  });

  it('prefers running agent over stopped', () => {
    const running = makeRosterAgent({ id: 'running', status: 'running', pid: 1111 });
    const stopped = makeRosterAgent({ id: 'stopped', status: 'stopped', pid: undefined });
    const result = findAgentByCapability('browser', [stopped, running], roles);
    expect(result?.id).toBe('running');
  });

  it('returns stopped agent if no running agent is available', () => {
    const stopped = makeRosterAgent({ id: 'stopped-only', status: 'stopped', pid: undefined });
    const result = findAgentByCapability('browser', [stopped], roles);
    expect(result?.id).toBe('stopped-only');
  });

  it('ignores agents whose role has no capabilities', () => {
    const backendAgent = makeRosterAgent({
      id: 'backend',
      roleId: backendRole.id,
      name: 'Worf',
    });
    const result = findAgentByCapability('backend', [backendAgent], roles);
    expect(result).toBeNull();
  });
});

describe('dispatchInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('writes invite file to /tmp/collab-invite-{pid}.json', async () => {
    const agent = makeRosterAgent({ pid: 5555, name: 'Browser' });
    const success = await dispatchInvite(agent, 'channel-abc', 'Dev Channel');
    expect(success).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/collab-invite-5555.json',
      expect.stringContaining('"channelId":"channel-abc"')
    );
  });

  it('invite file contains displayName and invitedAt', async () => {
    const agent = makeRosterAgent({ pid: 6666, name: 'Browser' });
    await dispatchInvite(agent, 'channel-xyz', 'Sprint Channel', 'automate login');

    const [[, content]] = mockWriteFile.mock.calls;
    const data = JSON.parse(content as string);
    expect(data.displayName).toBe('Browser');
    expect(data.invitedAt).toBeTruthy();
    expect(data.task).toBe('automate login');
  });

  it('returns false and does not write file when agent has no pid', async () => {
    const agent = makeRosterAgent({ pid: undefined, status: 'stopped' });
    const success = await dispatchInvite(agent, 'channel-abc', 'Test Channel');
    expect(success).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
