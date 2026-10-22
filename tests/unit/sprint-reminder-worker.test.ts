/**
 * P5.1 TDD — shouldFireReminder activatedAt floor edge cases
 *
 * Verifies that sprint idle time is measured from activatedAt (not updatedAt),
 * so non-board-activity sprint metadata changes don't reset the stall clock.
 */

import { describe, it, expect } from 'vitest';
import type { CollabSprint, CollabTask } from '../../lib/types';
import { shouldFireReminder } from '../../lib/sprint-reminder-logic';

const NOW = new Date();

function minsAgo(n: number): string {
  return new Date(NOW.getTime() - n * 60_000).toISOString();
}

function makeSprint(overrides: Partial<CollabSprint> = {}): CollabSprint {
  return {
    id: 'sprint-1',
    channelId: 'ch-1',
    name: 'Sprint 61',
    status: 'active',
    createdBy: 'p-1',
    createdAt: minsAgo(120),
    updatedAt: minsAgo(25),
    sortOrder: 0,
    ...overrides,
  };
}

function makeTask(updatedAt: string): CollabTask {
  return {
    id: 'task-1',
    channelId: 'ch-1',
    sprintId: 'sprint-1',
    title: 'Task',
    status: 'in_progress',
    priority: 'normal',
    sortOrder: 0,
    createdBy: 'p-1',
    createdAt: minsAgo(120),
    updatedAt,
  };
}

describe('shouldFireReminder — activatedAt floor', () => {
  it('does not fire when sprint was just activated (activatedAt 5 min ago)', () => {
    const sprint = makeSprint({
      activatedAt: minsAgo(5),
      updatedAt: minsAgo(5),
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(false);
  });

  it('fires when sprint was activated more than 20 min ago', () => {
    const sprint = makeSprint({
      activatedAt: minsAgo(25),
      updatedAt: minsAgo(25),
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(true);
  });

  it('uses activatedAt (not updatedAt) as the sprint floor when metadata changed after activation', () => {
    // Sprint activated 25min ago, but someone renamed it 5min ago (updatedAt = -5).
    // updatedAt is not board activity — the idle clock should count from activatedAt.
    const sprint = makeSprint({
      activatedAt: minsAgo(25),
      updatedAt: minsAgo(5),
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(true);
  });

  it('backward compat: sprint without activatedAt uses updatedAt as floor', () => {
    const sprint = makeSprint({
      updatedAt: minsAgo(25),
      // no activatedAt — old record
    });
    expect(shouldFireReminder(sprint, [], [], NOW)).toBe(true);
  });

  it('does not fire when activatedAt is recent even if tasks predate activation', () => {
    // Sprint activated 10min ago, but tasks were all last updated 2h ago (before activation).
    // activatedAt is the floor: lastActivity = max(activatedAt=-10, task=-120) = -10 → 10 < 20 → no fire.
    const sprint = makeSprint({
      activatedAt: minsAgo(10),
      updatedAt: minsAgo(10),
    });
    const staleTask = makeTask(minsAgo(120));
    expect(shouldFireReminder(sprint, [], [staleTask], NOW)).toBe(false);
  });

  it('fires when activatedAt is old and all tasks predate activation', () => {
    // Sprint activated 30min ago, tasks last updated 2h ago → floor = -30 → 30 > 20 → fire.
    const sprint = makeSprint({
      activatedAt: minsAgo(30),
      updatedAt: minsAgo(30),
    });
    const staleTask = makeTask(minsAgo(120));
    expect(shouldFireReminder(sprint, [], [staleTask], NOW)).toBe(true);
  });
});
