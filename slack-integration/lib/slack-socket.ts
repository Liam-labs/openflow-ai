/**
 * Slack Integration - Inbound Message Poller
 *
 * Polls mapped Slack channels for new messages and forwards them to DevFlow.
 * Uses conversations.history with timestamp cursors to fetch only new messages.
 *
 * This is a lightweight alternative to Socket Mode that requires no extra
 * dependencies (no WebSocket library needed). For higher-frequency use cases,
 * replace with @slack/socket-mode or raw WebSocket to wss://slack.com/link.
 *
 * Start/stop via the exported startPoller() / stopPoller() functions.
 */

import { getMessages, getUserDisplayName } from './slack-api-client';
import { isSlackConfigured } from './slack-auth';
import {
  getMappings,
  getConfig,
  updateSlackTimestampCursor,
  logSyncError,
  readBridgeData,
} from './slack-bridge-data';
import { forwardToDevFlow } from './slack-bridge';
import type { SlackChannelMapping } from './slack-types';

// --- Poller State ---

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

// Per-channel last-seen timestamp (Slack message ts)
const lastSeenTs = new Map<string, string>();

/**
 * Start the inbound message poller.
 * Polls all active Slack channel mappings for new messages.
 */
export async function startPoller(): Promise<void> {
  if (pollerTimer) {
    console.log('[Slack Poller] Already running');
    return;
  }

  if (!isSlackConfigured()) {
    console.warn('[Slack Poller] Slack not configured, cannot start');
    return;
  }

  // Load initial cursors from persisted data
  const data = await readBridgeData();
  const cursors = data.syncState?.lastSlackTimestamp || {};
  for (const [mappingId, ts] of Object.entries(cursors)) {
    if (typeof ts === 'string') {
      lastSeenTs.set(mappingId, ts);
    }
  }

  const config = await getConfig();
  // With Events API active, poller is a fallback safety net.
  // Default to 5 minutes (300s). Minimum 15s if configured lower.
  const intervalMs = Math.max(config?.pollIntervalMs || 300000, 15000);

  console.log(
    `[Slack Poller] Starting with ${intervalMs}ms interval`
  );

  // Delay first poll by 10s to avoid startup burst (especially after rapid restarts)
  setTimeout(() => {
    pollOnce().catch((err) =>
      console.error('[Slack Poller] Initial poll error:', err)
    );
  }, 10000);

  pollerTimer = setInterval(() => {
    if (!isPolling) {
      pollOnce().catch((err) =>
        console.error('[Slack Poller] Poll error:', err)
      );
    }
  }, intervalMs);
}

/**
 * Stop the inbound message poller.
 */
export function stopPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log('[Slack Poller] Stopped');
  }
}

/**
 * Check if the poller is currently running.
 */
export function isPollerRunning(): boolean {
  return pollerTimer !== null;
}

/**
 * Single poll iteration: check all active mappings for new messages.
 */
async function pollOnce(): Promise<void> {
  if (isPolling) {
    console.log('[Slack Poller] Skipping (already polling)');
    return;
  }
  isPolling = true;

  try {
    const mappings = await getMappings({ syncEnabled: true });
    console.log(`[Slack Poller] Poll cycle: ${mappings.length} active mappings`);
    if (mappings.length === 0) return;

    const config = await getConfig();
    const botUserId = config?.botUserId || '';

    // Poll channels in parallel batches of 5 to reduce latency while
    // staying within Slack's Tier 3 rate limit (~50 calls/min).
    // With 13 channels: 3 batches × ~1s API call = ~3s instead of ~13s sequential.
    const BATCH_SIZE = 5;
    for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
      const batch = mappings.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(m => pollChannel(m, botUserId)));
      // Small pause between batches to avoid burst rate limiting
      if (i + BATCH_SIZE < mappings.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack Poller] Error in pollOnce: ${errMsg}`);
  } finally {
    isPolling = false;
  }
}

/**
 * Poll a single Slack channel for new messages.
 */
async function pollChannel(
  mapping: SlackChannelMapping,
  botUserId: string
): Promise<void> {
  try {
    // Get cursor for this mapping (last seen Slack message timestamp)
    const oldest = lastSeenTs.get(mapping.id);

    const { messages } = await getMessages(mapping.slackChannelId, {
      oldest,
      limit: 20,
    });

    if (messages.length === 0) return;

    console.log(`[Slack Poller] ${mapping.slackChannelName}: ${messages.length} msgs (cursor: ${oldest || 'none'})`);

    // Messages come newest-first — reverse for chronological processing
    const chronological = [...messages].reverse();

    // Track the newest timestamp we've seen
    let newestTs = oldest || '0';
    let forwarded = 0;

    for (const msg of chronological) {
      // Skip messages we've already processed (oldest is exclusive in Slack API,
      // but belt-and-suspenders check)
      if (oldest && msg.ts <= oldest) continue;

      // Skip bot's own messages
      if (msg.user === botUserId || msg.bot_id) {
        // Update newestTs even for skipped bot messages to advance the cursor
        if (msg.ts > newestTs) newestTs = msg.ts;
        continue;
      }

      // Skip message subtypes (joins, leaves, topic changes, etc.)
      // Only process regular messages and file_share
      if (msg.subtype && msg.subtype !== 'file_share') {
        if (msg.ts > newestTs) newestTs = msg.ts;
        continue;
      }

      // Skip empty messages
      if (!msg.text && msg.subtype !== 'file_share') {
        if (msg.ts > newestTs) newestTs = msg.ts;
        continue;
      }

      // Resolve sender display name
      const senderName = msg.user
        ? await getUserDisplayName(msg.user)
        : 'Unknown';

      console.log(`[Slack Poller] Forwarding: "${(msg.text || '').slice(0, 50)}" from ${senderName} (files: ${msg.files?.length || 0})`);

      // Forward to DevFlow (include files for file_share messages)
      await forwardToDevFlow(
        mapping.slackChannelId,
        msg.ts,
        senderName,
        msg.text || '(file shared)',
        botUserId,
        msg.user || '',
        msg.files
      );

      forwarded++;

      // Update newest seen
      if (msg.ts > newestTs) {
        newestTs = msg.ts;
      }
    }

    // Persist cursor if we processed new messages
    if (newestTs !== (oldest || '0')) {
      lastSeenTs.set(mapping.id, newestTs);
      await updateSlackTimestampCursor(mapping.id, newestTs);
      if (forwarded > 0) {
        console.log(`[Slack Poller] ${mapping.slackChannelName}: forwarded ${forwarded} msgs, cursor → ${newestTs}`);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[Slack Poller] Error polling channel ${mapping.slackChannelName}: ${errMsg}`
    );
    await logSyncError(
      errMsg,
      'pollChannel',
      mapping.id
    );
  }
}

/**
 * Get poller status for monitoring.
 */
export function getPollerStatus(): {
  running: boolean;
  trackedChannels: number;
  cursors: Record<string, string>;
} {
  const cursors: Record<string, string> = {};
  for (const [id, ts] of lastSeenTs.entries()) {
    cursors[id] = ts;
  }

  return {
    running: pollerTimer !== null,
    trackedChannels: lastSeenTs.size,
    cursors,
  };
}
