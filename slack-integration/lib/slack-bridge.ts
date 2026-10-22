/**
 * Slack Integration - Bridge Service
 *
 * Orchestrates bidirectional message sync between DevFlow Collab and Slack.
 *
 * Outbound (DevFlow -> Slack): Hooks into collab message creation,
 * forwards to mapped Slack channel via chat.postMessage.
 *
 * Inbound (Slack -> DevFlow): Receives events via Socket Mode or Events API,
 * injects messages into DevFlow Collab channels.
 *
 * Echo prevention: Messages carry origin metadata to prevent infinite loops.
 */

import {
  getMappings,
  getMappingByDevFlowChannel,
  getMappingBySlackChannel,
  logSyncError,
  updateSlackTimestampCursor,
  updateDevFlowTimestampCursor,
  updateMapping,
  readBridgeData,
  getRecentErrors,
} from './slack-bridge-data';
import { isSlackConfigured, getBotToken } from './slack-auth';
import { getUserDisplayName } from './slack-api-client';
import type { SlackBridgeStatus, BridgedMessageMetadata } from './slack-types';
import { PRODUCT_NAME } from '@/lib/brand';

// --- Retry helpers ---

const BRIDGE_MAX_RETRIES = 2;
const BRIDGE_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Slack API Error ---

export class SlackApiError extends Error {
  constructor(
    message: string,
    public readonly slackError: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

/**
 * Check if a Slack API error indicates the channel no longer exists or is inaccessible.
 * Disables the mapping to prevent repeated failures.
 */
async function handleStaleMapping(
  mappingId: string,
  err: unknown,
  context: string
): Promise<boolean> {
  if (err instanceof SlackApiError) {
    // channel_not_found = deleted/archived, not_in_channel = bot removed
    if (
      err.slackError === 'channel_not_found' ||
      err.slackError === 'is_archived'
    ) {
      console.warn(
        `[Slack Bridge] Channel no longer accessible for mapping ${mappingId}. Disabling sync.`
      );
      await updateMapping(mappingId, { syncEnabled: false });
      await logSyncError(
        `Channel ${err.slackError} — sync disabled automatically. Re-enable after fixing the mapping.`,
        context,
        mappingId
      );
      return true;
    }
  }
  return false;
}

// Metadata key used in DevFlow messages to track origin
export const BRIDGE_METADATA_KEY = '_slackBridge';

// --- Bridge Status ---

/**
 * Get the current bridge status.
 */
export async function getBridgeStatus(): Promise<SlackBridgeStatus> {
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
    configured: isSlackConfigured(),
    connected: isSlackConfigured() && !!data.config?.botUserId,
    botRegistered: !!data.config?.botUserId,
    syncEnabled: data.config?.syncEnabled ?? false,
    activeMappings: activeMappings.length,
    totalMappings: mappings.length,
    lastSyncAt,
    recentErrors: errors,
  };
}

// --- Outbound: DevFlow -> Slack ---

// --- Sender styling for Slack messages ---

export interface SlackSenderInfo {
  color?: string;      // Hex color (e.g. '#7c3aed') — used for attachment sidebar
  type?: string;       // Participant type (e.g. 'claude-agent', 'user')
  roleName?: string;   // Agent role (e.g. 'Backend Dev', 'Team Lead')
}

// Map DevFlow color names/hex to Slack emoji icons for visual distinction
const COLOR_EMOJI_MAP: Record<string, string> = {
  '#7c3aed': ':purple_circle:',   // purple
  '#2563eb': ':large_blue_circle:', // blue
  '#059669': ':green_circle:',     // green (emerald)
  '#d97706': ':orange_circle:',    // amber/orange
  '#dc2626': ':red_circle:',       // red
  '#db2777': ':heart:',            // pink
  '#0891b2': ':diamond_shape_with_a_dot_inside:', // cyan/teal
  '#4f46e5': ':large_blue_diamond:', // indigo
  '#65a30d': ':four_leaf_clover:', // lime
  '#ea580c': ':fire:',             // orange-red
};

function getEmojiForColor(color?: string): string {
  if (!color) return ':robot_face:';
  return COLOR_EMOJI_MAP[color.toLowerCase()] || ':robot_face:';
}

/**
 * Post a message to a Slack channel via chat.postMessage.
 * Uses colored attachment sidebar and per-agent emoji icons.
 * Throws SlackApiError on failure.
 */
async function postSlackMessage(
  channelId: string,
  text: string,
  username?: string,
  senderInfo?: SlackSenderInfo
): Promise<string> {
  const token = getBotToken();

  const body: Record<string, unknown> = {
    channel: channelId,
  };

  // Use username override if provided (requires chat:write.customize scope)
  if (username) {
    // Add role badge to username if available
    body.username = senderInfo?.roleName
      ? `${username} [${senderInfo.roleName}]`
      : username;
    body.icon_emoji = getEmojiForColor(senderInfo?.color);
  }

  // Use colored attachment sidebar for agent messages
  if (senderInfo?.color && senderInfo?.type !== 'user') {
    body.attachments = [
      {
        color: senderInfo.color,
        text,
        // Slack renders attachment text with mrkdwn by default
      },
    ];
  } else {
    body.text = text;
  }

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new SlackApiError(
      `Slack API HTTP error: ${res.status}`,
      'http_error',
      res.status
    );
  }

  const data = await res.json() as {
    ok: boolean;
    error?: string;
    ts?: string;
  };

  if (!data.ok) {
    throw new SlackApiError(
      `Slack API error: ${data.error}`,
      data.error || 'unknown_error'
    );
  }

  return data.ts || '';
}

/**
 * Direct Slack forwarding — the core delivery logic.
 * Used by both the primary forwardToSlack() and the retry queue drainer.
 * Does NOT enqueue on failure (that's forwardToSlack's job).
 *
 * Returns true if delivered, false for permanent failures (no mapping, echo, etc.).
 * Throws on transient failures (network errors, rate limits) after retries.
 */
export async function forwardToSlackDirect(
  devflowChannelId: string,
  senderName: string,
  content: string,
  messageId: string,
  metadata?: Record<string, unknown>,
  senderInfo?: SlackSenderInfo,
  images?: Array<{ data: string; name: string; type: string }>
): Promise<boolean> {
  // Echo prevention: don't forward messages that came from Slack
  if (metadata?.[BRIDGE_METADATA_KEY]) {
    const bridgeMeta = metadata[BRIDGE_METADATA_KEY] as BridgedMessageMetadata;
    if (bridgeMeta.source === 'slack') {
      return false; // This message originated from Slack, don't echo back
    }
  }

  const mapping = await getMappingByDevFlowChannel(devflowChannelId);
  if (!mapping || !mapping.syncEnabled) {
    return false; // No active mapping for this channel
  }

  if (!mapping.botInChannel) {
    console.warn(
      `[Slack Bridge] Bot not in Slack channel for mapping ${mapping.id}. ` +
        'Bot may need to be invited to the channel.'
    );
    await logSyncError(
      'Bot not in Slack channel — invite the bot first',
      'forwardToSlack',
      mapping.id
    );
    return false;
  }

  // Retry loop for transient failures
  for (let attempt = 0; attempt <= BRIDGE_MAX_RETRIES; attempt++) {
    try {
      const slackTs = await postSlackMessage(
        mapping.slackChannelId,
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
        `[Slack Bridge] Forwarded message from "${senderName}" to Slack channel: #${mapping.slackChannelName} (ts: ${slackTs})`
      );

      // Upload images if present (fire-and-forget per image)
      if (images && images.length > 0) {
        try {
          const { uploadFile } = await import('./slack-api-client');
          for (const img of images) {
            try {
              // Convert base64 data URL to Buffer
              const base64Match = img.data.match(/^data:[^;]+;base64,(.+)$/);
              if (!base64Match) continue;
              const buffer = Buffer.from(base64Match[1], 'base64');
              await uploadFile(mapping.slackChannelId, buffer, img.name, {
                title: img.name,
              });
              console.log(`[Slack Bridge] Uploaded image "${img.name}" to #${mapping.slackChannelName}`);
            } catch (imgErr) {
              console.warn(
                `[Slack Bridge] Failed to upload image "${img.name}":`,
                imgErr instanceof Error ? imgErr.message : imgErr
              );
            }
          }
        } catch {
          // uploadFile import failed — files:write scope may not be available
        }
      }

      return true;
    } catch (err) {
      // Check if channel was deleted/archived — disable mapping
      const wasStale = await handleStaleMapping(mapping.id, err, 'forwardToSlack');
      if (wasStale) return false;

      // Check if bot was removed from channel
      if (err instanceof SlackApiError && err.slackError === 'not_in_channel') {
        await updateMapping(mapping.id, { botInChannel: false });
        await logSyncError(
          'Bot removed from Slack channel — invite the bot to resume sync',
          'forwardToSlack',
          mapping.id
        );
        return false;
      }

      const errMsg = err instanceof Error ? err.message : String(err);

      if (attempt < BRIDGE_MAX_RETRIES) {
        const delayMs = BRIDGE_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Slack Bridge] Transient error forwarding to Slack (attempt ${attempt + 1}/${BRIDGE_MAX_RETRIES + 1}), retrying in ${delayMs}ms: ${errMsg}`
        );
        await sleep(delayMs);
        continue;
      }

      // All retries exhausted — throw so caller can decide (enqueue or drop)
      throw err;
    }
  }
  return false;
}

/**
 * Forward a DevFlow Collab message to the mapped Slack channel.
 * On transient failure (after retries), enqueues the message for later delivery.
 *
 * @param devflowChannelId - The DevFlow Collab channel ID
 * @param senderName - Display name of the sender
 * @param content - Message content (text)
 * @param messageId - DevFlow message ID (for tracking)
 * @param metadata - Optional metadata (checked for echo prevention)
 * @param senderInfo - Optional sender styling (color, type, role)
 * @param images - Optional images to upload to Slack (base64 data URLs)
 */
export async function forwardToSlack(
  devflowChannelId: string,
  senderName: string,
  content: string,
  messageId: string,
  metadata?: Record<string, unknown>,
  senderInfo?: SlackSenderInfo,
  images?: Array<{ data: string; name: string; type: string }>
): Promise<boolean> {
  try {
    return await forwardToSlackDirect(
      devflowChannelId,
      senderName,
      content,
      messageId,
      metadata,
      senderInfo,
      images
    );
  } catch (err) {
    // Transient failure after retries — enqueue for later delivery
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[Slack Bridge] Error forwarding to Slack after retries, enqueueing: ${errMsg}`
    );
    await logSyncError(errMsg, 'forwardToSlack (enqueued for retry)', devflowChannelId);

    try {
      const { enqueue } = await import('./slack-outbound-queue');
      await enqueue(
        devflowChannelId,
        senderName,
        content,
        messageId,
        metadata,
        senderInfo,
        errMsg
      );
    } catch (queueErr) {
      console.error(
        '[Slack Bridge] Failed to enqueue message:',
        queueErr instanceof Error ? queueErr.message : queueErr
      );
    }

    return false;
  }
}

// --- Inbound: Slack -> DevFlow ---

/**
 * Download a file from Slack using the bot token for auth.
 * Returns a base64 data URL suitable for the collab API images field.
 */
async function downloadSlackFile(
  file: SlackFile
): Promise<{ data: string; name: string; type: string; size: number } | null> {
  const downloadUrl = file.url_private_download || file.url_private;
  if (!downloadUrl) {
    console.warn(`[Slack Bridge] No download URL for file: ${file.name}`);
    return null;
  }

  const token = getBotToken();

  // The bot token goes only to Slack's own file host.
  let host = '';
  try {
    const u = new URL(downloadUrl);
    host = u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch {
    host = '';
  }
  if (host !== 'files.slack.com') {
    console.warn(`[Slack Bridge] File not downloaded: "${file.name}" is not on files.slack.com`);
    return null;
  }

  try {
    const res = await fetch(downloadUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`[Slack Bridge] Failed to download file "${file.name}": HTTP ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString('base64');
    const mimeType = file.mimetype || 'application/octet-stream';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      data: dataUrl,
      name: file.name,
      type: mimeType,
      size: file.size,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack Bridge] Error downloading file "${file.name}": ${errMsg}`);
    return null;
  }
}

/**
 * Process an incoming Slack message and inject it into the corresponding
 * DevFlow Collab channel.
 *
 * @param slackChannelId - The Slack channel ID where the message was posted
 * @param slackMessageTs - The Slack message timestamp (used as message ID)
 * @param senderName - Slack user display name
 * @param content - Message content (plain text from Slack)
 * @param botUserId - The bot's own user ID (to skip bot's own messages)
 * @param senderUserId - The Slack user ID of the message sender
 * @param files - Optional array of Slack file attachments to download and forward
 */
export async function forwardToDevFlow(
  slackChannelId: string,
  slackMessageTs: string,
  senderName: string,
  content: string,
  botUserId: string,
  senderUserId: string,
  files?: SlackFile[]
): Promise<boolean> {
  // Skip messages from the bot itself (prevents echo of outbound messages)
  if (senderUserId === botUserId) {
    return false;
  }

  // Dedup: prevent same message from being processed by both webhook and poller
  if (isInboundDuplicate(slackChannelId, slackMessageTs)) {
    return false;
  }

  // Find mapping for this Slack channel
  const mapping = await getMappingBySlackChannel(slackChannelId);
  if (!mapping) {
    return false; // No mapping for this Slack channel
  }

  // Build bridge metadata for echo prevention
  const bridgeMetadata: BridgedMessageMetadata = {
    source: 'slack',
    originalMessageId: slackMessageTs,
    bridgedAt: new Date().toISOString(),
    mappingId: mapping.id,
  };

  // Post to DevFlow Collab channel via internal API
  const devflowApiUrl = 'http://localhost:3000/api/collab';

  // Check if there's an existing participant with the same name
  // to avoid creating a duplicate "User (Slack)" participant
  let participantId = `slack-${senderName.toLowerCase().replace(/\s+/g, '-')}`;
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
        // Off unless the owner asks for it (DEVFLOW_BRIDGE_REUSE_PARTICIPANT_BY_NAME=1): anyone in the Slack channel can choose a display
        // name, so a match by name alone would let them post under another person's identity (the owner's, in particular).
        if (existingParticipant && process.env.DEVFLOW_BRIDGE_REUSE_PARTICIPANT_BY_NAME === '1') {
          participantId = existingParticipant.id;
          needsJoin = false; // Already in channel — reuse their identity
        }
      }
    }
  } catch {
    // If channel lookup fails, fall through to default slack-* participant
  }

  if (needsJoin) {
    // Ensure the Slack participant exists in the DevFlow channel
    // (auto-join on first message from this user)
    await fetch(devflowApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        channelId: mapping.devflowChannelId,
        participant: {
          id: participantId,
          name: `${senderName} (Slack)`,
          type: 'user',
        },
      }),
    });
  }

  // Download any attached files from Slack before the retry loop
  let downloadedFiles: Array<{ data: string; name: string; type: string; size: number }> | undefined;
  if (files && files.length > 0) {
    const results = await Promise.all(files.map(downloadSlackFile));
    const valid = results.filter(Boolean) as Array<{ data: string; name: string; type: string; size: number }>;
    if (valid.length > 0) {
      downloadedFiles = valid;
      console.log(`[Slack Bridge] Downloaded ${valid.length}/${files.length} file(s) from Slack`);
    }
  }

  // Build message body
  const messageContent = content ? `[Slack] ${content}` : downloadedFiles ? '[Slack] [File attachment]' : '[Slack]';

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
      await updateSlackTimestampCursor(mapping.id, slackMessageTs);

      console.log(
        `[Slack Bridge] Forwarded Slack message from "${senderName}" to DevFlow channel: ${mapping.devflowChannelName}`
      );
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (attempt < BRIDGE_MAX_RETRIES) {
        const delayMs = BRIDGE_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Slack Bridge] Transient error forwarding to ${PRODUCT_NAME} (attempt ${attempt + 1}/${BRIDGE_MAX_RETRIES + 1}), retrying in ${delayMs}ms: ${errMsg}`
        );
        await sleep(delayMs);
        continue;
      }

      console.error(`[Slack Bridge] Error forwarding to DevFlow after ${BRIDGE_MAX_RETRIES + 1} attempts: ${errMsg}`);
      await logSyncError(errMsg, 'forwardToDevFlow', mapping.id);
      return false;
    }
  }
  return false;
}

// --- Socket Mode Event Handler (stub) ---

/**
 * Handle a Slack event from Events API webhook or poller.
 * This is the entry point for inbound messages.
 * Both paths converge here — dedup prevents double-processing.
 *
 * @param event - Slack event payload
 */

// Shared dedup for inbound Slack messages.
// Uses globalThis to ensure a single Map shared between the Events API webhook
// and the poller (which may run in different module instances in Next.js).
// Key: "channelId:messageTs" — unique per Slack message.
const INBOUND_DEDUP_WINDOW_MS = 120_000; // 2 minutes

// Attach to globalThis so all module instances share the same Map
const _global = globalThis as typeof globalThis & {
  __slackInboundDedup?: Map<string, number>;
};
if (!_global.__slackInboundDedup) {
  _global.__slackInboundDedup = new Map<string, number>();
}
const processedInboundMessages = _global.__slackInboundDedup;

function isInboundDuplicate(channelId: string, ts: string): boolean {
  const key = `${channelId}:${ts}`;
  const now = Date.now();

  // Prune old entries
  if (processedInboundMessages.size > 1000) {
    processedInboundMessages.forEach((time, k) => {
      if (now - time > INBOUND_DEDUP_WINDOW_MS) {
        processedInboundMessages.delete(k);
      }
    });
  }

  if (processedInboundMessages.has(key)) {
    return true;
  }

  processedInboundMessages.set(key, now);
  return false;
}

export async function handleSlackEvent(
  event: SlackMessageEvent
): Promise<void> {
  // Only handle new messages (not edits, deletes, or bot messages)
  if (event.subtype && event.subtype !== 'file_share') {
    return;
  }

  // Skip bot messages explicitly (belt-and-suspenders with forwardToDevFlow check)
  if (event.bot_id) {
    return;
  }

  const config = (await readBridgeData()).config;
  const botUserId = config?.botUserId || '';

  // Resolve user display name (Events API only provides user ID, not name)
  let displayName = event.user_name || event.user || 'Unknown';
  if (event.user && !event.user_name) {
    try {
      displayName = await getUserDisplayName(event.user);
    } catch {
      // Fallback to raw user ID
    }
  }

  await forwardToDevFlow(
    event.channel,
    event.ts,
    displayName,
    event.text || '',
    botUserId,
    event.user || '',
    event.files
  );
}

// --- Slack Event Types ---

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private?: string;
  url_private_download?: string;
  filetype?: string;
}

export interface SlackMessageEvent {
  type: 'message';
  subtype?: string;
  channel: string;
  user?: string;
  user_name?: string;
  text?: string;
  ts: string;
  bot_id?: string;
  team?: string;
  files?: SlackFile[];
}

// --- Helpers ---

/**
 * Convert Slack mrkdwn to plain text.
 * Slack uses its own markdown-like formatting.
 */
export function slackMrkdwnToPlainText(mrkdwn: string): string {
  return mrkdwn
    // Convert user mentions <@U1234> to @user
    .replace(/<@(\w+)>/g, '@$1')
    // Convert channel mentions <#C1234|channel-name> to #channel-name
    .replace(/<#\w+\|([^>]+)>/g, '#$1')
    // Convert URLs <http://url|display> to display (or url)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // Remove bold/italic markers
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~([^~]+)~/g, '$1')
    // Decode HTML entities (Slack sometimes encodes these)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}
