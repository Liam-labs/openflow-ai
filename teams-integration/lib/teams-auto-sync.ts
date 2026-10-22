/**
 * Teams Integration - Auto-Sync Module
 *
 * Hooks into DevFlow Collab channel lifecycle events (create, delete, rename)
 * and mirrors them to Microsoft Teams when auto-sync is enabled.
 *
 * All operations are fire-and-forget with error logging — they never block
 * the DevFlow operation that triggered them.
 */

import { createChannel, deleteChannel, updateChannel, createMessageSubscription, listChannels, GraphApiError } from './teams-graph-client';
import {
  readBridgeData,
  createMapping,
  deleteMapping,
  getMappingByDevFlowChannel,
  updateMapping,
  logSyncError,
  getConfig,
} from './teams-bridge-data';
import { isTeamsConfigured } from './teams-auth';
import type { AutoSyncConfig } from './teams-types';

import { teamsNotificationSecret } from './notification-secret';
import { PRODUCT_NAME } from '@/lib/brand';
/**
 * Check whether auto-sync is enabled and configured.
 */
export async function isAutoSyncEnabled(): Promise<{ enabled: boolean; config: AutoSyncConfig | null; defaultTeamId: string | null }> {
  if (!isTeamsConfigured()) {
    return { enabled: false, config: null, defaultTeamId: null };
  }

  const bridgeConfig = await getConfig();
  if (!bridgeConfig?.autoSync?.enabled || !bridgeConfig.autoSync.defaultTeamId) {
    return { enabled: false, config: bridgeConfig?.autoSync || null, defaultTeamId: null };
  }

  return {
    enabled: true,
    config: bridgeConfig.autoSync,
    defaultTeamId: bridgeConfig.autoSync.defaultTeamId,
  };
}

/**
 * Sanitize a DevFlow channel name for Teams.
 * Teams channel names have restrictions:
 * - Max 50 characters
 * - Cannot contain: # / \ * ? " < > | :
 * - Cannot start or end with a space or period
 * - Cannot be empty or only whitespace
 * - Cannot be "General" (reserved)
 * - No control characters (tabs, newlines, etc.)
 */
export function sanitizeTeamsChannelName(name: string): string {
  let sanitized = name
    // Strip control characters (tabs, newlines, etc.)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    // Replace forbidden characters with hyphen
    .replace(/[#/\\*?"<>|:]/g, '-')
    // Collapse consecutive hyphens from replacements
    .replace(/-{2,}/g, '-')
    // Normalize whitespace (collapse multiple spaces)
    .replace(/\s+/g, ' ')
    // Strip leading/trailing spaces, hyphens, and periods
    .replace(/^[\s.\-]+|[\s.\-]+$/g, '');

  // Truncate to 50 chars, avoiding mid-word cuts when possible
  if (sanitized.length > 50) {
    sanitized = sanitized.slice(0, 50);
    // Try to cut at last space/hyphen to avoid mid-word truncation
    const lastBreak = Math.max(sanitized.lastIndexOf(' '), sanitized.lastIndexOf('-'));
    if (lastBreak > 30) {
      sanitized = sanitized.slice(0, lastBreak);
    }
    sanitized = sanitized.replace(/[\s.\-]+$/, '');
  }

  // "General" is reserved by Teams
  if (sanitized.toLowerCase() === 'general') {
    sanitized = `General-${PRODUCT_NAME}`;
  }

  // Fallback for empty result (e.g., name was all special chars)
  if (!sanitized) {
    sanitized = `${PRODUCT_NAME}-Channel`;
  }

  return sanitized;
}

/**
 * Find a unique Teams channel name by appending a suffix if needed.
 * Lists existing channels in the team and avoids collisions.
 */
async function resolveUniqueChannelName(
  teamId: string,
  desiredName: string
): Promise<string> {
  try {
    const existing = await listChannels(teamId);
    const existingNames = new Set(
      existing.map((ch) => ch.displayName.toLowerCase())
    );

    if (!existingNames.has(desiredName.toLowerCase())) {
      return desiredName;
    }

    // Try suffixes: "Name (2)", "Name (3)", etc.
    for (let i = 2; i <= 20; i++) {
      const suffix = ` (${i})`;
      // Ensure total length stays within 50 chars
      const maxBase = 50 - suffix.length;
      const base = desiredName.length > maxBase
        ? desiredName.slice(0, maxBase).replace(/[\s.\-]+$/, '')
        : desiredName;
      const candidate = `${base}${suffix}`;

      if (!existingNames.has(candidate.toLowerCase())) {
        return candidate;
      }
    }

    // Fallback: append timestamp
    const ts = Date.now().toString(36);
    const maxBase = 50 - ts.length - 1;
    const base = desiredName.slice(0, maxBase).replace(/[\s.\-]+$/, '');
    return `${base}-${ts}`;
  } catch (err) {
    // If listing fails, just use the desired name and let createChannel handle conflicts
    console.warn(
      `[Teams AutoSync] Could not list channels for duplicate check: ${err instanceof Error ? err.message : err}`
    );
    return desiredName;
  }
}

/**
 * Called when a new DevFlow Collab channel is created.
 * Creates a matching Teams channel and sets up the mapping + subscription.
 */
export async function onChannelCreated(
  devflowChannelId: string,
  devflowChannelName: string
): Promise<void> {
  try {
    const { enabled, config, defaultTeamId } = await isAutoSyncEnabled();
    if (!enabled || !config?.autoCreateChannels || !defaultTeamId) {
      return;
    }

    const sanitizedName = sanitizeTeamsChannelName(devflowChannelName);
    const teamsChannelName = await resolveUniqueChannelName(defaultTeamId, sanitizedName);

    console.log(
      `[Teams AutoSync] Creating Teams channel "${teamsChannelName}" for DevFlow channel "${devflowChannelName}"`
    );

    // Create channel in Teams
    const teamsChannel = await createChannel(
      defaultTeamId,
      teamsChannelName,
      `Synced from DevFlow: ${devflowChannelName}`,
      config.defaultMembershipType
    );

    // Get team name for the mapping
    const bridgeData = await readBridgeData();
    const existingMapping = bridgeData.mappings.find(m => m.teamsTeamId === defaultTeamId);
    const teamsTeamName = existingMapping?.teamsTeamName || 'Dev';

    // Create the mapping
    const mapping = await createMapping({
      devflowChannelId,
      devflowChannelName,
      teamsTeamId: defaultTeamId,
      teamsTeamName,
      teamsChannelId: teamsChannel.id,
      teamsChannelName: teamsChannel.displayName,
      syncEnabled: true,
      conversationReference: null, // Will be set when bot joins
      subscriptionId: null,
      subscriptionExpiresAt: null,
    });

    // Try to create a notification subscription
    try {
      const bridgeConfig = await getConfig();
      const tunnelUrl = bridgeConfig?.tunnelUrl;
      const clientState = teamsNotificationSecret();

      if (tunnelUrl) {
        const subscription = await createMessageSubscription(
          defaultTeamId,
          teamsChannel.id,
          `${tunnelUrl}/api/teams-bot/notifications`,
          `${tunnelUrl}/api/teams-bot/lifecycle`,
          clientState
        );

        await updateMapping(mapping.id, {
          subscriptionId: subscription.id,
          subscriptionExpiresAt: subscription.expirationDateTime,
        });

        console.log(
          `[Teams AutoSync] Subscription created for Teams channel "${teamsChannelName}" (expires: ${subscription.expirationDateTime})`
        );
      }
    } catch (subErr) {
      // Subscription failure is non-fatal — message sync still works via polling
      const errMsg = subErr instanceof Error ? subErr.message : String(subErr);
      console.warn(`[Teams AutoSync] Subscription creation failed (non-fatal): ${errMsg}`);
      await logSyncError(errMsg, 'onChannelCreated:subscription', mapping.id);
    }

    console.log(
      `[Teams AutoSync] Channel synced: DevFlow "${devflowChannelName}" <-> Teams "${teamsChannelName}"`
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Teams AutoSync] Error creating Teams channel: ${errMsg}`);
    await logSyncError(errMsg, 'onChannelCreated', devflowChannelId);
  }
}

/**
 * Called when a DevFlow Collab channel is deleted.
 * Deletes the mapped Teams channel and cleans up the mapping.
 */
export async function onChannelDeleted(
  devflowChannelId: string
): Promise<void> {
  try {
    const { enabled, config } = await isAutoSyncEnabled();
    if (!enabled || !config?.autoDeleteChannels) {
      return;
    }

    const mapping = await getMappingByDevFlowChannel(devflowChannelId);
    if (!mapping) {
      return; // No mapping — nothing to clean up
    }

    console.log(
      `[Teams AutoSync] Deleting Teams channel "${mapping.teamsChannelName}" (mapped from DevFlow "${mapping.devflowChannelName}")`
    );

    // Delete the Teams channel
    try {
      await deleteChannel(mapping.teamsTeamId, mapping.teamsChannelId);
      console.log(`[Teams AutoSync] Teams channel "${mapping.teamsChannelName}" deleted`);
    } catch (delErr) {
      // 404 means already deleted — that's fine, continue to clean up mapping
      if (delErr instanceof GraphApiError && (delErr.statusCode === 404 || delErr.code === 'NotFound' || delErr.code === 'ItemNotFound')) {
        console.log(`[Teams AutoSync] Teams channel already deleted (404), cleaning up mapping`);
      } else {
        throw delErr;
      }
    }

    // Clean up the mapping
    await deleteMapping(mapping.id);
    console.log(`[Teams AutoSync] Mapping cleaned up for "${mapping.devflowChannelName}"`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Teams AutoSync] Error deleting Teams channel: ${errMsg}`);
    await logSyncError(errMsg, 'onChannelDeleted', devflowChannelId);
  }
}

/**
 * Called when a DevFlow Collab channel is renamed.
 * Renames the mapped Teams channel to match.
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

    const teamsName = sanitizeTeamsChannelName(newName);

    // Skip if name didn't actually change after sanitization
    if (teamsName === mapping.teamsChannelName) {
      // Still update DevFlow-side name in the mapping
      await updateMapping(mapping.id, { devflowChannelName: newName });
      return;
    }

    console.log(
      `[Teams AutoSync] Renaming Teams channel "${mapping.teamsChannelName}" -> "${teamsName}"`
    );

    try {
      await updateChannel(mapping.teamsTeamId, mapping.teamsChannelId, {
        displayName: teamsName,
      });
    } catch (renameErr) {
      // If channel was deleted on Teams side, disable sync
      if (renameErr instanceof GraphApiError && (renameErr.statusCode === 404 || renameErr.code === 'NotFound')) {
        console.warn(`[Teams AutoSync] Teams channel no longer exists. Disabling sync for mapping ${mapping.id}.`);
        await updateMapping(mapping.id, { syncEnabled: false, devflowChannelName: newName });
        await logSyncError('Channel not found during rename — sync disabled', 'onChannelRenamed', mapping.id);
        return;
      }
      throw renameErr;
    }

    // Update the mapping with the new names
    await updateMapping(mapping.id, {
      devflowChannelName: newName,
      teamsChannelName: teamsName,
    });

    console.log(`[Teams AutoSync] Teams channel renamed to "${teamsName}"`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Teams AutoSync] Error renaming Teams channel: ${errMsg}`);
    await logSyncError(errMsg, 'onChannelRenamed', devflowChannelId);
  }
}
