/**
 * Slack Integration - Rich Message Posting
 *
 * High-level functions that fetch DevFlow data, build Block Kit cards,
 * and post them to Slack channels.
 */

import { getBotToken } from './slack-auth';
import { getConfig, getMappingByDevFlowChannel } from './slack-bridge-data';
import {
  buildSprintProgressCard,
  buildHealthDashboardCard,
  buildAgentRosterCard,
  type SlackBlock,
  type SprintProgressData,
  type HealthDashboardData,
  type AgentRosterData,
} from './slack-block-kit';
import { PRODUCT_NAME } from '@/lib/brand';

// --- Base URL Helper ---

/**
 * Get the DevFlow base URL for links in Block Kit cards.
 * Reads from bridge config, defaults to localhost.
 */
export async function getDevFlowBaseUrl(): Promise<string> {
  const config = await getConfig();
  return config?.devflowPublicUrl || 'http://localhost:3000';
}

// --- Block Kit Message Posting ---

/**
 * Post a Block Kit message to a Slack channel.
 * @param slackChannelId - Slack channel ID (C0123456789)
 * @param blocks - Array of Block Kit blocks
 * @param fallbackText - Plain text fallback for notifications/unfurling
 * @param options - Optional username/icon overrides
 */
export async function postBlockKitMessage(
  slackChannelId: string,
  blocks: SlackBlock[],
  fallbackText: string,
  options?: { username?: string; iconEmoji?: string }
): Promise<string> {
  const token = getBotToken();

  const body: Record<string, unknown> = {
    channel: slackChannelId,
    blocks,
    text: fallbackText, // Fallback for notifications
  };

  if (options?.username) body.username = options.username;
  if (options?.iconEmoji) body.icon_emoji = options.iconEmoji;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as { ok: boolean; error?: string; ts?: string };
  if (!data.ok) {
    throw new Error(`Slack API error posting Block Kit message: ${data.error}`);
  }

  return data.ts || '';
}

// --- Sprint Progress ---

/**
 * Post a sprint progress card to the Slack channel mapped to a DevFlow channel.
 * @param devflowChannelId - DevFlow collab channel ID
 * @param sprintId - Sprint ID (optional — uses active sprint if omitted)
 */
export async function postSprintProgressToSlack(
  devflowChannelId: string,
  sprintId?: string
): Promise<{ posted: boolean; slackTs?: string; error?: string }> {
  // Find the Slack channel mapping
  const mapping = await getMappingByDevFlowChannel(devflowChannelId);
  if (!mapping) {
    return { posted: false, error: `No Slack mapping found for this ${PRODUCT_NAME} channel` };
  }

  // Load sprint data
  const { readJsonFile } = await import('@/lib/data-io');
  const { DataPaths } = await import('@/lib/data-paths');
  const tasksData = await readJsonFile<{
    tasks: Array<{ id: string; status: string; sprintId?: string; phaseId?: string }>;
    sprints: Array<{ id: string; channelId: string; name: string; status: string }>;
    phases: Array<{ id: string; sprintId: string; name: string }>;
  }>(DataPaths.collabTasks, { tasks: [], sprints: [], phases: [] });

  // Find the sprint
  let sprint;
  if (sprintId) {
    sprint = tasksData.sprints.find(s => s.id === sprintId);
  } else {
    // Use active sprint for this channel
    sprint = tasksData.sprints.find(s => s.channelId === devflowChannelId && s.status === 'active');
  }

  if (!sprint) {
    return { posted: false, error: sprintId ? `Sprint not found: ${sprintId}` : 'No active sprint found' };
  }

  // Calculate progress
  const sprintPhases = tasksData.phases.filter(p => p.sprintId === sprint.id);
  const sprintTasks = tasksData.tasks.filter(t => t.sprintId === sprint.id);
  const completed = sprintTasks.filter(t => t.status === 'done').length;
  const inProgress = sprintTasks.filter(t => t.status === 'in_progress').length;
  const todo = sprintTasks.filter(t => t.status === 'todo').length;
  const total = sprintTasks.length;

  const phaseProgress = sprintPhases.map(phase => {
    const phaseTasks = tasksData.tasks.filter(t => t.phaseId === phase.id);
    const phaseCompleted = phaseTasks.filter(t => t.status === 'done').length;
    return {
      phaseName: phase.name,
      completed: phaseCompleted,
      total: phaseTasks.length,
      percent: phaseTasks.length > 0 ? Math.round((phaseCompleted / phaseTasks.length) * 100) : 0,
    };
  });

  const progressData: SprintProgressData = {
    sprintName: sprint.name,
    sprintStatus: sprint.status,
    totalTasks: total,
    completedTasks: completed,
    inProgressTasks: inProgress,
    todoTasks: todo,
    percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
    phaseProgress,
    channelName: mapping.devflowChannelName,
  };

  const devflowUrl = await getDevFlowBaseUrl();
  const blocks = buildSprintProgressCard(progressData, devflowUrl);
  const fallback = `Sprint: ${sprint.name} — ${progressData.percentComplete}% complete (${completed}/${total} tasks)`;

  const slackTs = await postBlockKitMessage(
    mapping.slackChannelId,
    blocks,
    fallback,
    { username: PRODUCT_NAME, iconEmoji: ':bar_chart:' }
  );

  return { posted: true, slackTs };
}

// --- Health Dashboard ---

/**
 * Post a health dashboard card to a Slack channel.
 * @param slackChannelId - Slack channel ID (optional — uses first mapping's channel)
 */
export async function postHealthDashboardToSlack(
  slackChannelId?: string
): Promise<{ posted: boolean; slackTs?: string; error?: string }> {
  // Resolve target channel
  let targetChannelId = slackChannelId;
  if (!targetChannelId) {
    const { getMappings } = await import('./slack-bridge-data');
    const mappings = await getMappings({ syncEnabled: true });
    if (mappings.length === 0) {
      return { posted: false, error: 'No active Slack channel mappings found' };
    }
    targetChannelId = mappings[0].slackChannelId;
  }

  // Run health checks
  const { getProjects } = await import('@/lib/config');
  const { runProjectHealthChecks } = await import('@/lib/health-checks');

  const projects = await getProjects();
  const healthResults = await Promise.all(
    projects.map(async (project) => {
      const result = await runProjectHealthChecks(project);
      return {
        projectName: project.name,
        overallStatus: result.overallStatus,
        checks: result.checks.map(c => ({
          label: c.label,
          status: c.status,
          message: c.message,
          responseTime: c.responseTime,
        })),
      };
    })
  );

  const healthData: HealthDashboardData = { projects: healthResults };
  const devflowUrl = await getDevFlowBaseUrl();
  const blocks = buildHealthDashboardCard(healthData, devflowUrl);

  const onlineCount = healthResults.filter(p => p.overallStatus === 'online').length;
  const fallback = `Health Dashboard: ${onlineCount}/${healthResults.length} projects online`;

  const slackTs = await postBlockKitMessage(
    targetChannelId,
    blocks,
    fallback,
    { username: `${PRODUCT_NAME} Health`, iconEmoji: ':hospital:' }
  );

  return { posted: true, slackTs };
}

// --- Agent Roster ---

/**
 * Post an agent roster card to the Slack channel mapped to a DevFlow channel.
 * @param devflowChannelId - DevFlow collab channel ID
 */
export async function postAgentRosterToSlack(
  devflowChannelId: string
): Promise<{ posted: boolean; slackTs?: string; error?: string }> {
  // Find the Slack channel mapping
  const mapping = await getMappingByDevFlowChannel(devflowChannelId);
  if (!mapping) {
    return { posted: false, error: `No Slack mapping found for this ${PRODUCT_NAME} channel` };
  }

  // Load channel data to get participants and roster
  const { readJsonFile } = await import('@/lib/data-io');
  const { DataPaths } = await import('@/lib/data-paths');

  const collabData = await readJsonFile<{
    channels: Array<{
      id: string;
      name: string;
      participants: Array<{
        id: string;
        name: string;
        type: string;
        status?: string;
        color?: string;
      }>;
      roster?: Array<{
        participantId: string;
        roleId?: string;
        status?: string;
      }>;
    }>;
  }>(DataPaths.collabChannels, { channels: [] });

  const channel = collabData.channels.find(c => c.id === devflowChannelId);
  if (!channel) {
    return { posted: false, error: `${PRODUCT_NAME} channel not found: ${devflowChannelId}` };
  }

  // Load roles for role name lookup
  let roles: Array<{ id: string; name: string }> = [];
  try {
    const path = await import('path');
    const rolesPath = path.default.join(process.cwd(), 'data', 'roles', 'roles.json');
    const rolesData = await readJsonFile<{ roles: Array<{ id: string; name: string }> }>(
      rolesPath,
      { roles: [] }
    );
    roles = rolesData.roles || [];
  } catch { /* roles lookup is best-effort */ }

  // Build agent list from participants + roster
  const agents: AgentRosterData['agents'] = channel.participants
    .filter(p => p.type !== 'user') // Only show agents, not human users
    .map(p => {
      const rosterEntry = channel.roster?.find(r => r.participantId === p.id);
      const role = rosterEntry?.roleId ? roles.find(r => r.id === rosterEntry.roleId) : null;
      return {
        name: p.name,
        status: rosterEntry?.status || p.status || 'unknown',
        roleName: role?.name,
        color: p.color,
      };
    });

  const rosterData: AgentRosterData = {
    channelName: channel.name,
    agents,
  };

  const devflowUrl = await getDevFlowBaseUrl();
  const blocks = buildAgentRosterCard(rosterData, devflowUrl);
  const onlineCount = agents.filter(a =>
    a.status === 'online' || a.status === 'active' || a.status === 'working'
  ).length;
  const fallback = `Agent Roster — ${channel.name}: ${onlineCount}/${agents.length} agents online`;

  const slackTs = await postBlockKitMessage(
    mapping.slackChannelId,
    blocks,
    fallback,
    { username: PRODUCT_NAME, iconEmoji: ':robot_face:' }
  );

  return { posted: true, slackTs };
}
