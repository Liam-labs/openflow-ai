import { PRODUCT_NAME } from '@/lib/brand';
/**
 * Slack Integration - Block Kit Card Builders
 *
 * Pure functions that take DevFlow data and return Slack Block Kit JSON arrays.
 * No API calls here — just data transformation.
 *
 * Slack Block Kit reference: https://api.slack.com/reference/block-kit
 */

// --- Block Kit Types ---

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

export interface SlackHeaderBlock {
  type: 'header';
  text: SlackTextObject;
}

export interface SlackDividerBlock {
  type: 'divider';
}

export interface SlackSectionBlock {
  type: 'section';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  accessory?: SlackButtonElement | SlackImageElement;
}

export interface SlackContextBlock {
  type: 'context';
  elements: Array<SlackTextObject | SlackImageElement>;
}

export interface SlackActionsBlock {
  type: 'actions';
  elements: Array<SlackButtonElement>;
}

export interface SlackButtonElement {
  type: 'button';
  text: SlackTextObject;
  url?: string;
  action_id?: string;
  style?: 'primary' | 'danger';
}

export interface SlackImageElement {
  type: 'image';
  image_url: string;
  alt_text: string;
}

export type SlackBlock =
  | SlackHeaderBlock
  | SlackDividerBlock
  | SlackSectionBlock
  | SlackContextBlock
  | SlackActionsBlock;

// --- Progress Bar Utility ---

/**
 * Build a Unicode progress bar.
 * @param percent - 0-100
 * @param width - Number of characters for the bar (default 10)
 */
export function progressBar(percent: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${clamped}%`;
}

// --- Sprint Progress Card ---

export interface SprintProgressData {
  sprintName: string;
  sprintStatus: string;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  percentComplete: number;
  phaseProgress: Array<{
    phaseName: string;
    completed: number;
    total: number;
    percent: number;
  }>;
  channelName?: string;
}

/**
 * Build a rich sprint progress card for Slack.
 */
export function buildSprintProgressCard(
  data: SprintProgressData,
  devflowUrl: string = 'http://localhost:3000'
): SlackBlock[] {
  const statusEmoji =
    data.sprintStatus === 'active' ? '🟢' :
    data.sprintStatus === 'completed' ? '✅' :
    data.sprintStatus === 'cancelled' ? '❌' : '📋';

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${statusEmoji} ${data.sprintName}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Overall Progress:* ${progressBar(data.percentComplete)}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total Tasks:* ${data.totalTasks}` },
        { type: 'mrkdwn', text: `*Completed:* ${data.completedTasks}` },
        { type: 'mrkdwn', text: `*In Progress:* ${data.inProgressTasks}` },
        { type: 'mrkdwn', text: `*To Do:* ${data.todoTasks}` },
      ],
    },
  ];

  // Per-phase progress lines
  if (data.phaseProgress.length > 0) {
    blocks.push({ type: 'divider' });

    const phaseLines = data.phaseProgress
      .map(p => `• *${p.phaseName}:* ${progressBar(p.percent, 8)} (${p.completed}/${p.total})`)
      .join('\n');

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: phaseLines },
    });
  }

  // Action button
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: `View in ${PRODUCT_NAME}`, emoji: true },
        url: devflowUrl,
        action_id: 'open_devflow_sprint',
      },
    ],
  });

  // Timestamp context
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Posted from ${PRODUCT_NAME} • ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
      },
    ],
  });

  return blocks;
}

// --- Health Dashboard Card ---

export interface HealthDashboardData {
  projects: Array<{
    projectName: string;
    overallStatus: string;
    checks: Array<{
      label: string;
      status: string;
      message?: string;
      responseTime?: number;
    }>;
  }>;
}

/**
 * Build a health dashboard card for Slack.
 */
export function buildHealthDashboardCard(
  data: HealthDashboardData,
  devflowUrl: string = 'http://localhost:3000'
): SlackBlock[] {
  const onlineCount = data.projects.filter(p => p.overallStatus === 'online').length;
  const offlineCount = data.projects.filter(p => p.overallStatus === 'offline').length;
  const totalCount = data.projects.length;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🏥 Health Dashboard', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Online:* ${onlineCount}/${totalCount}` },
        { type: 'mrkdwn', text: `*Offline:* ${offlineCount}/${totalCount}` },
      ],
    },
    { type: 'divider' },
  ];

  // Per-project health checks
  for (const project of data.projects) {
    const statusEmoji =
      project.overallStatus === 'online' ? '🟢' :
      project.overallStatus === 'offline' ? '🔴' :
      project.overallStatus === 'warning' ? '🟡' : '⚪';

    const checkLines = project.checks
      .map(c => {
        const checkEmoji = c.status === 'online' ? '✅' : c.status === 'offline' ? '❌' : '⚠️';
        const time = c.responseTime ? ` (${c.responseTime}ms)` : '';
        return `${checkEmoji} ${c.label}${time}`;
      })
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${project.projectName}*\n${checkLines}`,
      },
    });
  }

  // Action button
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: `Open ${PRODUCT_NAME}`, emoji: true },
        url: devflowUrl,
        action_id: 'open_devflow_health',
      },
    ],
  });

  // Timestamp context
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Last checked • ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
      },
    ],
  });

  return blocks;
}

// --- Agent Roster Card ---

export interface AgentRosterData {
  channelName: string;
  agents: Array<{
    name: string;
    status: string;
    roleName?: string;
    color?: string;
  }>;
}

/**
 * Build an agent roster card for Slack.
 */
export function buildAgentRosterCard(
  data: AgentRosterData,
  devflowUrl: string = 'http://localhost:3000'
): SlackBlock[] {
  const onlineAgents = data.agents.filter(a =>
    a.status === 'online' || a.status === 'active' || a.status === 'working' || a.status === 'typing'
  );

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🤖 Agent Roster — ${data.channelName}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${onlineAgents.length}* of *${data.agents.length}* agents online`,
      },
    },
    { type: 'divider' },
  ];

  // Per-agent status lines
  if (data.agents.length > 0) {
    const agentLines = data.agents
      .map(a => {
        const statusEmoji =
          a.status === 'online' || a.status === 'active' ? '🟢' :
          a.status === 'working' ? '⚡' :
          a.status === 'typing' ? '✏️' :
          a.status === 'idle' ? '💤' :
          a.status === 'offline' ? '⚫' : '⚪';
        const role = a.roleName ? ` — _${a.roleName}_` : '';
        return `${statusEmoji} *${a.name}*${role}`;
      })
      .join('\n');

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: agentLines },
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No agents in this channel_' },
    });
  }

  // Action button
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: `Open ${PRODUCT_NAME}`, emoji: true },
        url: devflowUrl,
        action_id: 'open_devflow_roster',
      },
    ],
  });

  // Timestamp context
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Posted from ${PRODUCT_NAME} • ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
      },
    ],
  });

  return blocks;
}

// --- Notification Card (compact, for Phase 5) ---

export function buildNotificationCard(
  title: string,
  emoji: string,
  details: string,
  url?: string
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${title}*\n${details}`,
      },
    },
  ];

  if (url) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Details', emoji: true },
          url,
          action_id: 'open_devflow_notification',
        },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${PRODUCT_NAME} • ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
      },
    ],
  });

  return blocks;
}
