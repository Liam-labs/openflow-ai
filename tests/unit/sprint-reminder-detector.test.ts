/**
 * P2.1 TDD — shouldFireReminder (pure detector) + pickReminderRecipient (pure picker)
 *
 * Both functions are pure: data-in, result-out. No I/O, no HTTP.
 */

import { describe, it, expect } from 'vitest';
import type { CollabSprint, CollabPhase, CollabTask, CollabChannel, CollabParticipant } from '../../lib/types';
import { shouldFireReminder, pickReminderRecipient } from '../../lib/sprint-reminder-logic';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TWENTY_MIN_MS = 20 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

function minsAgo(n: number, base = new Date()): string {
  return new Date(base.getTime() - n * 60_000).toISOString();
}

function minsFromNow(n: number, base = new Date()): string {
  return new Date(base.getTime() + n * 60_000).toISOString();
}

function makeSprint(overrides: Partial<CollabSprint> = {}): CollabSprint {
  const now = new Date();
  return {
    id: 'sprint-1',
    channelId: 'ch-1',
    name: 'Sprint 61',
    status: 'active',
    createdBy: 'p-1',
    createdAt: minsAgo(60, now),
    updatedAt: minsAgo(25, now), // 25 min ago — stale
    sortOrder: 0,
    ...overrides,
  };
}

function makePhase(updatedAt: string): CollabPhase {
  return {
    id: 'phase-1',
    sprintId: 'sprint-1',
    channelId: 'ch-1',
    name: 'P1',
    sortOrder: 0,
    createdBy: 'p-1',
    createdAt: updatedAt,
    updatedAt,
  };
}

function makeTask(updatedAt: string): CollabTask {
  return {
    id: 'task-1',
    channelId: 'ch-1',
    title: 'Do something',
    status: 'in_progress',
    priority: 'normal',
    sortOrder: 0,
    createdBy: 'p-1',
    createdAt: updatedAt,
    updatedAt,
    sprintId: 'sprint-1',
  };
}

function makeParticipant(overrides: Partial<CollabParticipant> = {}): CollabParticipant {
  return {
    id: 'p-1',
    type: 'claude',
    name: 'Worf',
    source: 'WSL',
    joinedAt: minsAgo(120),
    lastSeen: minsAgo(2), // 2 min ago = online
    ...overrides,
  };
}

function makeChannel(overrides: Partial<CollabChannel> = {}): CollabChannel {
  return {
    id: 'ch-1',
    name: 'SG-1',
    createdAt: minsAgo(120),
    lastActivity: minsAgo(10),
    participants: [],
    messages: [],
    settings: { autoRespond: false },
    ...overrides,
  };
}

// ─── shouldFireReminder tests ─────────────────────────────────────────────────

describe('shouldFireReminder', () => {
  const NOW = new Date();

  it('returns true when sprint is active, no snooze, and last activity was >20min ago', () => {
    const sprint = makeSprint({ updatedAt: minsAgo(25, NOW) });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(true);
  });

  it('returns false when sprint status is not active (planned)', () => {
    const sprint = makeSprint({ status: 'planned', updatedAt: minsAgo(25, NOW) });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(false);
  });

  it('returns false when sprint status is not active (completed)', () => {
    const sprint = makeSprint({ status: 'completed', updatedAt: minsAgo(25, NOW) });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(false);
  });

  it('returns false when snooze is active (until is in the future)', () => {
    const sprint = makeSprint({
      updatedAt: minsAgo(25, NOW),
      reminderSnoozeUntil: minsFromNow(60, NOW),
      reminderSnoozeReason: 'Waiting on client',
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(false);
  });

  it('returns true when snooze until is in the past (treat as unsnoozed)', () => {
    const sprint = makeSprint({
      updatedAt: minsAgo(25, NOW),
      reminderSnoozeUntil: minsAgo(10, NOW), // expired 10 min ago
      reminderSnoozeReason: 'Old snooze',
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(true);
  });

  it('returns false when last activity (from a task) was <20min ago', () => {
    const sprint = makeSprint({ updatedAt: minsAgo(25, NOW) });
    const task = makeTask(minsAgo(5, NOW)); // task updated 5 min ago
    expect(shouldFireReminder(sprint, [], [task], NOW)).toBe(false);
  });

  it('returns false when last reminder was sent <20min ago (dedup guard)', () => {
    const sprint = makeSprint({
      updatedAt: minsAgo(25, NOW),
      lastReminderSentAt: minsAgo(10, NOW), // sent 10 min ago — too soon
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(false);
  });

  it('returns true when last reminder was sent >20min ago', () => {
    const sprint = makeSprint({
      updatedAt: minsAgo(25, NOW),
      lastReminderSentAt: minsAgo(25, NOW),
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(true);
  });

  it('uses the most recent phase updatedAt as lastActivity', () => {
    const sprint = makeSprint({ updatedAt: minsAgo(25, NOW) });
    const phase = makePhase(minsAgo(5, NOW)); // phase touched 5 min ago
    expect(shouldFireReminder(sprint, [phase], [], NOW)).toBe(false);
  });
});

// ─── pickReminderRecipient tests ──────────────────────────────────────────────

describe('pickReminderRecipient', () => {
  const NOW = new Date();

  it('returns the team lead when they are online', () => {
    const tl = makeParticipant({ id: 'tl-1', name: 'Jack', lastSeen: minsAgo(2, NOW) });
    const other = makeParticipant({ id: 'p-2', name: 'Worf', lastSeen: minsAgo(2, NOW) });
    const channel = makeChannel({ participants: [tl, other], teamLeadId: 'tl-1' });
    const result = pickReminderRecipient(channel, NOW);
    expect(result?.id).toBe('tl-1');
  });

  it('falls back to any online member when team lead is offline', () => {
    const tl = makeParticipant({ id: 'tl-1', name: 'Jack', lastSeen: minsAgo(10, NOW) }); // offline
    const member = makeParticipant({ id: 'p-2', name: 'Worf', lastSeen: minsAgo(2, NOW) });
    const channel = makeChannel({ participants: [tl, member], teamLeadId: 'tl-1' });
    const result = pickReminderRecipient(channel, NOW);
    expect(result?.id).toBe('p-2');
  });

  it('returns null when all participants are offline', () => {
    const tl = makeParticipant({ id: 'tl-1', lastSeen: minsAgo(10, NOW) });
    const member = makeParticipant({ id: 'p-2', lastSeen: minsAgo(15, NOW) });
    const channel = makeChannel({ participants: [tl, member], teamLeadId: 'tl-1' });
    const result = pickReminderRecipient(channel, NOW);
    expect(result).toBeNull();
  });

  it('returns null when there are no participants', () => {
    const channel = makeChannel({ participants: [] });
    const result = pickReminderRecipient(channel, NOW);
    expect(result).toBeNull();
  });
});
