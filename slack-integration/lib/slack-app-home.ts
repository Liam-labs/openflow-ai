/**
 * Slack Integration - App Home Tab
 *
 * Publishes a mini DevFlow dashboard to the Slack App Home tab.
 * When users click the DevFlow app icon in Slack's sidebar, they see:
 * - Active sprint progress
 * - Agent roster status
 * - Project health summary
 * - Recent activity from mapped channels
 *
 * Prerequisites (manual Slack App configuration):
 * 1. Event Subscriptions > Subscribe to `app_home_opened` bot event
 * 2. No new scopes needed — views.publish works with existing bot token
 */

import { getBotToken } from './slack-auth';
import { getConfig, getMappings } from './slack-bridge-data';
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

// Track recently active Slack users for auto-refresh
const activeUsers = new Set<string>();

/**
 * Record a Slack user as active (for auto-refresh targeting).
 */
export function trackActiveUser(userId: string): void {
  activeUsers.add(userId);
}

/**
 * Get all tracked active users.
 */
export function getActiveUsers(): string[] {
  return Array.from(activeUsers);
}

/**
 * Build the composite App Home view blocks.
 */
async function buildAppHomeBlocks(): Promise<SlackBlock[]> {
  const config = await getConfig();
  const devflowUrl = config?.devflowPublicUrl || 'http://localhost:3000';
  const blocks: SlackBlock[] = [];

  // --- Header ---
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `⚡ ${PRODUCT_NAME} Dashboard`, emoji: true },
  });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Last updated: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
      },
    ],
  });
  blocks.push({ type: 'divider' });

  // --- Active Sprint Progress ---
  try {
    const { readJsonFile } = await import('@/lib/data-io');
    const { DataPaths } = await import('@/lib/data-paths');

    const tasksData = await readJsonFile<{
      tasks: Array<{ id: string; status: string; sprintId?: string; phaseId?: string }>;
      sprints: Array<{ id: string; channelId: string; name: string; status: string }>;
      phases: Array<{ id: string; sprintId: string; name: string }>;
    }>(DataPaths.collabTasks, { tasks: [], sprints: [], phases: [] });

    const activeSprint = tasksData.sprints.find(s => s.status === 'active');
    if (activeSprint) {
      const sprintPhases = tasksData.phases.filter(p => p.sprintId === activeSprint.id);
      const sprintTasks = tasksData.tasks.filter(t => t.sprintId === activeSprint.id);
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
        sprintName: activeSprint.name,
        sprintStatus: activeSprint.status,
        totalTasks: total,
        completedTasks: completed,
        inProgressTasks: inProgress,
        todoTasks: todo,
        percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
        phaseProgress,
      };

      blocks.push(...buildSprintProgressCard(progressData, devflowUrl));
      blocks.push({ type: 'divider' });
    }
  } catch {
    // Sprint data unavailable — skip section
  }

  // --- Agent Roster (first mapped channel with agents) ---
  try {
    const { readJsonFile } = await import('@/lib/data-io');
    const { DataPaths } = await import('@/lib/data-paths');
    const mappings = await getMappings({ syncEnabled: true });

    if (mappings.length > 0) {
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

      // Find the first mapped channel that has agents
      for (const mapping of mappings) {
        const channel = collabData.channels.find(c => c.id === mapping.devflowChannelId);
        if (channel) {
          const agents = channel.participants
            .filter(p => p.type !== 'user')
            .map(p => {
              const rosterEntry = channel.roster?.find(r => r.participantId === p.id);
              return {
                name: p.name,
                status: rosterEntry?.status || p.status || 'unknown',
                roleName: undefined as string | undefined,
                color: p.color,
              };
            });

          if (agents.length > 0) {
            const rosterData: AgentRosterData = {
              channelName: channel.name,
              agents,
            };
            blocks.push(...buildAgentRosterCard(rosterData, devflowUrl));
            blocks.push({ type: 'divider' });
            break; // Only show one channel's roster
          }
        }
      }
    }
  } catch {
    // Roster data unavailable — skip section
  }

  // --- Health Summary ---
  try {
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
    blocks.push(...buildHealthDashboardCard(healthData, devflowUrl));
  } catch {
    // Health data unavailable — skip section
  }

  return blocks;
}

/**
 * Publish the App Home view for a specific user, or all tracked users.
 * @param userId - Specific Slack user ID (optional — publishes for all tracked users if omitted)
 */
export async function publishAppHome(userId?: string): Promise<void> {
  const token = getBotToken();
  const blocks = await buildAppHomeBlocks();

  const view = {
    type: 'home' as const,
    blocks,
  };

  const targetUsers = userId ? [userId] : getActiveUsers();
  if (targetUsers.length === 0) {
    return; // No users to publish to
  }

  for (const uid of targetUsers) {
    try {
      const res = await fetch('https://slack.com/api/views.publish', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: uid,
          view,
        }),
      });

      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) {
        console.warn(`[Slack App Home] Failed to publish for user ${uid}: ${data.error}`);
      }
    } catch (err) {
      console.error(`[Slack App Home] Error publishing for user ${uid}:`, err);
    }
  }
}
