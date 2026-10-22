/**
 * Agent API Actions - Slack Bridge
 *
 * Programmatic access to Slack integration management.
 * Actions: slack.status, slack.configure, slack.test,
 *          slack.list-channels, slack.create-channel, slack.archive-channel,
 *          slack.rename-channel, slack.join-channel,
 *          slack.map-channel, slack.unmap-channel, slack.mappings,
 *          slack.auto-sync, slack.errors, slack.poller, slack.bulk-sync,
 *          slack.send-file
 */

import { readFile, stat } from 'fs/promises';
import path from 'path';
import type { AgentApiRequest } from '@/lib/types';

import { isSlackConfigured, testConnection } from '../../../../slack-integration/lib/slack-auth';
import { getBridgeStatus } from '../../../../slack-integration/lib/slack-bridge';
import {
  startPoller,
  stopPoller,
  getPollerStatus,
} from '../../../../slack-integration/lib/slack-socket';
import {
  saveConfig,
  getConfig,
  createMapping,
  deleteMapping,
  getMappings,
  getRecentErrors,
  updateMapping,
} from '../../../../slack-integration/lib/slack-bridge-data';
import {
  listChannels,
  createChannel,
  archiveChannel,
  renameChannel,
  joinChannel,
  getChannel,
  uploadFile,
} from '../../../../slack-integration/lib/slack-api-client';
import {
  sanitizeSlackChannelName,
  onChannelCreated,
} from '../../../../slack-integration/lib/slack-auto-sync';
import {
  getQueueStatus,
  drainQueue,
} from '../../../../slack-integration/lib/slack-outbound-queue';
import { PRODUCT_NAME } from '@/lib/brand';
import { selfOrigin } from '@/lib/self-origin';

type ActionBody = AgentApiRequest & {
  workspaceId?: string;
  appId?: string;
  botUserId?: string;
  syncEnabled?: boolean;
  pollIntervalMs?: number;
  types?: string;
  excludeArchived?: boolean;
  name?: string;
  isPrivate?: boolean;
  channelId?: string;
  devflowChannelId?: string;
  devflowChannelName?: string;
  slackChannelId?: string;
  slackChannelName?: string;
  mappingId?: string;
  enabled?: boolean;
  autoCreateChannels?: boolean;
  autoArchiveChannels?: boolean;
  autoRenameChannels?: boolean;
  defaultVisibility?: string;
  autoInviteUserIds?: string[];
  dryRun?: boolean;
  sprintId?: string;
  userId?: string;
  notificationChannelId?: string;
  notificationEvents?: string[];
  subAction?: string;
  command?: string;
  limit?: number;
  filePath?: string;
  filename?: string;
  title?: string;
  initialComment?: string;
};

export async function handleSlackBridgeAction(
  action: string,
  body: ActionBody
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    switch (action) {
      case 'slack.status':
        return await handleStatus();

      case 'slack.configure':
        return await handleConfigure(body);

      case 'slack.test':
        return await handleTest();

      case 'slack.list-channels':
        return await handleListChannels(body);

      case 'slack.create-channel':
        return await handleCreateChannel(body);

      case 'slack.archive-channel':
        return await handleArchiveChannel(body);

      case 'slack.rename-channel':
        return await handleRenameChannel(body);

      case 'slack.join-channel':
        return await handleJoinChannel(body);

      case 'slack.map-channel':
        return await handleMapChannel(body);

      case 'slack.unmap-channel':
        return await handleUnmapChannel(body);

      case 'slack.mappings':
        return await handleListMappings(body);

      case 'slack.auto-sync':
        return await handleAutoSync(body);

      case 'slack.errors':
        return await handleErrors(body);

      case 'slack.poller':
        return await handlePoller(body);

      case 'slack.bulk-sync':
        return await handleBulkSync(body);

      case 'slack.post-sprint':
        return await handlePostSprint(body);

      case 'slack.post-health':
        return await handlePostHealth(body);

      case 'slack.post-roster':
        return await handlePostRoster(body);

      case 'slack.refresh-home':
        return await handleRefreshHome(body);

      case 'slack.notifications':
        return await handleNotifications(body);

      case 'slack.queue':
        return await handleQueue(body);

      case 'slack.send-file':
        return await handleSendFile(body);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Action Handlers ---

async function handleStatus() {
  const status = await getBridgeStatus();
  return { success: true, data: status };
}

async function handleConfigure(body: ActionBody) {
  const { workspaceId, appId, botUserId, syncEnabled, pollIntervalMs } = body;

  const config = await saveConfig({
    workspaceId,
    appId,
    botUserId,
    syncEnabled,
    pollIntervalMs,
  });

  return { success: true, data: { config } };
}

async function handleTest() {
  if (!isSlackConfigured()) {
    return {
      success: false,
      error:
        'Slack not configured. Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET environment variables.',
    };
  }

  const result = await testConnection();
  return {
    success: result.success,
    data: result,
    error: result.error,
  };
}

async function handleListChannels(body: ActionBody) {
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  const types = body.types || 'public_channel,private_channel';
  const excludeArchived = body.excludeArchived ?? true;

  const channels = await listChannels({ types, excludeArchived });
  return { success: true, data: { channels, count: channels.length } };
}

async function handleCreateChannel(body: ActionBody) {
  const { name, isPrivate } = body;
  if (!name) {
    return { success: false, error: 'Missing required field: name' };
  }
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  const channel = await createChannel(name, isPrivate ?? false);

  // Auto-join the channel
  try {
    await joinChannel(channel.id);
  } catch {
    // May already be a member
  }

  return { success: true, data: { channel } };
}

async function handleArchiveChannel(body: ActionBody) {
  const { channelId } = body;
  if (!channelId) {
    return { success: false, error: 'Missing required field: channelId' };
  }
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  await archiveChannel(channelId);
  return { success: true };
}

async function handleRenameChannel(body: ActionBody) {
  const { channelId, name } = body;
  if (!channelId || !name) {
    return {
      success: false,
      error: 'Missing required fields: channelId, name',
    };
  }
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  const channel = await renameChannel(channelId, name);
  return { success: true, data: { channel } };
}

async function handleJoinChannel(body: ActionBody) {
  const { channelId } = body;
  if (!channelId) {
    return { success: false, error: 'Missing required field: channelId' };
  }
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  await joinChannel(channelId);

  // Update mapping if one exists for this channel
  const mappings = await getMappings({ slackChannelId: channelId });
  if (mappings.length > 0) {
    await updateMapping(mappings[0].id, { botInChannel: true });
  }

  return { success: true };
}

async function handleMapChannel(body: ActionBody) {
  const { devflowChannelId, devflowChannelName, slackChannelId, slackChannelName } =
    body;

  if (!devflowChannelId || !slackChannelId) {
    return {
      success: false,
      error: 'Missing required fields: devflowChannelId, slackChannelId',
    };
  }

  // If slackChannelName not provided, look it up
  let channelName = slackChannelName || '';
  if (!channelName && isSlackConfigured()) {
    try {
      const channel = await getChannel(slackChannelId);
      channelName = channel.name;
    } catch {
      // Non-fatal — name is just informational
    }
  }

  const mapping = await createMapping({
    devflowChannelId,
    devflowChannelName: devflowChannelName || '',
    slackChannelId,
    slackChannelName: channelName,
    syncEnabled: true,
    botInChannel: false,
  });

  // Try to join the channel so the bot is ready
  if (isSlackConfigured()) {
    try {
      await joinChannel(slackChannelId);
      await updateMapping(mapping.id, { botInChannel: true });
    } catch {
      // Non-fatal — user can invite bot manually
    }
  }

  return { success: true, data: { mapping } };
}

async function handleUnmapChannel(body: ActionBody) {
  const { mappingId } = body;
  if (!mappingId) {
    return { success: false, error: 'Missing required field: mappingId' };
  }

  await deleteMapping(mappingId);
  return { success: true };
}

async function handleListMappings(body: ActionBody) {
  const { devflowChannelId, slackChannelId, syncEnabled } = body;
  const mappings = await getMappings({
    devflowChannelId,
    slackChannelId,
    syncEnabled,
  });
  return { success: true, data: { mappings, count: mappings.length } };
}

async function handleAutoSync(body: ActionBody) {
  const {
    enabled,
    autoCreateChannels,
    autoArchiveChannels,
    autoRenameChannels,
    defaultVisibility,
    autoInviteUserIds,
  } = body;

  // Build partial auto-sync config from provided fields
  const updates: Record<string, unknown> = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (autoCreateChannels !== undefined)
    updates.autoCreateChannels = autoCreateChannels;
  if (autoArchiveChannels !== undefined)
    updates.autoArchiveChannels = autoArchiveChannels;
  if (autoRenameChannels !== undefined)
    updates.autoRenameChannels = autoRenameChannels;
  if (defaultVisibility !== undefined)
    updates.defaultVisibility = defaultVisibility;
  if (autoInviteUserIds !== undefined)
    updates.autoInviteUserIds = autoInviteUserIds;

  if (Object.keys(updates).length === 0) {
    // No updates provided — return current config
    const config = await getConfig();
    return {
      success: true,
      data: { autoSync: config?.autoSync || null },
    };
  }

  // Merge updates into existing autoSync config
  const currentConfig = await getConfig();
  const { DEFAULT_AUTO_SYNC_CONFIG } = await import(
    '../../../../slack-integration/lib/slack-types'
  );
  const currentAutoSync =
    currentConfig?.autoSync ?? DEFAULT_AUTO_SYNC_CONFIG;
  const mergedAutoSync = { ...currentAutoSync, ...updates };

  const config = await saveConfig({ autoSync: mergedAutoSync });
  return { success: true, data: { autoSync: config.autoSync } };
}

async function handleErrors(body: ActionBody) {
  const limit = body.limit || 10;
  const errors = await getRecentErrors(limit);
  return { success: true, data: { errors, count: errors.length } };
}

async function handlePoller(body: ActionBody) {
  const command = body.command || 'status';

  switch (command) {
    case 'start': {
      if (!isSlackConfigured()) {
        return { success: false, error: 'Slack not configured' };
      }
      await startPoller();
      return { success: true, data: { message: 'Poller started', ...getPollerStatus() } };
    }
    case 'stop': {
      stopPoller();
      return { success: true, data: { message: 'Poller stopped', ...getPollerStatus() } };
    }
    case 'status':
    default: {
      return { success: true, data: getPollerStatus() };
    }
  }
}

async function handleBulkSync(body: ActionBody) {
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  const dryRun = body.dryRun ?? false;

  // Fetch all DevFlow collab channels
  const collabRes = await fetch(`${selfOrigin()}/api/collab`);
  if (!collabRes.ok) {
    return { success: false, error: 'Failed to fetch collab channels' };
  }
  const collabData = (await collabRes.json()) as {
    channels: Array<{ id: string; name: string; parentChannelId?: string }>;
  };
  const devflowChannels = collabData.channels || [];

  // Get existing mappings
  const existingMappings = await getMappings({});
  const mappedDevFlowIds = new Set(
    existingMappings.map((m) => m.devflowChannelId)
  );

  // Find unmapped channels
  const unmapped = devflowChannels.filter(
    (ch) => !mappedDevFlowIds.has(ch.id)
  );

  if (dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        totalChannels: devflowChannels.length,
        alreadyMapped: existingMappings.length,
        toCreate: unmapped.length,
        channels: unmapped.map((ch) => ({
          id: ch.id,
          name: ch.name,
          slackName: sanitizeSlackChannelName(ch.name),
        })),
      },
    };
  }

  // Create Slack channels for each unmapped DevFlow channel
  const results: Array<{
    devflowChannel: string;
    slackChannel?: string;
    status: 'created' | 'error';
    error?: string;
  }> = [];

  for (const ch of unmapped) {
    try {
      // Use the auto-sync module which handles sanitization, dedup, join, and mapping
      await onChannelCreated(ch.id, ch.name);
      results.push({
        devflowChannel: ch.name,
        slackChannel: sanitizeSlackChannelName(ch.name),
        status: 'created',
      });
    } catch (err) {
      results.push({
        devflowChannel: ch.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Also start the poller if not running
  const pollerStatus = getPollerStatus();
  if (!pollerStatus.running) {
    await startPoller();
  }

  return {
    success: true,
    data: {
      totalChannels: devflowChannels.length,
      alreadyMapped: existingMappings.length,
      created: results.filter((r) => r.status === 'created').length,
      errors: results.filter((r) => r.status === 'error').length,
      results,
      pollerStarted: !pollerStatus.running,
    },
  };
}

// --- Rich Message Actions (Phase 1) ---

async function handlePostSprint(body: ActionBody) {
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  const { channelId, sprintId } = body;
  if (!channelId) {
    return { success: false, error: `Missing required field: channelId (${PRODUCT_NAME} channel ID)` };
  }

  const { postSprintProgressToSlack } = await import(
    '../../../../slack-integration/lib/slack-rich-messages'
  );
  const result = await postSprintProgressToSlack(channelId, sprintId);

  if (!result.posted) {
    return { success: false, error: result.error };
  }

  return { success: true, data: { slackTs: result.slackTs } };
}

async function handlePostHealth(body: ActionBody) {
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  const { slackChannelId } = body;

  const { postHealthDashboardToSlack } = await import(
    '../../../../slack-integration/lib/slack-rich-messages'
  );
  const result = await postHealthDashboardToSlack(slackChannelId);

  if (!result.posted) {
    return { success: false, error: result.error };
  }

  return { success: true, data: { slackTs: result.slackTs } };
}

async function handlePostRoster(body: ActionBody) {
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  const { channelId } = body;
  if (!channelId) {
    return { success: false, error: `Missing required field: channelId (${PRODUCT_NAME} channel ID)` };
  }

  const { postAgentRosterToSlack } = await import(
    '../../../../slack-integration/lib/slack-rich-messages'
  );
  const result = await postAgentRosterToSlack(channelId);

  if (!result.posted) {
    return { success: false, error: result.error };
  }

  return { success: true, data: { slackTs: result.slackTs } };
}

// --- App Home Tab Action (Phase 3) ---

async function handleRefreshHome(body: ActionBody) {
  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  try {
    const { publishAppHome } = await import(
      '../../../../slack-integration/lib/slack-app-home'
    );
    const userId = body.userId;
    await publishAppHome(userId);
    return { success: true, data: { refreshed: true, userId: userId || 'all tracked users' } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Notifications Action (Phase 5) ---

async function handleNotifications(body: ActionBody) {
  const { enabled, notificationChannelId, notificationEvents } = body;

  // If no params, return current config
  if (enabled === undefined && !notificationChannelId && !notificationEvents) {
    const config = await getConfig();
    return {
      success: true,
      data: {
        enabled: config?.notificationsEnabled ?? false,
        channelId: config?.notificationChannelId ?? null,
        events: config?.notificationEvents ?? null,
      },
    };
  }

  // Update config
  const updates: Record<string, unknown> = {};
  if (enabled !== undefined) updates.notificationsEnabled = enabled;
  if (notificationChannelId) updates.notificationChannelId = notificationChannelId;
  if (notificationEvents) updates.notificationEvents = notificationEvents;

  const config = await saveConfig(updates as Parameters<typeof saveConfig>[0]);
  return {
    success: true,
    data: {
      enabled: config.notificationsEnabled ?? false,
      channelId: config.notificationChannelId ?? null,
      events: config.notificationEvents ?? null,
    },
  };
}

// --- Outbound Queue ---

async function handleQueue(body: ActionBody) {
  const subAction = body.subAction || 'status';

  switch (subAction) {
    case 'status': {
      const status = await getQueueStatus();
      return { success: true, data: status };
    }
    case 'drain': {
      const result = await drainQueue();
      return { success: true, data: result };
    }
    default:
      return { success: false, error: `Unknown queue sub-action: ${subAction}. Use "status" or "drain".` };
  }
}

// --- File Upload Action ---

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

async function handleSendFile(body: ActionBody) {
  const { slackChannelId, filePath } = body;
  if (!slackChannelId) {
    return { success: false, error: 'Missing required field: slackChannelId' };
  }
  if (!filePath) {
    return { success: false, error: 'Missing required field: filePath' };
  }

  if (!isSlackConfigured()) {
    return { success: false, error: 'Slack not configured' };
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return { success: false, error: `File not found: ${filePath}` };
  }

  if (!fileStat.isFile()) {
    return { success: false, error: `Path is not a file: ${filePath}` };
  }

  if (fileStat.size > MAX_FILE_SIZE_BYTES) {
    return {
      success: false,
      error: `File too large: ${(fileStat.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit`,
    };
  }

  if (fileStat.size === 0) {
    return { success: false, error: 'File is empty' };
  }

  const fileBuffer = await readFile(filePath);
  const filename = body.filename || path.basename(filePath);

  const result = await uploadFile(slackChannelId, fileBuffer, filename, {
    title: body.title || filename,
    initialComment: body.initialComment,
  });

  return {
    success: true,
    data: {
      fileId: result.fileId,
      filename,
      size: fileStat.size,
      slackChannelId,
    },
  };
}
