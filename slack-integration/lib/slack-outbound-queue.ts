/**
 * Slack Outbound Message Queue
 *
 * Persistent queue for Slack messages that failed to deliver.
 * Messages are stored on disk and retried periodically or on startup.
 *
 * Flow:
 * 1. forwardToSlack() fails -> message enqueued here
 * 2. On server startup -> drainQueue() processes pending messages
 * 3. Periodic retry timer -> retries messages every 30s
 * 4. After max retries -> message moved to dead letter (logged + removed)
 */

import { readJsonFile, writeJsonFile } from '../../lib/data-io';
import { getDevflowHome } from '../../lib/home-dir';
import type { SlackSenderInfo } from './slack-bridge';

// --- Queue Types ---

export interface QueuedMessage {
  id: string;
  devflowChannelId: string;
  senderName: string;
  content: string;
  messageId: string;
  metadata?: Record<string, unknown>;
  senderInfo?: SlackSenderInfo;
  /** Images are NOT queued (too large for disk). Only text is retried. */
  enqueuedAt: string;
  retryCount: number;
  lastRetryAt?: string;
  lastError?: string;
}

interface QueueData {
  pending: QueuedMessage[];
  stats: {
    totalEnqueued: number;
    totalDelivered: number;
    totalDropped: number;
    lastDrainAt?: string;
  };
}

// --- Config ---

const QUEUE_FILE = `${getDevflowHome()}/data/slack-outbound-queue.json`;
const MAX_RETRIES = 10;
const RETRY_INTERVAL_MS = 30_000; // 30 seconds
const MAX_QUEUE_SIZE = 200; // Prevent unbounded growth

// --- State ---

let retryTimer: ReturnType<typeof setInterval> | null = null;
let isDraining = false;

// --- Queue Operations ---

async function readQueue(): Promise<QueueData> {
  return readJsonFile<QueueData>(QUEUE_FILE, {
    pending: [],
    stats: { totalEnqueued: 0, totalDelivered: 0, totalDropped: 0 },
  });
}

async function writeQueue(data: QueueData): Promise<void> {
  await writeJsonFile(QUEUE_FILE, data);
}

/**
 * Add a failed message to the retry queue.
 */
export async function enqueue(
  devflowChannelId: string,
  senderName: string,
  content: string,
  messageId: string,
  metadata?: Record<string, unknown>,
  senderInfo?: SlackSenderInfo,
  error?: string
): Promise<void> {
  try {
    const data = await readQueue();

    // Prevent duplicate enqueuing (same messageId)
    if (data.pending.some((m) => m.messageId === messageId)) {
      return;
    }

    // Enforce max queue size (drop oldest if full)
    if (data.pending.length >= MAX_QUEUE_SIZE) {
      const dropped = data.pending.shift();
      if (dropped) {
        data.stats.totalDropped++;
        console.warn(
          `[Slack Queue] Queue full (${MAX_QUEUE_SIZE}), dropped oldest message: ${dropped.messageId}`
        );
      }
    }

    const entry: QueuedMessage = {
      id: crypto.randomUUID(),
      devflowChannelId,
      senderName,
      content,
      messageId,
      metadata,
      senderInfo,
      enqueuedAt: new Date().toISOString(),
      retryCount: 0,
      lastError: error,
    };

    data.pending.push(entry);
    data.stats.totalEnqueued++;

    await writeQueue(data);
    console.log(
      `[Slack Queue] Enqueued message ${messageId} from "${senderName}" (queue size: ${data.pending.length})`
    );
  } catch (err) {
    console.error(
      '[Slack Queue] Failed to enqueue message:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Drain the queue: retry all pending messages.
 * Called on startup and periodically.
 */
export async function drainQueue(): Promise<{
  delivered: number;
  failed: number;
  dropped: number;
}> {
  if (isDraining) {
    return { delivered: 0, failed: 0, dropped: 0 };
  }
  isDraining = true;

  let delivered = 0;
  let failed = 0;
  let dropped = 0;

  try {
    const data = await readQueue();

    if (data.pending.length === 0) {
      return { delivered: 0, failed: 0, dropped: 0 };
    }

    console.log(
      `[Slack Queue] Draining ${data.pending.length} pending message(s)...`
    );

    // Import forwardToSlack dynamically to avoid circular dependency
    const { forwardToSlackDirect } = await import('./slack-bridge');

    const remaining: QueuedMessage[] = [];

    for (const msg of data.pending) {
      try {
        const success = await forwardToSlackDirect(
          msg.devflowChannelId,
          msg.senderName,
          msg.content,
          msg.messageId,
          msg.metadata,
          msg.senderInfo
        );

        if (success) {
          delivered++;
          data.stats.totalDelivered++;
          console.log(
            `[Slack Queue] Delivered queued message ${msg.messageId} from "${msg.senderName}" (was retry #${msg.retryCount})`
          );
        } else {
          // forwardToSlack returned false (no mapping, echo prevention, etc.)
          // This is a permanent failure — don't retry
          dropped++;
          data.stats.totalDropped++;
          console.log(
            `[Slack Queue] Dropped message ${msg.messageId} — no valid mapping or echo prevented`
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        msg.retryCount++;
        msg.lastRetryAt = new Date().toISOString();
        msg.lastError = errMsg;

        if (msg.retryCount >= MAX_RETRIES) {
          dropped++;
          data.stats.totalDropped++;
          console.warn(
            `[Slack Queue] Dropped message ${msg.messageId} after ${MAX_RETRIES} retries: ${errMsg}`
          );
        } else {
          remaining.push(msg);
          failed++;
        }
      }
    }

    data.pending = remaining;
    data.stats.lastDrainAt = new Date().toISOString();
    await writeQueue(data);

    if (delivered > 0 || dropped > 0) {
      console.log(
        `[Slack Queue] Drain complete: ${delivered} delivered, ${failed} pending retry, ${dropped} dropped`
      );
    }

    return { delivered, failed, dropped };
  } catch (err) {
    console.error(
      '[Slack Queue] Drain error:',
      err instanceof Error ? err.message : err
    );
    return { delivered, failed, dropped };
  } finally {
    isDraining = false;
  }
}

/**
 * Start the periodic retry timer.
 */
export function startRetryTimer(): void {
  if (retryTimer) {
    return;
  }

  // Initial drain after 15s (give Slack API time to stabilize after startup)
  setTimeout(() => {
    drainQueue().catch((err) =>
      console.error('[Slack Queue] Initial drain error:', err)
    );
  }, 15_000);

  retryTimer = setInterval(() => {
    drainQueue().catch((err) =>
      console.error('[Slack Queue] Periodic drain error:', err)
    );
  }, RETRY_INTERVAL_MS);

  console.log(
    `[Slack Queue] Retry timer started (${RETRY_INTERVAL_MS / 1000}s interval)`
  );
}

/**
 * Stop the periodic retry timer.
 */
export function stopRetryTimer(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/**
 * Get queue status for monitoring.
 */
export async function getQueueStatus(): Promise<{
  pendingCount: number;
  stats: QueueData['stats'];
  oldestPending?: string;
}> {
  const data = await readQueue();
  return {
    pendingCount: data.pending.length,
    stats: data.stats,
    oldestPending: data.pending[0]?.enqueuedAt,
  };
}
