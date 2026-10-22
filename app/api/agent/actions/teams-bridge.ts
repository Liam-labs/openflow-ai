/**
 * Agent API Actions - Teams Bridge
 *
 * Programmatic access to Teams integration management.
 * Actions: msteams.status, msteams.configure, msteams.test,
 *          msteams.map-channel, msteams.unmap-channel, msteams.list-teams, msteams.list-channels,
 *          msteams.create-channel, msteams.delete-channel, msteams.update-channel, msteams.auto-sync,
 *          msteams.backfill-refs
 *
 * Uses 'msteams.*' prefix to avoid collision with DevFlow's internal 'teams.*' namespace.
 */

import type { AgentApiRequest } from '@/lib/types';
import { isTeamsConfigured, testConnection } from '../../../../teams-integration/lib/teams-auth';
import { getBridgeStatus } from '../../../../teams-integration/lib/teams-bridge';
import { backfillConversationReferences } from '../../../../teams-integration/lib/teams-bot';
import {
  saveConfig,
  getConfig,
  createMapping,
  deleteMapping,
  getMappings,
  getRecentErrors,
} from '../../../../teams-integration/lib/teams-bridge-data';
import {
  listTeams,
  listChannels,
  createChannel,
  deleteChannel,
  updateChannel,
  createMessageSubscription,
  deleteSubscription,
} from '../../../../teams-integration/lib/teams-graph-client';

import { teamsNotificationSecret } from '../../../../teams-integration/lib/notification-secret';
type ActionBody = AgentApiRequest & {
  tenantId?: string;
  clientId?: string;
  botId?: string;
  tunnelUrl?: string;
  syncEnabled?: boolean;
  pollIntervalMs?: number;
  teamId?: string;
  channelId?: string;
  displayName?: string;
  description?: string | null;
  membershipType?: 'standard' | 'private';
  devflowChannelId?: string;
  devflowChannelName?: string;
  teamsTeamId?: string;
  teamsTeamName?: string;
  teamsChannelId?: string;
  teamsChannelName?: string;
  mappingId?: string;
  enabled?: boolean;
  autoCreateChannels?: boolean;
  autoDeleteChannels?: boolean;
  autoRenameChannels?: boolean;
  defaultTeamId?: string;
  defaultMembershipType?: string;
  limit?: number;
};

export async function handleTeamsBridgeAction(
  action: string,
  body: ActionBody
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    switch (action) {
      case 'msteams.status':
        return await handleStatus();

      case 'msteams.configure':
        return await handleConfigure(body);

      case 'msteams.test':
        return await handleTest();

      case 'msteams.list-teams':
        return await handleListTeams();

      case 'msteams.list-channels':
        return await handleListChannels(body);

      case 'msteams.map-channel':
        return await handleMapChannel(body);

      case 'msteams.unmap-channel':
        return await handleUnmapChannel(body);

      case 'msteams.mappings':
        return await handleListMappings(body);

      case 'msteams.create-channel':
        return await handleCreateChannel(body);

      case 'msteams.delete-channel':
        return await handleDeleteChannel(body);

      case 'msteams.update-channel':
        return await handleUpdateChannel(body);

      case 'msteams.auto-sync':
        return await handleAutoSync(body);

      case 'msteams.subscribe':
        return await handleSubscribe(body);

      case 'msteams.unsubscribe':
        return await handleUnsubscribe(body);

      case 'msteams.errors':
        return await handleErrors(body);

      case 'msteams.backfill-refs':
        return await handleBackfillRefs();

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
  const { tenantId, clientId, botId, tunnelUrl, syncEnabled, pollIntervalMs } =
    body;

  const config = await saveConfig({
    tenantId,
    clientId,
    botId,
    tunnelUrl,
    syncEnabled,
    pollIntervalMs,
  });

  return { success: true, data: { config } };
}

async function handleTest() {
  if (!isTeamsConfigured()) {
    return {
      success: false,
      error: 'Teams not configured. Set TEAMS_TENANT_ID, TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET environment variables.',
    };
  }

  const result = await testConnection();
  return {
    success: result.success,
    data: result,
    error: result.error,
  };
}

async function handleListTeams() {
  if (!isTeamsConfigured()) {
    return { success: false, error: 'Teams not configured' };
  }
  const teams = await listTeams();
  return { success: true, data: { teams } };
}

async function handleListChannels(body: ActionBody) {
  const { teamId } = body;
  if (!teamId) {
    return { success: false, error: 'Missing required field: teamId' };
  }
  if (!isTeamsConfigured()) {
    return { success: false, error: 'Teams not configured' };
  }
  const channels = await listChannels(teamId);
  return { success: true, data: { channels } };
}

async function handleMapChannel(body: ActionBody) {
  const {
    devflowChannelId,
    devflowChannelName,
    teamsTeamId,
    teamsTeamName,
    teamsChannelId,
    teamsChannelName,
  } = body;

  if (!devflowChannelId || !teamsTeamId || !teamsChannelId) {
    return {
      success: false,
      error: 'Missing required fields: devflowChannelId, teamsTeamId, teamsChannelId',
    };
  }

  const mapping = await createMapping({
    devflowChannelId,
    devflowChannelName: devflowChannelName || '',
    teamsTeamId,
    teamsTeamName: teamsTeamName || '',
    teamsChannelId,
    teamsChannelName: teamsChannelName || '',
    syncEnabled: true,
    conversationReference: null,
    subscriptionId: null,
    subscriptionExpiresAt: null,
  });

  return { success: true, data: { mapping } };
}

async function handleUnmapChannel(body: ActionBody) {
  const { mappingId } = body;
  if (!mappingId) {
    return { success: false, error: 'Missing required field: mappingId' };
  }

  // Clean up subscription if exists
  const mappings = await getMappings();
  const mapping = mappings.find((m) => m.id === mappingId);
  if (mapping?.subscriptionId) {
    try {
      await deleteSubscription(mapping.subscriptionId);
    } catch {
      // Subscription may already be expired
    }
  }

  await deleteMapping(mappingId);
  return { success: true };
}

async function handleListMappings(body: ActionBody) {
  const { devflowChannelId, teamsChannelId, syncEnabled } = body;
  const mappings = await getMappings({
    devflowChannelId,
    teamsChannelId,
    syncEnabled,
  });
  return { success: true, data: { mappings } };
}

async function handleCreateChannel(body: ActionBody) {
  const { teamId, displayName, description, membershipType } = body;
  if (!teamId || !displayName) {
    return {
      success: false,
      error: 'Missing required fields: teamId, displayName',
    };
  }

  const channel = await createChannel(
    teamId,
    displayName,
    description ?? undefined,
    membershipType
  );
  return { success: true, data: { channel } };
}

async function handleDeleteChannel(body: ActionBody) {
  const { teamId, channelId } = body;
  if (!teamId || !channelId) {
    return {
      success: false,
      error: 'Missing required fields: teamId, channelId',
    };
  }
  if (!isTeamsConfigured()) {
    return { success: false, error: 'Teams not configured' };
  }

  await deleteChannel(teamId, channelId);
  return { success: true };
}

async function handleUpdateChannel(body: ActionBody) {
  const { teamId, channelId, displayName, description } = body;
  if (!teamId || !channelId) {
    return {
      success: false,
      error: 'Missing required fields: teamId, channelId',
    };
  }
  if (!displayName && description === undefined) {
    return {
      success: false,
      error: 'At least one update field required: displayName, description',
    };
  }
  if (!isTeamsConfigured()) {
    return { success: false, error: 'Teams not configured' };
  }

  const updates: { displayName?: string; description?: string | null } = {};
  if (displayName) updates.displayName = displayName;
  if (description !== undefined) updates.description = description;

  await updateChannel(teamId, channelId, updates);
  return { success: true };
}

async function handleAutoSync(body: ActionBody) {
  const {
    enabled,
    autoCreateChannels,
    autoDeleteChannels,
    autoRenameChannels,
    defaultTeamId,
    defaultMembershipType,
  } = body;

  // Build partial auto-sync config from provided fields
  const updates: Record<string, unknown> = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (autoCreateChannels !== undefined) updates.autoCreateChannels = autoCreateChannels;
  if (autoDeleteChannels !== undefined) updates.autoDeleteChannels = autoDeleteChannels;
  if (autoRenameChannels !== undefined) updates.autoRenameChannels = autoRenameChannels;
  if (defaultTeamId !== undefined) updates.defaultTeamId = defaultTeamId;
  if (defaultMembershipType !== undefined) updates.defaultMembershipType = defaultMembershipType;

  if (Object.keys(updates).length === 0) {
    // No updates provided - return current config
    const config = await getConfig();
    return {
      success: true,
      data: { autoSync: config?.autoSync || null },
    };
  }

  // Merge updates into existing autoSync config
  const currentConfig = await getConfig();
  const { DEFAULT_AUTO_SYNC_CONFIG } = await import('../../../../teams-integration/lib/teams-types');
  const currentAutoSync = currentConfig?.autoSync ?? DEFAULT_AUTO_SYNC_CONFIG;
  const mergedAutoSync = { ...currentAutoSync, ...updates };

  const config = await saveConfig({ autoSync: mergedAutoSync });
  return { success: true, data: { autoSync: config.autoSync } };
}

async function handleSubscribe(body: ActionBody) {
  const { mappingId } = body;
  if (!mappingId) {
    return { success: false, error: 'Missing required field: mappingId' };
  }

  const config = await getConfig();
  if (!config?.tunnelUrl) {
    return {
      success: false,
      error: 'Tunnel URL not configured. Set it via teams.configure action.',
    };
  }

  const mappings = await getMappings();
  const mapping = mappings.find((m) => m.id === mappingId);
  if (!mapping) {
    return { success: false, error: `Mapping not found: ${mappingId}` };
  }

  const notificationUrl = `${config.tunnelUrl}/api/teams-bot/notifications`;
  const lifecycleUrl = `${config.tunnelUrl}/api/teams-bot/notifications`;
  const clientState = teamsNotificationSecret();

  const subscription = await createMessageSubscription(
    mapping.teamsTeamId,
    mapping.teamsChannelId,
    notificationUrl,
    lifecycleUrl,
    clientState
  );

  // Update mapping with subscription info
  const { updateMapping } = await import('../../../../teams-integration/lib/teams-bridge-data');
  await updateMapping(mappingId, {
    subscriptionId: subscription.id,
    subscriptionExpiresAt: subscription.expirationDateTime,
  });

  return { success: true, data: { subscription } };
}

async function handleUnsubscribe(body: ActionBody) {
  const { mappingId } = body;
  if (!mappingId) {
    return { success: false, error: 'Missing required field: mappingId' };
  }

  const mappings = await getMappings();
  const mapping = mappings.find((m) => m.id === mappingId);
  if (!mapping?.subscriptionId) {
    return { success: false, error: 'No active subscription for this mapping' };
  }

  await deleteSubscription(mapping.subscriptionId);

  const { updateMapping } = await import('../../../../teams-integration/lib/teams-bridge-data');
  await updateMapping(mappingId, {
    subscriptionId: null,
    subscriptionExpiresAt: null,
  });

  return { success: true };
}

async function handleErrors(body: ActionBody) {
  const limit = body.limit || 10;
  const errors = await getRecentErrors(limit);
  return { success: true, data: { errors } };
}

async function handleBackfillRefs() {
  const result = await backfillConversationReferences();
  return { success: true, data: result };
}
