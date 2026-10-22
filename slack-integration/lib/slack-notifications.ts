/**
 * Slack Integration - Event-Driven Notifications
 *
 * Subscribes to the DevFlow SSE event bus and forwards key events
 * to a configured Slack notification channel as compact Block Kit cards.
 *
 * Events handled:
 * - health:status — state transitions (online->offline, offline->online)
 * - sessions:change — agent online/offline
 * - collab:sprint — sprint activated/completed
 * - collab:task — task completions (batched)
 *
 * Includes throttling and deduplication to prevent notification floods.
 */

import { getConfig } from './slack-bridge-data';
import { isSlackConfigured } from './slack-auth';
import { postBlockKitMessage } from './slack-rich-messages';
import { buildNotificationCard } from './slack-block-kit';
import { PRODUCT_NAME } from '@/lib/brand';

// Re-export for backward compatibility (was previously exported from this file)
export { handleSlackEvent } from './slack-bridge';
export type { SlackMessageEvent } from './slack-bridge';

// --- Throttling ---

/** Fingerprint -> last notification timestamp */
const notificationHistory = new Map<string, number>();

/** Minimum interval between identical notifications (ms) */
const DEDUP_INTERVAL_MS = 30_000; // 30 seconds

/** Batch window for task completions */
const TASK_BATCH_WINDOW_MS = 30_000; // 30 seconds
let taskBatchTimer: ReturnType<typeof setTimeout> | null = null;
let taskBatchItems: Array<{ taskTitle: string; phaseName?: string }> = [];
let taskBatchChannelId: string | null = null;

/** Batch window for session changes */
const SESSION_BATCH_WINDOW_MS = 5_000; // 5 seconds
let sessionBatchTimer: ReturnType<typeof setTimeout> | null = null;
let sessionBatchItems: Array<{ name: string; action: 'online' | 'offline' }> = [];
let sessionBatchChannelId: string | null = null;

// Track previous health status for transition detection
let previousHealthFingerprint: string | null = null;

// Track previous session count for change detection
let previousSessionCount: number | null = null;

/**
 * Check if a notification with this fingerprint was recently sent.
 */
function shouldThrottle(fingerprint: string): boolean {
  const lastSent = notificationHistory.get(fingerprint);
  if (lastSent && Date.now() - lastSent < DEDUP_INTERVAL_MS) {
    return true;
  }
  notificationHistory.set(fingerprint, Date.now());
  return false;
}

/**
 * Get the notification channel ID from config.
 * Returns null if notifications are disabled or not configured.
 */
async function getNotificationTarget(): Promise<string | null> {
  if (!isSlackConfigured()) return null;

  const config = await getConfig();
  if (!config?.notificationsEnabled || !config.notificationChannelId) {
    return null;
  }

  return config.notificationChannelId;
}

/**
 * Check if a specific event type is enabled for notifications.
 */
async function isEventEnabled(eventType: string): Promise<boolean> {
  const config = await getConfig();
  // If no specific events configured, all are enabled
  if (!config?.notificationEvents || config.notificationEvents.length === 0) {
    return true;
  }
  return config.notificationEvents.includes(eventType);
}

// --- Event Handlers ---

/**
 * Handle health:status events.
 * Only notify on state transitions (project going offline or coming back online).
 */
async function handleHealthStatus(data: unknown): Promise<void> {
  if (!await isEventEnabled('health:status')) return;

  const channelId = await getNotificationTarget();
  if (!channelId) return;

  const payload = data as {
    statuses: Record<string, {
      projectId: string;
      overallStatus: string;
      checks: Array<{ label: string; status: string }>;
    }>;
  };

  if (!payload?.statuses) return;

  // Build fingerprint from current status
  const fingerprint = Object.entries(payload.statuses)
    .map(([id, s]) => `${id}:${s.overallStatus}`)
    .sort()
    .join('|');

  // Only notify on transitions
  if (fingerprint === previousHealthFingerprint) return;

  const oldFingerprint = previousHealthFingerprint;
  previousHealthFingerprint = fingerprint;

  // Skip first run (no previous state to compare)
  if (!oldFingerprint) return;

  // Parse old statuses for comparison
  const oldStatuses = new Map<string, string>();
  for (const pair of oldFingerprint.split('|')) {
    const [id, status] = pair.split(':');
    oldStatuses.set(id, status);
  }

  // Find transitions
  const transitions: Array<{ projectId: string; from: string; to: string }> = [];
  for (const [projectId, status] of Object.entries(payload.statuses)) {
    const oldStatus = oldStatuses.get(projectId);
    if (oldStatus && oldStatus !== status.overallStatus) {
      transitions.push({ projectId, from: oldStatus, to: status.overallStatus });
    }
  }

  if (transitions.length === 0) return;

  // Build notification for transitions
  for (const t of transitions) {
    const throttleKey = `health:${t.projectId}:${t.to}`;
    if (shouldThrottle(throttleKey)) continue;

    const emoji = t.to === 'online' ? '🟢' : t.to === 'offline' ? '🔴' : '🟡';
    const title = `${t.projectId} is now ${t.to}`;
    const details = `Status changed from *${t.from}* to *${t.to}*`;

    const blocks = buildNotificationCard(title, emoji, details);
    await postBlockKitMessage(channelId, blocks, `${emoji} ${title}`, {
      username: `${PRODUCT_NAME} Health`,
      iconEmoji: ':hospital:',
    }).catch(err => console.error('[Slack Notifications] Health notification error:', err));
  }
}

/**
 * Handle sessions:change events.
 * Batch notifications about agent online/offline changes.
 */
async function handleSessionsChange(data: unknown): Promise<void> {
  if (!await isEventEnabled('sessions:change')) return;

  const channelId = await getNotificationTarget();
  if (!channelId) return;

  const payload = data as {
    sessions: Array<{ pid: number; name: string }>;
    sessionCount: number;
  };

  if (!payload?.sessions) return;

  // Detect changes from previous count
  const currentCount = payload.sessionCount;
  if (previousSessionCount === null) {
    previousSessionCount = currentCount;
    return; // Skip first run
  }

  if (currentCount === previousSessionCount) return;

  const diff = currentCount - previousSessionCount;
  previousSessionCount = currentCount;

  // Add to batch
  sessionBatchItems.push({
    name: diff > 0 ? `${diff} agent(s)` : `${Math.abs(diff)} agent(s)`,
    action: diff > 0 ? 'online' : 'offline',
  });
  sessionBatchChannelId = channelId;

  // Set batch timer if not already running
  if (!sessionBatchTimer) {
    sessionBatchTimer = setTimeout(async () => {
      const items = [...sessionBatchItems];
      const targetChannel = sessionBatchChannelId;
      sessionBatchItems = [];
      sessionBatchTimer = null;
      sessionBatchChannelId = null;

      if (items.length === 0 || !targetChannel) return;

      const online = items.filter(i => i.action === 'online');
      const offline = items.filter(i => i.action === 'offline');

      const parts: string[] = [];
      if (online.length > 0) parts.push(`${online.map(i => i.name).join(', ')} came online`);
      if (offline.length > 0) parts.push(`${offline.map(i => i.name).join(', ')} went offline`);

      const emoji = online.length > 0 ? '🟢' : '⚫';
      const title = 'Agent Session Change';
      const details = parts.join('\n');

      const blocks = buildNotificationCard(title, emoji, details);
      await postBlockKitMessage(targetChannel, blocks, `${emoji} ${title}: ${details}`, {
        username: PRODUCT_NAME,
        iconEmoji: ':robot_face:',
      }).catch(err => console.error('[Slack Notifications] Session notification error:', err));
    }, SESSION_BATCH_WINDOW_MS);
  }
}

/**
 * Handle collab:sprint events.
 * Immediate notifications for sprint activated/completed.
 */
async function handleSprintEvent(data: unknown): Promise<void> {
  if (!await isEventEnabled('collab:sprint')) return;

  const channelId = await getNotificationTarget();
  if (!channelId) return;

  const payload = data as {
    sprintId?: string;
    sprintName?: string;
    action?: string;
    channelId?: string;
  };

  if (!payload?.action || !payload?.sprintName) return;

  const throttleKey = `sprint:${payload.sprintId}:${payload.action}`;
  if (shouldThrottle(throttleKey)) return;

  let emoji: string;
  let title: string;
  switch (payload.action) {
    case 'activated':
      emoji = '🚀';
      title = `Sprint "${payload.sprintName}" activated`;
      break;
    case 'completed':
      emoji = '🎉';
      title = `Sprint "${payload.sprintName}" completed`;
      break;
    default:
      return; // Only notify on activate/complete
  }

  const blocks = buildNotificationCard(title, emoji, `Sprint status changed to *${payload.action}*`);
  await postBlockKitMessage(channelId, blocks, `${emoji} ${title}`, {
    username: `${PRODUCT_NAME} Sprints`,
    iconEmoji: ':bar_chart:',
  }).catch(err => console.error('[Slack Notifications] Sprint notification error:', err));
}

/**
 * Handle collab:task events.
 * Batch task completions over a window to avoid spam.
 */
async function handleTaskEvent(data: unknown): Promise<void> {
  if (!await isEventEnabled('collab:task')) return;

  const channelId = await getNotificationTarget();
  if (!channelId) return;

  const payload = data as {
    taskId?: string;
    taskTitle?: string;
    action?: string;
    phaseName?: string;
  };

  // Only batch task completions
  if (payload?.action !== 'completed' || !payload?.taskTitle) return;

  taskBatchItems.push({
    taskTitle: payload.taskTitle,
    phaseName: payload.phaseName,
  });
  taskBatchChannelId = channelId;

  // Set batch timer if not already running
  if (!taskBatchTimer) {
    taskBatchTimer = setTimeout(async () => {
      const items = [...taskBatchItems];
      const targetChannel = taskBatchChannelId;
      taskBatchItems = [];
      taskBatchTimer = null;
      taskBatchChannelId = null;

      if (items.length === 0 || !targetChannel) return;

      const emoji = '✅';
      const title = items.length === 1
        ? `Task completed: ${items[0].taskTitle}`
        : `${items.length} tasks completed`;

      let details: string;
      if (items.length <= 5) {
        details = items.map(i => {
          const phase = i.phaseName ? ` (${i.phaseName})` : '';
          return `• ${i.taskTitle}${phase}`;
        }).join('\n');
      } else {
        // Group by phase
        const byPhase = new Map<string, number>();
        for (const item of items) {
          const phase = item.phaseName || 'Unassigned';
          byPhase.set(phase, (byPhase.get(phase) || 0) + 1);
        }
        details = Array.from(byPhase.entries())
          .map(([phase, count]) => `• ${count} task(s) in ${phase}`)
          .join('\n');
      }

      const blocks = buildNotificationCard(title, emoji, details);
      await postBlockKitMessage(targetChannel, blocks, `${emoji} ${title}`, {
        username: `${PRODUCT_NAME} Tasks`,
        iconEmoji: ':white_check_mark:',
      }).catch(err => console.error('[Slack Notifications] Task notification error:', err));
    }, TASK_BATCH_WINDOW_MS);
  }
}

// --- Lifecycle ---

let isListening = false;

/**
 * Start listening to the event bus and forwarding notifications to Slack.
 * Safe to call multiple times — only starts once.
 */
export function startSlackNotifications(): void {
  if (isListening) return;
  isListening = true;

  // Import event bus lazily to avoid circular imports
  import('@/lib/event-bus').then(({ eventBus }) => {
    eventBus.on('sse-event', (event: { type: string; data: unknown }) => {
      switch (event.type) {
        case 'health:status':
          handleHealthStatus(event.data).catch(err =>
            console.error('[Slack Notifications] Health handler error:', err)
          );
          break;
        case 'sessions:change':
          handleSessionsChange(event.data).catch(err =>
            console.error('[Slack Notifications] Sessions handler error:', err)
          );
          break;
        case 'collab:sprint':
          handleSprintEvent(event.data).catch(err =>
            console.error('[Slack Notifications] Sprint handler error:', err)
          );
          break;
        case 'collab:task':
          handleTaskEvent(event.data).catch(err =>
            console.error('[Slack Notifications] Task handler error:', err)
          );
          break;
      }
    });

    console.log('[Slack Notifications] Listening for events: health:status, sessions:change, collab:sprint, collab:task');
  }).catch(err => {
    console.error('[Slack Notifications] Failed to import event bus:', err);
    isListening = false;
  });
}

/**
 * Stop listening (cleanup for testing).
 */
export function stopSlackNotifications(): void {
  isListening = false;
  // Clear any pending batch timers
  if (taskBatchTimer) { clearTimeout(taskBatchTimer); taskBatchTimer = null; }
  if (sessionBatchTimer) { clearTimeout(sessionBatchTimer); sessionBatchTimer = null; }
  taskBatchItems = [];
  sessionBatchItems = [];
}
