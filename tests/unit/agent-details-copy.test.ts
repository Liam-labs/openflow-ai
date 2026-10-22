import { describe, expect, it } from 'vitest';
import { buildAgentDetailsText } from '@/lib/agent-details-copy';
import type { AgentRole, AgentRosterEntry } from '@/lib/types';

const role: AgentRole = {
  id: 'role-frontend',
  name: 'Frontend Dev',
  slug: 'frontend-dev',
  mdPath: 'data/roles/frontend-dev.md',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const roster: AgentRosterEntry = {
  id: 'agent-daniel',
  name: 'Daniel',
  workingDirectory: '/home/user/SG-1/Team/Daniel',
  channelId: 'channel-sg1',
  participantId: 'participant-daniel',
  color: '#60a5fa',
  status: 'running',
  pid: 4242,
  tmuxSessionName: 'collab-daniel',
  autoResume: true,
  useCollabWrapper: true,
  dangerouslySkipPermissions: false,
  roleId: role.id,
  model: 'gpt-5.6',
  agentType: 'codex',
  effort: 'high',
  personality: 'Daniel Jackson',
  createdAt: '2026-01-01T00:00:00.000Z',
  crashCount: 0,
};

describe('buildAgentDetailsText', () => {
  it('formats agent details into clear sections', () => {
    const result = buildAgentDetailsText({
      roster,
      participantName: 'Daniel',
      channelName: 'SG-1',
      roles: [role],
    });

    expect(result).toContain('Agent Details\n=============');
    expect(result).toContain('Identity\n--------');
    expect(result).toContain('Runtime\n-------');
    expect(result).toContain('Location\n--------');
    expect(result).toContain('Identifiers\n-----------');
    expect(result).toContain('Name: Daniel');
    expect(result).toContain('Status: Running');
    expect(result).toContain('Role: Frontend Dev');
    expect(result).toContain('Agent type: Codex');
    expect(result).toContain('Session: Persistent process · PID 4242');
    expect(result).toContain('Channel: SG-1  (channel-sg1)');
    expect(result).toContain('Working directory: /home/user/SG-1/Team/Daniel');
    expect(result).toContain('Agent ID: agent-daniel');
    expect(result).toContain('Participant ID: participant-daniel');
  });

  it('describes per-message (Claude) agents without inventing a PID', () => {
    // Per-message mode is Claude-only. A powershell claude agent has no tmux
    // session and no persistent PID — it is spawned per inbound message.
    const result = buildAgentDetailsText({
      roster: { ...roster, agentType: 'claude', tmuxSessionName: undefined, pid: undefined, spawnMode: 'powershell', ptySessionStatus: 'responding' },
      participantName: 'Daniel (Windows)',
      channelName: 'SG-1',
      roles: [role],
    });

    expect(result).toContain('Display name: Daniel (Windows)');
    expect(result).toContain('Session: Per-message · Responding');
    expect(result).not.toContain('PID:');
  });

  it('treats a Codex PowerShell agent as a persistent process, not per-message', () => {
    // Codex + PowerShell is a tmux-supervised Windows-native session (the parity
    // build), so it must render like any persistent agent — never as the
    // Claude-only per-message spawn.
    const result = buildAgentDetailsText({
      roster: { ...roster, spawnMode: 'powershell', ptySessionStatus: 'responding' },
      participantName: 'Daniel',
      channelName: 'SG-1',
      roles: [role],
    });

    expect(result).toContain('Session: Persistent process · PID 4242');
    expect(result).not.toContain('Per-message');
  });
});
