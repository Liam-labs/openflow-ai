/**
 * Cron Jobs API
 *
 * Manages scheduled tasks (cron jobs) for DevFlow.
 *
 * GET  /api/cron                  - List all cron jobs
 * GET  /api/cron?jobId=xxx        - Get a specific job
 * GET  /api/cron?history=xxx      - Get execution history for a job
 * POST /api/cron                  - CRUD + trigger/toggle actions
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import path from 'path';
import { DataPaths, cronLogFile } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { cronScheduler } from '@/lib/cron-scheduler';
import { tracked } from '@/lib/api-tracking';
import type {
  CronJob,
  CronJobsData,
  CronJobLogData,
  CronActionRequest,
  CronActionResponse,
} from '@/lib/types';

const DATA_PATH = DataPaths.cronJobs;
const KEEP_ALIVE_DIR = path.join(DataPaths.appData, 'keep-alive');

const DEFAULT_DATA: CronJobsData = {
  jobs: [],
  lastUpdated: '',
};

/**
 * When a keep-alive cron job is disabled or deleted via the CronPanel,
 * also mark the corresponding keep-alive config as "stopped" so the
 * KeepAliveModal UI stays in sync and the system doesn't think it's active.
 */
async function syncKeepAliveStop(job: CronJob): Promise<void> {
  if (!job.tags?.includes('keep-alive')) return;

  // Extract channelId and agentId from the cron's apiBody
  try {
    const body = JSON.parse(job.apiBody || '{}');
    const channelId = body.channelId as string;
    const agentId = body.agentId as string;
    if (!channelId || !agentId) return;

    const configPath = path.join(KEEP_ALIVE_DIR, `${channelId}-${agentId}.json`);
    await withFileLock(configPath, async () => {
      const config = await readJsonFile<Record<string, unknown>>(configPath, null as unknown as Record<string, unknown>);
      if (config && config.status === 'active') {
        config.status = 'stopped';
        await writeJsonFile(configPath, config);
      }
    });
  } catch {
    // Non-fatal — keep-alive config sync is best-effort
  }
}

// ============================================
// GET - List jobs or get specific job/history
// ============================================

export const GET = tracked('/api/cron', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const { searchParams } = request.nextUrl;
  const jobId = searchParams.get('jobId');
  const historyJobId = searchParams.get('history');
  const limit = parseInt(searchParams.get('limit') || '50', 10);

  // Get execution history for a job
  if (historyJobId) {
    const logPath = cronLogFile(historyJobId);
    const logData = await readJsonFile<CronJobLogData>(logPath, {
      jobId: historyJobId,
      executions: [],
      lastUpdated: '',
    });

    // Return most recent first, limited
    const executions = logData.executions
      .slice(-limit)
      .reverse();

    return NextResponse.json({
      success: true,
      executions,
      total: logData.executions.length,
    });
  }

  const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);

  // Get specific job
  if (jobId) {
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, job });
  }

  // List all jobs
  return NextResponse.json({
    success: true,
    jobs: data.jobs,
    schedulerRunning: cronScheduler.isRunning(),
    activeJobCount: cronScheduler.getActiveJobCount(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// POST - CRUD + trigger/toggle
// ============================================

export const POST = tracked('/api/cron', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: CronActionRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action } = body;

  switch (action) {
    case 'create':
      return handleCreate(body);
    case 'update':
      return handleUpdate(body);
    case 'delete':
      return handleDelete(body);
    case 'toggle':
      return handleToggle(body);
    case 'trigger':
      return handleTrigger(body);
    case 'history':
      return handleHistory(body);
    default:
      return NextResponse.json(
        { success: false, error: `Unknown action: ${action}` },
        { status: 400 }
      );
  }
});

// ============================================
// Action Handlers
// ============================================

async function handleCreate(body: CronActionRequest): Promise<NextResponse<CronActionResponse>> {
  if (!body.name) {
    return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
  }
  if (!body.schedule) {
    return NextResponse.json({ success: false, error: 'schedule is required' }, { status: 400 });
  }
  if (!body.jobType) {
    return NextResponse.json({ success: false, error: 'jobType is required' }, { status: 400 });
  }
  if (body.jobType === 'agent-reminder') {
    if (!body.reminderChannelId || !body.reminderParticipantId || !body.reminderText?.trim()) {
      return NextResponse.json(
        { success: false, error: 'agent-reminder requires reminderChannelId, reminderParticipantId, and reminderText' },
        { status: 400 },
      );
    }
  }

  const now = new Date().toISOString();
  const newJob: CronJob = {
    id: randomUUID(),
    name: body.name,
    schedule: body.schedule,
    jobType: body.jobType,
    enabled: body.enabled !== false, // default true
    command: body.command,
    tmuxTarget: body.tmuxTarget,
    agentName: body.agentName,
    tmuxText: body.tmuxText,
    apiUrl: body.apiUrl,
    apiMethod: body.apiMethod,
    apiHeaders: body.apiHeaders,
    apiBody: body.apiBody,
    reminderChannelId: body.reminderChannelId,
    reminderParticipantId: body.reminderParticipantId,
    reminderText: body.reminderText,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: 'api',
    description: body.description,
    tags: body.tags,
    timeoutMs: body.timeoutMs,
    timezone: body.timezone,
  };

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    data.jobs.push(newJob);
    data.lastUpdated = now;
    await writeJsonFile(DATA_PATH, data);
  });

  // Reload scheduler to pick up the new job
  await cronScheduler.reloadJobs();

  return NextResponse.json({ success: true, job: newJob });
}

async function handleUpdate(body: CronActionRequest): Promise<NextResponse<CronActionResponse>> {
  if (!body.jobId) {
    return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });
  }

  let updatedJob: CronJob | undefined;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    const job = data.jobs.find(j => j.id === body.jobId);
    if (!job) return;

    if (body.name !== undefined) job.name = body.name;
    if (body.schedule !== undefined) job.schedule = body.schedule;
    if (body.jobType !== undefined) job.jobType = body.jobType;
    if (body.enabled !== undefined) job.enabled = body.enabled;
    if (body.command !== undefined) job.command = body.command;
    if (body.tmuxTarget !== undefined) job.tmuxTarget = body.tmuxTarget;
    if (body.agentName !== undefined) job.agentName = body.agentName;
    if (body.tmuxText !== undefined) job.tmuxText = body.tmuxText;
    if (body.apiUrl !== undefined) job.apiUrl = body.apiUrl;
    if (body.apiMethod !== undefined) job.apiMethod = body.apiMethod;
    if (body.apiHeaders !== undefined) job.apiHeaders = body.apiHeaders;
    if (body.apiBody !== undefined) job.apiBody = body.apiBody;
    if (body.reminderChannelId !== undefined) job.reminderChannelId = body.reminderChannelId;
    if (body.reminderParticipantId !== undefined) job.reminderParticipantId = body.reminderParticipantId;
    if (body.reminderText !== undefined) job.reminderText = body.reminderText;
    if (body.description !== undefined) job.description = body.description;
    if (body.tags !== undefined) job.tags = body.tags;
    if (body.timeoutMs !== undefined) job.timeoutMs = body.timeoutMs;
    if (body.timezone !== undefined) job.timezone = body.timezone;

    job.updatedAt = new Date().toISOString();
    data.lastUpdated = job.updatedAt;
    await writeJsonFile(DATA_PATH, data);
    updatedJob = job;
  });

  if (!updatedJob) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
  }

  // Reload scheduler to pick up changes
  await cronScheduler.reloadJobs();

  return NextResponse.json({ success: true, job: updatedJob });
}

async function handleDelete(body: CronActionRequest): Promise<NextResponse<CronActionResponse>> {
  if (!body.jobId) {
    return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });
  }

  let deleted = false;
  let deletedJob: CronJob | undefined;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    const idx = data.jobs.findIndex(j => j.id === body.jobId);
    if (idx === -1) return;

    deletedJob = data.jobs[idx];
    data.jobs.splice(idx, 1);
    data.lastUpdated = new Date().toISOString();
    await writeJsonFile(DATA_PATH, data);
    deleted = true;
  });

  if (!deleted) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
  }

  // Sync keep-alive config if this was a keep-alive cron
  if (deletedJob) await syncKeepAliveStop(deletedJob);

  // Reload scheduler
  await cronScheduler.reloadJobs();

  return NextResponse.json({ success: true });
}

async function handleToggle(body: CronActionRequest): Promise<NextResponse<CronActionResponse>> {
  if (!body.jobId) {
    return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });
  }

  let toggledJob: CronJob | undefined;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    const job = data.jobs.find(j => j.id === body.jobId);
    if (!job) return;

    job.enabled = !job.enabled;
    job.status = job.enabled ? 'active' : 'paused';
    job.updatedAt = new Date().toISOString();
    data.lastUpdated = job.updatedAt;
    await writeJsonFile(DATA_PATH, data);
    toggledJob = job;
  });

  if (!toggledJob) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
  }

  // Sync keep-alive config when disabling a keep-alive cron
  if (!toggledJob.enabled) await syncKeepAliveStop(toggledJob);

  // Reload scheduler
  await cronScheduler.reloadJobs();

  return NextResponse.json({ success: true, job: toggledJob });
}

async function handleTrigger(body: CronActionRequest): Promise<NextResponse<CronActionResponse>> {
  if (!body.jobId) {
    return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });
  }

  try {
    const execution = await cronScheduler.executeJob(body.jobId, 'manual');
    return NextResponse.json({ success: true, executions: [execution] });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

async function handleHistory(body: CronActionRequest): Promise<NextResponse<CronActionResponse>> {
  if (!body.jobId) {
    return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });
  }

  const limit = body.limit || 50;
  const logPath = cronLogFile(body.jobId);
  const logData = await readJsonFile<CronJobLogData>(logPath, {
    jobId: body.jobId,
    executions: [],
    lastUpdated: '',
  });

  const executions = logData.executions
    .slice(-limit)
    .reverse();

  return NextResponse.json({ success: true, executions });
}
