/**
 * Persistent Team Operations
 *
 * Teams are reusable agent templates that persist independently of channels.
 * When a team is "launched", it creates (or reuses) a channel and populates
 * it with agents from the template, carrying over session IDs for --resume.
 *
 * Data stored at: data/teams.json
 */

import { randomUUID } from 'crypto';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { DataPaths } from '@/lib/data-paths';
import { getDevFlowApiToken } from '@/lib/api-auth';
import type {
  Team,
  TeamsData,
  TeamAgentDefinition,
  CollabChannelsData,
  CollabChannel,
  AgentRosterEntry,
} from '@/lib/types';
import { generateAgentColor } from '@/lib/collab-utils';
import { selfOrigin } from '@/lib/self-origin';

const TEAMS_PATH = DataPaths.teams;
const CHANNELS_PATH = DataPaths.collabChannels;

const DEFAULT_TEAMS_DATA: TeamsData = {
  teams: [],
  lastUpdated: new Date().toISOString(),
};

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

// ============================================
// Data I/O
// ============================================

export async function readTeamsData(): Promise<TeamsData> {
  return readJsonFile<TeamsData>(TEAMS_PATH, DEFAULT_TEAMS_DATA);
}

export async function writeTeamsData(data: TeamsData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(TEAMS_PATH, data);
}

async function readChannelsData(): Promise<CollabChannelsData> {
  return readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);
}

// ============================================
// Team CRUD
// ============================================

export async function createTeam(name: string, description?: string, projectId?: string): Promise<Team> {
  const now = new Date().toISOString();
  const team: Team = {
    id: randomUUID(),
    name,
    description,
    projectId,
    agents: [],
    createdAt: now,
    updatedAt: now,
    launchCount: 0,
  };

  await withFileLock(TEAMS_PATH, async () => {
    const data = await readTeamsData();
    data.teams.push(team);
    await writeTeamsData(data);
  });

  return team;
}

export async function getTeam(teamId: string): Promise<Team | null> {
  const data = await readTeamsData();
  return data.teams.find(t => t.id === teamId) || null;
}

export async function listTeams(): Promise<Team[]> {
  const data = await readTeamsData();
  return data.teams;
}

export async function updateTeam(
  teamId: string,
  updates: Partial<Pick<Team, 'name' | 'description' | 'projectId'>>
): Promise<Team | null> {
  let updated: Team | null = null;

  await withFileLock(TEAMS_PATH, async () => {
    const data = await readTeamsData();
    const team = data.teams.find(t => t.id === teamId);
    if (!team) return;

    if (updates.name !== undefined) team.name = updates.name;
    if (updates.description !== undefined) team.description = updates.description;
    if (updates.projectId !== undefined) team.projectId = updates.projectId;
    team.updatedAt = new Date().toISOString();

    await writeTeamsData(data);
    updated = { ...team };
  });

  return updated;
}

export async function deleteTeam(teamId: string): Promise<boolean> {
  let deleted = false;

  await withFileLock(TEAMS_PATH, async () => {
    const data = await readTeamsData();
    const idx = data.teams.findIndex(t => t.id === teamId);
    if (idx === -1) return;

    data.teams.splice(idx, 1);
    await writeTeamsData(data);
    deleted = true;
  });

  return deleted;
}

// ============================================
// Agent Management within Teams
// ============================================

export async function addAgentToTeam(
  teamId: string,
  agent: Omit<TeamAgentDefinition, 'id' | 'createdAt' | 'launchCount'>
): Promise<TeamAgentDefinition | null> {
  let created: TeamAgentDefinition | null = null;

  await withFileLock(TEAMS_PATH, async () => {
    const data = await readTeamsData();
    const team = data.teams.find(t => t.id === teamId);
    if (!team) return;

    const newAgent: TeamAgentDefinition = {
      ...agent,
      id: randomUUID(),
      color: agent.color || generateAgentColor(agent.name),
      launchCount: 0,
      createdAt: new Date().toISOString(),
    };

    team.agents.push(newAgent);
    team.updatedAt = new Date().toISOString();
    await writeTeamsData(data);
    created = { ...newAgent };
  });

  return created;
}

export async function removeAgentFromTeam(teamId: string, agentId: string): Promise<boolean> {
  let removed = false;

  await withFileLock(TEAMS_PATH, async () => {
    const data = await readTeamsData();
    const team = data.teams.find(t => t.id === teamId);
    if (!team) return;

    const idx = team.agents.findIndex(a => a.id === agentId);
    if (idx === -1) return;

    team.agents.splice(idx, 1);
    team.updatedAt = new Date().toISOString();
    await writeTeamsData(data);
    removed = true;
  });

  return removed;
}

export async function updateAgentInTeam(
  teamId: string,
  agentId: string,
  updates: Partial<Pick<TeamAgentDefinition,
    'name' | 'workingDirectory' | 'color' | 'autoResume' | 'useCollabWrapper' |
    'dangerouslySkipPermissions' | 'claudeFlags' | 'lastClaudeSessionId'
  >>
): Promise<TeamAgentDefinition | null> {
  let updated: TeamAgentDefinition | null = null;

  await withFileLock(TEAMS_PATH, async () => {
    const data = await readTeamsData();
    const team = data.teams.find(t => t.id === teamId);
    if (!team) return;

    const agent = team.agents.find(a => a.id === agentId);
    if (!agent) return;

    if (updates.name !== undefined) agent.name = updates.name;
    if (updates.workingDirectory !== undefined) agent.workingDirectory = updates.workingDirectory;
    if (updates.color !== undefined) agent.color = updates.color;
    if (updates.autoResume !== undefined) agent.autoResume = updates.autoResume;
    if (updates.useCollabWrapper !== undefined) agent.useCollabWrapper = updates.useCollabWrapper;
    if (updates.dangerouslySkipPermissions !== undefined) agent.dangerouslySkipPermissions = updates.dangerouslySkipPermissions;
    if (updates.claudeFlags !== undefined) agent.claudeFlags = updates.claudeFlags;
    if (updates.lastClaudeSessionId !== undefined) agent.lastClaudeSessionId = updates.lastClaudeSessionId;

    team.updatedAt = new Date().toISOString();
    await writeTeamsData(data);
    updated = { ...agent };
  });

  return updated;
}

// ============================================
// Team Launch
// ============================================

/**
 * Launch a team: create/reuse a channel, populate roster from template, spawn all agents.
 *
 * Returns the channelId so the caller can switch to it.
 * Agent spawning is delegated to the PTY API (roster_spawn) for each agent.
 */
export async function launchTeam(
  teamId: string,
  options?: { channelId?: string; channelName?: string }
): Promise<{ channelId: string; agentIds: string[] }> {
  const now = new Date().toISOString();

  // Load team
  const teamsData = await readTeamsData();
  const teamRef = teamsData.teams.find(t => t.id === teamId);
  if (!teamRef) throw new Error('Team not found');
  if (teamRef.agents.length === 0) throw new Error('Team has no agents');

  let channelId: string;
  const agentIds: string[] = [];

  if (options?.channelId) {
    // Use existing channel
    channelId = options.channelId;

    // Verify channel exists
    const channelsData = await readChannelsData();
    const channel = channelsData.channels.find(c => c.id === channelId);
    if (!channel) throw new Error('Channel not found');
  } else {
    // Create new channel
    channelId = randomUUID();
    const channelName = options?.channelName || `${teamRef.name} — ${new Date().toLocaleDateString()}`;

    await mutateChannels('team-operations:create-channel', async channelsData => {
      const newChannel: CollabChannel = {
        id: channelId,
        name: channelName,
        teamId: teamRef.id,
        projectId: teamRef.projectId,
        createdAt: now,
        lastActivity: now,
        participants: [],
        messages: [],
        roster: {
          agents: [],
          lastUpdated: now,
        },
        settings: {
          autoRespond: false,
        },
      };
      channelsData.channels.push(newChannel);
      await saveChannels(channelsData);
    });
  }

  // Populate roster from team template
  await mutateChannels('team-operations:populate-roster', async channelsData => {
    const channel = channelsData.channels.find(c => c.id === channelId);
    if (!channel) return;

    // Set teamId and projectId link
    channel.teamId = teamRef.id;
    if (teamRef.projectId) {
      channel.projectId = teamRef.projectId;
    }

    // Ensure roster exists
    if (!channel.roster) {
      channel.roster = { agents: [], lastUpdated: now };
    }

    for (const templateAgent of teamRef.agents) {
      // Check if agent with same name already exists in roster
      const existing = channel.roster.agents.find(a => a.name === templateAgent.name);
      if (existing) {
        // Update existing with template values
        existing.autoResume = templateAgent.autoResume;
        existing.useCollabWrapper = templateAgent.useCollabWrapper;
        existing.dangerouslySkipPermissions = templateAgent.dangerouslySkipPermissions;
        existing.claudeFlags = templateAgent.claudeFlags;
        existing.workingDirectory = templateAgent.workingDirectory;
        existing.color = templateAgent.color;
        // Carry over session ID from template for resume
        if (templateAgent.lastClaudeSessionId) {
          existing.lastClaudeSessionId = templateAgent.lastClaudeSessionId;
        }
        agentIds.push(existing.id);
      } else {
        // Create new roster entry from template
        const rosterAgent: AgentRosterEntry = {
          id: randomUUID(),
          name: templateAgent.name,
          workingDirectory: templateAgent.workingDirectory,
          channelId,
          participantId: randomUUID(),
          color: templateAgent.color || generateAgentColor(templateAgent.name),
          status: 'stopped',
          autoResume: templateAgent.autoResume,
          useCollabWrapper: templateAgent.useCollabWrapper,
          dangerouslySkipPermissions: templateAgent.dangerouslySkipPermissions,
          claudeFlags: templateAgent.claudeFlags,
          lastClaudeSessionId: templateAgent.lastClaudeSessionId,
          createdAt: now,
          crashCount: 0,
        };
        channel.roster.agents.push(rosterAgent);
        agentIds.push(rosterAgent.id);
      }
    }

    channel.roster.lastUpdated = now;
    await saveChannels(channelsData);
  });

  // Spawn all agents via PTY API (with 2s gap)
  for (let i = 0; i < agentIds.length; i++) {
    try {
      await fetch(`${selfOrigin()}/api/collab/pty`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getDevFlowApiToken()}`,
        },
        body: JSON.stringify({
          action: 'roster_spawn',
          channelId,
          agentId: agentIds[i],
        }),
      });
    } catch (err) {
      console.error(`[Teams] Failed to spawn agent ${agentIds[i]}:`, err);
    }

    // 2s gap between spawns
    if (i < agentIds.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Schedule session ID sync back to team after spawns settle
  setTimeout(() => {
    syncSessionIdsToTeam(teamRef.id, channelId).catch(err => {
      console.error('[Teams] Session ID sync failed:', err);
    });
  }, 10000);

  // Update team launch stats
  await withFileLock(TEAMS_PATH, async () => {
    const data = await readTeamsData();
    const t = data.teams.find(t => t.id === teamId);
    if (t) {
      t.launchCount++;
      t.lastLaunchedAt = now;
      t.updatedAt = now;
      // Also update per-agent launch stats
      for (const agent of t.agents) {
        agent.launchCount++;
        agent.lastLaunchedAt = now;
      }
      await writeTeamsData(data);
    }
  });

  return { channelId, agentIds };
}

// ============================================
// Session ID Sync
// ============================================

/**
 * Copy lastClaudeSessionId from channel roster entries back to the team template.
 * Called after agents spawn and their session IDs are captured.
 */
export async function syncSessionIdsToTeam(teamId: string, channelId: string): Promise<void> {
  // Read channel roster
  const channelsData = await readChannelsData();
  const channel = channelsData.channels.find(c => c.id === channelId);
  if (!channel?.roster) return;

  const rosterAgents = channel.roster.agents;

  await withFileLock(TEAMS_PATH, async () => {
    const teamsData = await readTeamsData();
    const team = teamsData.teams.find(t => t.id === teamId);
    if (!team) return;

    let changed = false;
    for (const rosterAgent of rosterAgents) {
      if (!rosterAgent.lastClaudeSessionId) continue;

      // Match by name (since IDs differ between template and roster)
      const templateAgent = team.agents.find(a => a.name === rosterAgent.name);
      if (templateAgent && templateAgent.lastClaudeSessionId !== rosterAgent.lastClaudeSessionId) {
        templateAgent.lastClaudeSessionId = rosterAgent.lastClaudeSessionId;
        changed = true;
      }
    }

    if (changed) {
      team.updatedAt = new Date().toISOString();
      await writeTeamsData(teamsData);
    }
  });
}
