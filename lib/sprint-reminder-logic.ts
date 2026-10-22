/**
 * Sprint Stall Reminder — Pure Logic (Sprint 61 P2.1)
 *
 * Both exports are pure functions: data-in, result-out.
 * No I/O, no HTTP, no side effects — safe to unit test directly.
 */

import type { CollabSprint, CollabPhase, CollabTask, CollabChannel, CollabParticipant } from '@/lib/types';

/** Reminder fires when sprint has been idle for this long with no board update. */
export const REMINDER_IDLE_MS = 20 * 60 * 1000; // 20 minutes

/** A participant is "online" if their heartbeat is within this window. */
const HEARTBEAT_ONLINE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Determine whether a stall reminder should be sent for a given sprint.
 *
 * Returns true when ALL of the following hold:
 *   1. Sprint is active
 *   2. Snooze is not active (reminderSnoozeUntil absent or in the past)
 *   3. lastActivity (max of sprint/phase/task updatedAt) is >20min ago
 *   4. lastReminderSentAt is absent or >20min ago (dedup guard)
 */
export function shouldFireReminder(
  sprint: CollabSprint,
  phases: CollabPhase[],
  tasks: CollabTask[],
  now: Date,
): boolean {
  // 1. Only fire for active sprints
  if (sprint.status !== 'active') return false;

  // 2. Snooze check — past-dated until is treated as unsnoozed
  if (sprint.reminderSnoozeUntil) {
    const snoozeExpiry = new Date(sprint.reminderSnoozeUntil);
    if (!isNaN(snoozeExpiry.getTime()) && snoozeExpiry > now) {
      return false;
    }
  }

  // 3. Compute lastActivity = max(sprint.activatedAt|updatedAt, phases.updatedAt, tasks.updatedAt)
  // Use activatedAt as the sprint floor so non-board-activity metadata changes (renames etc.) don't
  // reset the idle clock. Falls back to updatedAt for sprints created before activatedAt was added.
  const sprintFloor = sprint.activatedAt ?? sprint.updatedAt;
  const timestamps: number[] = [new Date(sprintFloor).getTime()];
  for (const phase of phases) {
    timestamps.push(new Date(phase.updatedAt).getTime());
  }
  for (const task of tasks) {
    timestamps.push(new Date(task.updatedAt).getTime());
  }
  const lastActivityMs = Math.max(...timestamps);
  if (now.getTime() - lastActivityMs < REMINDER_IDLE_MS) return false;

  // 4. Dedup guard — don't send two reminders in one 20-min window
  if (sprint.lastReminderSentAt) {
    const lastSentMs = new Date(sprint.lastReminderSentAt).getTime();
    if (!isNaN(lastSentMs) && now.getTime() - lastSentMs < REMINDER_IDLE_MS) {
      return false;
    }
  }

  return true;
}

/**
 * Pick the best recipient for a stall reminder in a channel.
 *
 * Priority order (per spec):
 *   1. Team Lead (channel.teamLeadId match) with heartbeat <5min
 *   2. Any participant with heartbeat <5min
 *   3. null — hold the reminder until someone comes online
 */
export function pickReminderRecipient(
  channel: CollabChannel,
  now: Date,
): CollabParticipant | null {
  const isOnline = (p: CollabParticipant): boolean => {
    const lastSeenMs = new Date(p.lastSeen).getTime();
    return !isNaN(lastSeenMs) && now.getTime() - lastSeenMs < HEARTBEAT_ONLINE_MS;
  };

  const TEAM_LEAD_ROLE_ID = '04eecdef-cc15-44f6-9d8c-366774c2a466';

  // 1. Team Lead — if designated and online
  if (channel.teamLeadId) {
    const tl = channel.participants.find(p => p.id === channel.teamLeadId);
    if (tl && isOnline(tl)) return tl;
  }

  // 2. Participant with team-lead roleId — fallback when teamLeadId absent or offline
  const tlByRole = channel.participants.find(p => p.roleId === TEAM_LEAD_ROLE_ID && isOnline(p));
  if (tlByRole) return tlByRole;

  // 3. Any online participant
  const online = channel.participants.find(p => isOnline(p));
  return online ?? null;
}
