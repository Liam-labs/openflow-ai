/**
 * POST /api/sprints/reminder-tick
 *
 * Sprint 61 P3.1 — Stall reminder tick endpoint.
 * Called by cron every 2 minutes. Scans active sprints for idle boards
 * and fires hidden @mention reminders to the appropriate online recipient.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { readJsonFile } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { runReminderTick } from '@/lib/sprint-reminder-tick';
import type { CollabChannelsData, CollabTasksData } from '@/lib/types';

const DEFAULT_CHANNELS: CollabChannelsData = { channels: [], lastUpdated: '' };
const DEFAULT_TASKS: CollabTasksData = { tasks: [], sprints: [], phases: [], lastUpdated: '' };

export async function POST(request: NextRequest) {
  const authError = await requireAuthOrLocal(request, 'write');
  if (authError) return authError;

  try {
    const [channelsData, tasksData] = await Promise.all([
      readJsonFile<CollabChannelsData>(DataPaths.collabChannels, DEFAULT_CHANNELS),
      readJsonFile<CollabTasksData>(DataPaths.collabTasks, DEFAULT_TASKS),
    ]);

    const result = await runReminderTick(channelsData, tasksData, new Date());

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
