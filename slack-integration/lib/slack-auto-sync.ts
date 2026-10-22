/**
 * Slack Integration - Auto-Sync Module
 *
 * Hooks into DevFlow Collab channel lifecycle events (create, delete, rename)
 * and mirrors them to Slack when auto-sync is enabled.
 *
 * All operations are fire-and-forget with error logging — they never block
 * the DevFlow operation that triggered them.
 */

import {
  createChannel,
  archiveChannel,
  renameChannel,
  joinChannel,
  inviteToChannel,
  setChannelPurpose,
  listChannels,
  SlackApiError,
} from './slack-api-client';
import {
  readBridgeData,
  createMapping,
  deleteMapping,
  getMappingByDevFlowChannel,
  updateMapping,
  logSyncError,
  getConfig,
} from './slack-bridge-data';
import { isSlackConfigured } from './slack-auth';
import type { SlackAutoSyncConfig } from './slack-types';

/**
 * Check whether auto-sync is enabled and configured.
 */
export async function isAutoSyncEnabled(): Promise<{
  enabled: boolean;
  config: SlackAutoSyncConfig | null;
}> {
  if (!isSlackConfigured()) {
    return { enabled: false, config: null };
  }

  const bridgeConfig = await getConfig();
  if (!bridgeConfig?.autoSync?.enabled) {
    return { enabled: false, config: bridgeConfig?.autoSync || null };
  }

  return {
    enabled: true,
    config: bridgeConfig.autoSync,
  };
}

/**
 * Sanitize a DevFlow channel name for Slack.
 * Slack channel names have restrictions:
 * - Max 80 characters
 * - Lowercase only
 * - Only letters, numbers, hyphens, and underscores
 * - Cannot start or end with a hyphen or underscore
 * - No consecutive hyphens or underscores
 * - Cannot be empty
 */
export function sanitizeSlackChannelName(name: string): string {
  let sanitized = name
    .toLowerCase()
    // Replace spaces with hyphens
    .replace(/\s+/g, '-')
    // Replace any characters not allowed in Slack channel names
    .replace(/[^a-z0-9\-_]/g, '-')
    // Collapse consecutive hyphens/underscores
    .replace(/[-_]{2,}/g, '-')
    // Strip leading/trailing hyphens and underscores
    .replace(/^[-_]+|[-_]+$/g, '');

  // Truncate to 80 chars (Slack's max)
  if (sanitized.length > 80) {
    sanitized = sanitized.slice(0, 80);
    // Clean up trailing hyphens from truncation
    sanitized = sanitized.replace(/[-_]+$/, '');
  }

  // Fallback for empty result
  if (!sanitized) {
    sanitized = 'devflow-channel';
  }

  return sanitized;
}

/**
 * Find a unique Slack channel name by appending a suffix if needed.
 * Lists existing channels in the workspace and avoids collisions.
 */
async function resolveUniqueChannelName(desiredName: string): Promise<string> {
  try {
    const existing = await listChannels({ excludeArchived: false });
    const existingNames = new Set(existing.map((ch) => ch.name.toLowerCase()));

    if (!existingNames.has(desiredName)) {
      return desiredName;
    }

    // Try suffixes: "name-2", "name-3", etc.
    for (let i = 2; i <= 20; i++) {
      const suffix = `-${i}`;
      const maxBase = 80 - suffix.length;
      const base =
        desiredName.length > maxBase
          ? desiredName.slice(0, maxBase).replace(/[-_]+$/, '')
          : desiredName;
      const candidate = `${base}${suffix}`;

      if (!existingNames.has(candidate)) {
        return candidate;
      }
    }

    // Fallback: append timestamp
    const ts = Date.now().toString(36);
    const maxBase = 80 - ts.length - 1;
    const base = desiredName.slice(0, maxBase).replace(/[-_]+$/, '');
    return `${base}-${ts}`;
  } catch (err) {
    // If listing fails, just use the desired name and let createChannel handle conflicts
    console.warn(
      `[Slack AutoSync] Could not list channels for duplicate check: ${err instanceof Error ? err.message : err}`
    );
    return desiredName;
  }
}

/**
 * Called when a new DevFlow Collab channel is created.
 * Creates a matching Slack channel and sets up the mapping.
 */
export async function onChannelCreated(
  devflowChannelId: string,
  devflowChannelName: string
): Promise<void> {
  try {
    const { enabled, config } = await isAutoSyncEnabled();
    if (!enabled || !config?.autoCreateChannels) {
      return;
    }

    const sanitizedName = sanitizeSlackChannelName(devflowChannelName);
    const slackChannelName = await resolveUniqueChannelName(sanitizedName);

    console.log(
      `[Slack AutoSync] Creating Slack channel "#${slackChannelName}" for DevFlow channel "${devflowChannelName}"`
    );

    // Create channel in Slack
    const isPrivate = config.defaultVisibility === 'private';
    const slackChannel = await createChannel(slackChannelName, isPrivate);

    // Set purpose to identify the sync source
    try {
      await setChannelPurpose(
        slackChannel.id,
        `Synced from DevFlow: ${devflowChannelName}`
      );
    } catch {
      // Non-fatal — purpose is just informational
    }

    // Bot auto-joins public channels on creation, but join explicitly for safety
    try {
      await joinChannel(slackChannel.id);
    } catch {
      // May already be a member
    }

    // Auto-invite configured users
    if (config.autoInviteUserIds?.length) {
      for (const userId of config.autoInviteUserIds) {
        try {
          await inviteToChannel(slackChannel.id, userId);
        } catch {
          // already_in_channel or user_not_found — non-fatal
        }
      }
    }

    // Create the mapping
    await createMapping({
      devflowChannelId,
      devflowChannelName,
      slackChannelId: slackChannel.id,
      slackChannelName: slackChannel.name,
      syncEnabled: true,
      botInChannel: true,
    });

    console.log(
      `[Slack AutoSync] Channel synced: DevFlow "${devflowChannelName}" <-> Slack "#${slackChannel.name}"`
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack AutoSync] Error creating Slack channel: ${errMsg}`);
    await logSyncError(errMsg, 'onChannelCreated', devflowChannelId);
  }
}

/**
 * Called when a DevFlow Collab channel is deleted.
 * Archives the mapped Slack channel and cleans up the mapping.
 */
export async function onChannelDeleted(
  devflowChannelId: string
): Promise<void> {
  try {
    const { enabled, config } = await isAutoSyncEnabled();
    if (!enabled || !config?.autoArchiveChannels) {
      return;
    }

    const mapping = await getMappingByDevFlowChannel(devflowChannelId);
    if (!mapping) {
      return; // No mapping — nothing to clean up
    }

    console.log(
      `[Slack AutoSync] Archiving Slack channel "#${mapping.slackChannelName}" (mapped from DevFlow "${mapping.devflowChannelName}")`
    );

    // Archive the Slack channel (Slack doesn't truly delete channels)
    try {
      await archiveChannel(mapping.slackChannelId);
      console.log(
        `[Slack AutoSync] Slack channel "#${mapping.slackChannelName}" archived`
      );
    } catch (archiveErr) {
      // already_archived or channel_not_found are fine — continue to clean up mapping
      if (
        archiveErr instanceof SlackApiError &&
        (archiveErr.slackError === 'already_archived' ||
          archiveErr.slackError === 'channel_not_found')
      ) {
        console.log(
          `[Slack AutoSync] Slack channel already archived/gone, cleaning up mapping`
        );
      } else {
        throw archiveErr;
      }
    }

    // Clean up the mapping
    await deleteMapping(mapping.id);
    console.log(
      `[Slack AutoSync] Mapping cleaned up for "${mapping.devflowChannelName}"`
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[Slack AutoSync] Error archiving Slack channel: ${errMsg}`
    );
    await logSyncError(errMsg, 'onChannelDeleted', devflowChannelId);
  }
}

/**
 * Called when a DevFlow Collab channel is renamed.
 * Renames the mapped Slack channel to match.
 */
export async function onChannelRenamed(
  devflowChannelId: string,
  newName: string
): Promise<void> {
  try {
    const { enabled, config } = await isAutoSyncEnabled();
    if (!enabled || !config?.autoRenameChannels) {
      return;
    }

    const mapping = await getMappingByDevFlowChannel(devflowChannelId);
    if (!mapping) {
      return; // No mapping — nothing to rename
    }

    const slackName = sanitizeSlackChannelName(newName);

    // Skip if name didn't actually change after sanitization
    if (slackName === mapping.slackChannelName) {
      // Still update DevFlow-side name in the mapping
      await updateMapping(mapping.id, { devflowChannelName: newName });
      return;
    }

    console.log(
      `[Slack AutoSync] Renaming Slack channel "#${mapping.slackChannelName}" -> "#${slackName}"`
    );

    try {
      await renameChannel(mapping.slackChannelId, slackName);
    } catch (renameErr) {
      // If channel was archived or deleted, disable sync
      if (
        renameErr instanceof SlackApiError &&
        (renameErr.slackError === 'channel_not_found' ||
          renameErr.slackError === 'is_archived')
      ) {
        console.warn(
          `[Slack AutoSync] Slack channel no longer accessible. Disabling sync for mapping ${mapping.id}.`
        );
        await updateMapping(mapping.id, {
          syncEnabled: false,
          devflowChannelName: newName,
        });
        await logSyncError(
          'Channel not found/archived during rename — sync disabled',
          'onChannelRenamed',
          mapping.id
        );
        return;
      }
      throw renameErr;
    }

    // Update the mapping with the new names
    await updateMapping(mapping.id, {
      devflowChannelName: newName,
      slackChannelName: slackName,
    });

    console.log(`[Slack AutoSync] Slack channel renamed to "#${slackName}"`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[Slack AutoSync] Error renaming Slack channel: ${errMsg}`
    );
    await logSyncError(errMsg, 'onChannelRenamed', devflowChannelId);
  }
}
