/**
 * Sprint Stall Reminder — Tick Engine (Sprint 61 P3.1)
 *
 * runReminderTick: scans all channels for stale active sprints and fires
 * hidden @mention reminders to the appropriate recipient.
 *
 * buildReminderContent: pure fn — message template (testable without I/O).
 */

import { randomUUID } from 'crypto';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { appendMessage as appendChannelMessage } from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { deliverMessage } from '@/lib/collab-delivery';
import { enqueueDurableDeliveries, prepareDurableDelivery } from '@/lib/collab-delivery-ledger';
import { shouldFireReminder, REMINDER_IDLE_MS } from '@/lib/sprint-reminder-logic';
import { pickReminderRecipient } from '@/lib/sprint-reminder-logic';
import type {
  CollabChannelsData,
  CollabTasksData,
  CollabSprint,
  CollabTask,
  CollabPhase,
  CollabParticipant,
  CollabMessage,
} from '@/lib/types';
import { PRODUCT_NAME } from '@/lib/brand';

const TASKS_PATH = DataPaths.collabTasks;


export interface ReminderTickResult {
  sprintId: string;
  channelId: string;
  sprintName: string;
  recipientId: string;
  recipientName: string;
}

/**
 * Build the locked reminder message template (pure — no I/O).
 * lastActivityMs: unix ms of the most recent sprint/phase/task update.
 */
export function buildReminderContent(
  sprint: CollabSprint,
  tasks: CollabTask[],
  recipient: CollabParticipant,
  lastActivityMs: number,
  now: Date,
): string {
  const idleMinutes = Math.floor((now.getTime() - lastActivityMs) / 60_000);
  const sprintTasks = tasks.filter(t => t.sprintId === sprint.id);
  const taskCount = sprintTasks.length;
  const inProgressCount = sprintTasks.filter(t => t.status === 'in_progress').length;
  const today = now.toISOString().slice(0, 10);
  const doneCount = sprintTasks.filter(
    t => t.status === 'done' && t.updatedAt?.startsWith(today)
  ).length;

  return (
    `@${recipient.name} — Sprint "${sprint.name}" has had no board updates for ${idleMinutes} minutes. ` +
    `Current state: ${taskCount} tasks total, ${inProgressCount} in_progress, ${doneCount} done today. ` +
    `Please check in: finish outstanding work, mark blockers, or call sprint.reminderSnooze until a specific date/time with a reason.`
  );
}

/**
 * Scan all channels for stale active sprints and fire hidden reminder messages.
 * Mutates tasksData in-place and persists via withFileLock.
 */
export async function runReminderTick(
  channelsData: CollabChannelsData,
  tasksData: CollabTasksData,
  now: Date,
): Promise<{ fired: number; results: ReminderTickResult[] }> {
  const results: ReminderTickResult[] = [];

  const workingData = tasksData;
  if (!workingData.sprints) workingData.sprints = [];
  if (!workingData.phases) workingData.phases = [];

  for (const channel of channelsData.channels) {
    const channelSprints = workingData.sprints.filter(
      s => s.channelId === channel.id && s.status === 'active'
    );
    if (channelSprints.length === 0) continue;

    const channelPhases = (workingData.phases as CollabPhase[]).filter(
      p => p.channelId === channel.id
    );
    const channelTasks = workingData.tasks.filter(t => t.channelId === channel.id);

    for (const sprint of channelSprints) {
      const sprintPhases = channelPhases.filter(p => p.sprintId === sprint.id);
      const sprintTasks = channelTasks.filter(t => t.sprintId === sprint.id);

      if (!shouldFireReminder(sprint, sprintPhases, sprintTasks, now)) continue;

      const recipient = pickReminderRecipient(channel, now);
      if (!recipient) continue;

      // Compute lastActivity for the idle time display
      const timestamps: number[] = [new Date(sprint.updatedAt).getTime()];
      for (const p of sprintPhases) timestamps.push(new Date(p.updatedAt).getTime());
      for (const t of sprintTasks) timestamps.push(new Date(t.updatedAt).getTime());
      const lastActivityMs = Math.max(...timestamps);

      const content = buildReminderContent(sprint, sprintTasks, recipient, lastActivityMs, now);
      const messageId = randomUUID();
      const nowIso = now.toISOString();

      const msg: CollabMessage = {
        id: messageId,
        channelId: channel.id,
        from: {
          id: 'system',
          type: 'user',
          name: PRODUCT_NAME,
          source: 'DevFlow',
          joinedAt: nowIso,
          lastSeen: nowIso,
        },
        content,
        timestamp: nowIso,
        mentions: [recipient.id],
        recipients: [recipient.id],
        metadata: {
          isHidden: true,
          deliveryMode: 'targeted',
        },
      };

      prepareDurableDelivery('system', msg, channel);
      await appendChannelMessage(channel.id, msg);
      await enqueueDurableDeliveries('system', msg, channel);
      eventBus.emitEvent('collab:message', { channelId: channel.id, message: msg });
      deliverMessage('system', msg, channel);

      // Update sprint state
      sprint.lastReminderSentAt = nowIso;
      sprint.reminderCount = (sprint.reminderCount ?? 0) + 1;

      results.push({
        sprintId: sprint.id,
        channelId: channel.id,
        sprintName: sprint.name,
        recipientId: recipient.id,
        recipientName: recipient.name,
      });
    }
  }

  if (results.length > 0) {
    // tasksData was read before the awaited sends above, so writing it back could undo task
    // changes made meanwhile (a completion and its receipt). Apply only the reminder fields to a
    // fresh read under the lock.
    await withFileLock(TASKS_PATH, async () => {
      const fresh = await readJsonFile<CollabTasksData>(TASKS_PATH, workingData);
      for (const r of results) {
        const sent = workingData.sprints!.find(s => s.id === r.sprintId);
        const live = (fresh.sprints || []).find(s => s.id === r.sprintId);
        if (sent && live) {
          live.lastReminderSentAt = sent.lastReminderSentAt;
          live.reminderCount = sent.reminderCount;
        }
      }
      fresh.lastUpdated = now.toISOString();
      await writeJsonFile(TASKS_PATH, fresh);
    });
  }

  return { fired: results.length, results };
}
