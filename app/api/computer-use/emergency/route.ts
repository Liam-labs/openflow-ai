/**
 * Computer Use Emergency Kill Switch
 *
 * POST /api/computer-use/emergency { action: 'kill_all' }
 *
 * No authentication required — the kill switch must always work, even if the
 * API token is unavailable. Rate limited to prevent abuse.
 *
 * Kills all active computer use sessions and their associated tmux processes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import type { ComputerUseSessionsData } from '@/lib/types';
import { tracked } from '@/lib/api-tracking';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const execAsync = promisify(exec);

// Simple in-memory rate limiter (max 10 requests per minute)
const rateLimitWindow = 60 * 1000;
const rateLimitMax = 10;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  // Remove timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - rateLimitWindow) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= rateLimitMax) return true;
  requestTimestamps.push(now);
  return false;
}

const DEFAULT_DATA: ComputerUseSessionsData = {
  sessions: [],
  tasks: [],
  bridgeStatus: null,
};

export const POST = tracked('/api/computer-use/emergency', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  if (isRateLimited()) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded. Try again in a minute.' },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();

    if (body.action !== 'kill_all') {
      return NextResponse.json(
        { success: false, error: 'Unknown action. Use { action: "kill_all" }' },
        { status: 400 }
      );
    }

    const data = await readJsonFile<ComputerUseSessionsData>(
      DataPaths.computerUseSessions,
      DEFAULT_DATA
    );

    const activeSessions = data.sessions.filter((s) => s.status === 'active');
    const runningTasks = data.tasks.filter((t) => t.status === 'running');

    let killedCount = 0;
    const errors: string[] = [];

    // Kill all running task tmux sessions
    for (const task of runningTasks) {
      try {
        await execAsync(`tmux kill-session -t "${task.tmuxSession}" 2>/dev/null || true`);
        killedCount++;
      } catch (err) {
        errors.push(`Failed to kill tmux session ${task.tmuxSession}`);
      }
    }

    // Mark all active sessions and running tasks as closed/killed
    const now = new Date().toISOString();
    await withFileLock(DataPaths.computerUseSessions, async () => {
      const d = await readJsonFile<ComputerUseSessionsData>(
        DataPaths.computerUseSessions,
        DEFAULT_DATA
      );

      for (const session of d.sessions) {
        if (session.status === 'active') {
          session.status = 'closed';
          session.closedAt = now;
        }
      }

      for (const task of d.tasks) {
        if (task.status === 'running') {
          task.status = 'killed';
          task.completedAt = now;
          task.durationMs = Date.now() - new Date(task.startedAt).getTime();
        }
      }

      await writeJsonFile(DataPaths.computerUseSessions, d);
    });

    // Attempt graceful bridge shutdown (best-effort, non-critical)
    const bridgeUrl = data.bridgeStatus?.url;
    if (bridgeUrl) {
      try {
        await fetch(`${bridgeUrl}/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // Bridge shutdown failure is non-critical
      }
    }

    return NextResponse.json({
      success: true,
      killedSessions: activeSessions.length,
      killedTasks: runningTasks.length,
      message: `Stopped ${activeSessions.length} session(s) and ${runningTasks.length} task(s)`,
      ...(errors.length > 0 ? { warnings: errors } : {}),
    });
  } catch (error) {
    console.error('[computer-use/emergency] error:', error);
    return NextResponse.json(
      { success: false, error: 'Emergency stop failed' },
      { status: 500 }
    );
  }
});
