/**
 * Teams Integration - Bridge Service
 *
 * Orchestrates bidirectional message sync between DevFlow Collab and Teams.
 *
 * Outbound (DevFlow -> Teams): Hooks into collab message creation,
 * forwards to mapped Teams channel via bot proactive messaging.
 *
 * Inbound (Teams -> DevFlow): Receives Graph API change notifications
 * via webhook, injects messages into DevFlow Collab channels.
 *
 * Echo prevention: Messages carry origin metadata to prevent infinite loops.
 */

import { sendProactiveMessage, SenderInfo } from './teams-bot';
import {
  getMappings,
  getMappingByDevFlowChannel,
  logSyncError,
  updateTeamsMessageCursor,
  updateDevFlowTimestampCursor,
  updateMapping,
} from './teams-bridge-data';
import { isTeamsConfigured, getGraphToken } from './teams-auth';
import { TeamsBridgeStatus, BridgedMessageMetadata } from './teams-types';
import { readBridgeData, getRecentErrors } from './teams-bridge-data';
import { GraphApiError } from './teams-graph-client';
import { PRODUCT_NAME } from '@/lib/brand';

// --- Teams Attachment Type ---

export interface TeamsAttachment {
  id: string;
  contentType: string;
  contentUrl: string;
  name: string;
}

// --- Retry helpers ---

const BRIDGE_MAX_RETRIES = 2;
const BRIDGE_BASE_DELAY_MS = 1000;

// Dedup: only log "No ConversationReference" once per mapping per 5 minutes
const _noConvRefWarned = new Map<string, number>();
const NO_CONV_REF_WARN_INTERVAL = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a Graph API error indicates the Teams channel no longer exists.
 * Disables the mapping to prevent repeated failures.
 */
async function handleStaleMapping(
  mappingId: string,
  err: unknown,
  context: string
): Promise<boolean> {
  if (err instanceof GraphApiError) {
    // 404 = channel deleted, 403 = permissions revoked
    if (err.statusCode === 404 || err.code === 'NotFound' || err.code === 'ItemNotFound') {
      console.warn(
        `[Teams Bridge] Channel no longer exists for mapping ${mappingId}. Disabling sync.`
      );
      await updateMapping(mappingId, { syncEnabled: false });
      await logSyncError(
        `Channel not found (404) — sync disabled automatically. Re-enable after fixing the mapping.`,
        context,
        mappingId
      );
      return true;
    }
  }
  return false;
}

// Metadata key used in DevFlow messages to track origin
export const BRIDGE_METADATA_KEY = '_teamsBridge';

// --- Bridge Status ---

/**
 * Get the current bridge status.
 */
export async function getBridgeStatus(): Promise<TeamsBridgeStatus> {
  const data = await readBridgeData();
  const errors = await getRecentErrors(5);
  const mappings = data.mappings;
  const activeMappings = mappings.filter((m) => m.syncEnabled);

  // Find most recent sync time
  let lastSyncAt: string | null = null;
  for (const m of mappings) {
    if (m.lastSyncAt && (!lastSyncAt || m.lastSyncAt > lastSyncAt)) {
      lastSyncAt = m.lastSyncAt;
    }
  }

  return {
    configured: isTeamsConfigured(),
    connected: isTeamsConfigured() && !!data.config?.tunnelUrl,
    botRegistered: !!data.config?.botId,
    tunnelUrl: data.config?.tunnelUrl || null,
    syncEnabled: data.config?.syncEnabled ?? false,
    activeMappings: activeMappings.length,
    totalMappings: mappings.length,
    lastSyncAt,
    recentErrors: errors,
  };
}

// --- Outbound: DevFlow -> Teams ---

/**
 * Forward a DevFlow Collab message to the mapped Teams channel.
 * Called when a message is posted in a DevFlow channel that has a Teams mapping.
 *
 * @param devflowChannelId - The DevFlow Collab channel ID
 * @param senderName - Display name of the sender
 * @param content - Message content (text)
 * @param messageId - DevFlow message ID (for tracking)
 * @param metadata - Optional metadata (checked for echo prevention)
 * @param senderInfo - Optional sender metadata for Adaptive Card styling
 */
export async function forwardToTeams(
  devflowChannelId: string,
  senderName: string,
  content: string,
  messageId: string,
  metadata?: Record<string, unknown>,
  senderInfo?: SenderInfo
): Promise<boolean> {
  // Echo prevention: don't forward messages that came from Teams
  if (metadata?.[BRIDGE_METADATA_KEY]) {
    const bridgeMeta = metadata[BRIDGE_METADATA_KEY] as BridgedMessageMetadata;
    if (bridgeMeta.source === 'teams') {
      return false; // This message originated from Teams, don't echo back
    }
  }

  const mapping = await getMappingByDevFlowChannel(devflowChannelId);
  if (!mapping || !mapping.syncEnabled) {
    return false; // No active mapping for this channel
  }

  if (!mapping.conversationReference) {
    const now = Date.now();
    const lastWarned = _noConvRefWarned.get(mapping.id) ?? 0;
    if (now - lastWarned > NO_CONV_REF_WARN_INTERVAL) {
      _noConvRefWarned.set(mapping.id, now);
      console.warn(
        `[Teams Bridge] No ConversationReference for mapping ${mapping.id}. ` +
          'Bot may not be installed in the Teams channel.'
      );
      await logSyncError(
        'No ConversationReference — bot not installed in Teams channel',
        'forwardToTeams',
        mapping.id
      );
    }
    return false;
  }

  // Retry loop for transient failures
  for (let attempt = 0; attempt <= BRIDGE_MAX_RETRIES; attempt++) {
    try {
      await sendProactiveMessage(
        mapping.conversationReference,
        content,
        senderName,
        senderInfo
      );

      // Update cursor
      await updateDevFlowTimestampCursor(
        mapping.id,
        new Date().toISOString()
      );

      console.log(
        `[Teams Bridge] Forwarded message from "${senderName}" to Teams channel: ${mapping.teamsChannelName}`
      );
      return true;
    } catch (err) {
      // Check if channel was deleted — disable mapping to stop future errors
      const wasStale = await handleStaleMapping(mapping.id, err, 'forwardToTeams');
      if (wasStale) return false;

      const errMsg = err instanceof Error ? err.message : String(err);

      if (attempt < BRIDGE_MAX_RETRIES) {
        const delayMs = BRIDGE_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Teams Bridge] Transient error forwarding to Teams (attempt ${attempt + 1}/${BRIDGE_MAX_RETRIES + 1}), retrying in ${delayMs}ms: ${errMsg}`
        );
        await sleep(delayMs);
        continue;
      }

      console.error(`[Teams Bridge] Error forwarding to Teams after ${BRIDGE_MAX_RETRIES + 1} attempts: ${errMsg}`);
      await logSyncError(errMsg, 'forwardToTeams', mapping.id);
      return false;
    }
  }
  return false;
}

// --- Inbound: Teams -> DevFlow ---

/**
 * Download a file attachment from Teams using the Graph API token.
 * Returns a base64 data URL suitable for the collab API images field.
 */
async function downloadTeamsAttachment(
  attachment: TeamsAttachment
): Promise<{ data: string; name: string; type: string; size: number } | null> {
  if (!attachment.contentUrl) {
    console.warn(`[Teams Bridge] No contentUrl for attachment: ${attachment.name}`);
    return null;
  }

  // The Graph token goes only to Microsoft's own hosts: the URL comes from a message, which any channel member can write.
  let host = '';
  try {
    const u = new URL(attachment.contentUrl);
    host = u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch {
    host = '';
  }
  if (!(host === 'graph.microsoft.com' || host.endsWith('.sharepoint.com'))) {
    console.warn(`[Teams Bridge] Attachment not fetched: "${attachment.name}" is not on a Microsoft file host`);
    return null;
  }

  try {
    const token = await getGraphToken();
    const res = await fetch(attachment.contentUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`[Teams Bridge] Failed to download attachment "${attachment.name}": HTTP ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = attachment.contentType || 'application/octet-stream';
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      data: dataUrl,
      name: attachment.name,
      type: mimeType,
      size: buffer.length,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Teams Bridge] Error downloading attachment "${attachment.name}": ${errMsg}`);
    return null;
  }
}

/**
 * Process an incoming Teams message (from Graph API notification)
 * and inject it into the corresponding DevFlow Collab channel.
 *
 * @param teamsChannelId - The Teams channel ID where the message was posted
 * @param teamsMessageId - The Teams message ID
 * @param senderName - Teams user display name
 * @param content - Message content (HTML from Teams, needs conversion)
 * @param timestamp - Message timestamp
 * @param attachments - Optional array of Teams file attachments to download and forward
 */
export async function forwardToDevFlow(
  teamsChannelId: string,
  teamsMessageId: string,
  senderName: string,
  content: string,
  timestamp: string,
  attachments?: TeamsAttachment[]
): Promise<boolean> {
  // Find mapping for this Teams channel
  const allMappings = await getMappings({
    teamsChannelId,
    syncEnabled: true,
  });

  if (allMappings.length === 0) {
    return false; // No mapping for this Teams channel
  }

  const mapping = allMappings[0];

  // Convert HTML to plain text (basic conversion)
  const plainContent = htmlToPlainText(content);

  // Build bridge metadata for echo prevention
  const bridgeMetadata: BridgedMessageMetadata = {
    source: 'teams',
    originalMessageId: teamsMessageId,
    bridgedAt: new Date().toISOString(),
    mappingId: mapping.id,
  };

  // Post to DevFlow Collab channel via internal API
  const devflowApiUrl = `http://localhost:3000/api/collab`;

  // Check if there's an existing participant with the same name (e.g., the signed-in browser user)
  // to avoid creating a duplicate "<name> (Teams)" participant
  let participantId = `teams-${senderName.toLowerCase().replace(/\s+/g, '-')}`;
  let needsJoin = true;

  try {
    const channelRes = await fetch(`${devflowApiUrl}?channelId=${mapping.devflowChannelId}`);
    if (channelRes.ok) {
      const channelData = await channelRes.json();
      const channel = channelData?.channels?.[0];
      if (channel?.participants) {
        // Look for existing participant with matching name (case-insensitive)
        const existingParticipant = channel.participants.find(
          (p: { name?: string; type?: string; id?: string }) =>
            p.name?.toLowerCase() === senderName.toLowerCase() && p.type === 'user'
        );
        // Off unless the owner asks for it (DEVFLOW_BRIDGE_REUSE_PARTICIPANT_BY_NAME=1): anyone in the Teams channel can choose a display
        // name, so a match by name alone would let them post under another person's identity (the owner's, in particular).
        if (existingParticipant && process.env.DEVFLOW_BRIDGE_REUSE_PARTICIPANT_BY_NAME === '1') {
          participantId = existingParticipant.id;
          needsJoin = false; // Already in channel — reuse their identity
        }
      }
    }
  } catch {
    // If channel lookup fails, fall through to default teams-* participant
  }

  if (needsJoin) {
    // Ensure the Teams participant exists in the DevFlow channel
    // (auto-join on first message from this user)
    await fetch(devflowApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        channelId: mapping.devflowChannelId,
        participant: {
          id: participantId,
          name: `${senderName} (Teams)`,
          type: 'user',
        },
      }),
    });
  }

  // Download any attached files from Teams before the retry loop
  // Filter to only file attachments (skip inline images, adaptive cards, etc.)
  let downloadedFiles: Array<{ data: string; name: string; type: string; size: number }> | undefined;
  if (attachments && attachments.length > 0) {
    const fileAttachments = attachments.filter(
      a => a.contentUrl && !a.contentType.startsWith('application/vnd.microsoft.card')
    );
    if (fileAttachments.length > 0) {
      const results = await Promise.all(fileAttachments.map(downloadTeamsAttachment));
      const valid = results.filter(Boolean) as Array<{ data: string; name: string; type: string; size: number }>;
      if (valid.length > 0) {
        downloadedFiles = valid;
        console.log(`[Teams Bridge] Downloaded ${valid.length}/${fileAttachments.length} file(s) from Teams`);
      }
    }
  }

  // Build message content
  const messageContent = plainContent ? `[Teams] ${plainContent}` : downloadedFiles ? '[Teams] [File attachment]' : '[Teams]';

  // Retry loop for transient failures (DevFlow API)
  for (let attempt = 0; attempt <= BRIDGE_MAX_RETRIES; attempt++) {
    try {
      const messageBody: Record<string, unknown> = {
        action: 'message',
        channelId: mapping.devflowChannelId,
        participantId,
        content: messageContent,
        metadata: {
          [BRIDGE_METADATA_KEY]: bridgeMetadata,
        },
      };

      if (downloadedFiles) {
        messageBody.images = downloadedFiles;
      }

      const response = await fetch(devflowApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`${PRODUCT_NAME} API error: ${response.status} ${errText}`);
      }

      // Update cursor
      await updateTeamsMessageCursor(mapping.id, teamsMessageId);

      console.log(
        `[Teams Bridge] Forwarded Teams message from "${senderName}" to DevFlow channel: ${mapping.devflowChannelName}`
      );
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (attempt < BRIDGE_MAX_RETRIES) {
        const delayMs = BRIDGE_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Teams Bridge] Transient error forwarding to ${PRODUCT_NAME} (attempt ${attempt + 1}/${BRIDGE_MAX_RETRIES + 1}), retrying in ${delayMs}ms: ${errMsg}`
        );
        await sleep(delayMs);
        continue;
      }

      console.error(`[Teams Bridge] Error forwarding to DevFlow after ${BRIDGE_MAX_RETRIES + 1} attempts: ${errMsg}`);
      await logSyncError(errMsg, 'forwardToDevFlow', mapping.id);
      return false;
    }
  }
  return false;
}

// --- Notification Handler ---

/**
 * Handle a Graph API change notification for a channel message.
 * Called from the /api/teams-bot/notifications endpoint.
 */
export async function handleNotification(
  notification: GraphNotification
): Promise<void> {
  if (notification.changeType !== 'created') {
    return; // Only handle new messages
  }

  // Extract Teams channel ID from resource path
  // Resource format: /teams({team-id})/channels({channel-id})/messages({message-id})
  const channelMatch = notification.resource.match(
    /channels\('([^']+)'\)/
  );
  if (!channelMatch) {
    console.warn(
      `[Teams Bridge] Could not extract channel ID from resource: ${notification.resource}`
    );
    return;
  }

  const teamsChannelId = channelMatch[1];

  if (notification.resourceData) {
    // Rich notification — message data is inline (encrypted)
    // For now, we'll use the basic notification and fetch the message
    const messageId = notification.resourceData.id;
    // TODO: Decrypt rich notification data using the encryption certificate
    console.log(
      `[Teams Bridge] Rich notification for message ${messageId} in channel ${teamsChannelId}`
    );
  }

  // For basic notifications, we'd need to fetch the message via Graph API
  // This is handled by the sync orchestrator
}

export interface GraphNotification {
  subscriptionId: string;
  changeType: string;
  resource: string;
  resourceData?: {
    id: string;
    '@odata.type': string;
    '@odata.id': string;
  };
  clientState: string;
  tenantId: string;
  subscriptionExpirationDateTime: string;
}

// --- Helpers ---

/**
 * Basic HTML to plain text conversion for Teams messages.
 * Teams sends messages as HTML by default.
 */
function htmlToPlainText(html: string): string {
  return html
    // Remove HTML tags
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Trim
    .trim();
}
