/**
 * Cron Job Actions
 *
 * Agent API actions for managing scheduled cron jobs.
 */

import { DataPaths, cronLogFile } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { cronScheduler } from '@/lib/cron-scheduler';
import { emitApiEvent } from '@/lib/log-emitter';
import { randomUUID } from 'crypto';
import type {
  AgentApiRequest,
  AgentAuthContext,
  CronJob,
  CronJobsData,
  CronJobLogData,
  CronExecution,
  CronJobType,
} from '@/lib/types';

const DATA_PATH = DataPaths.cronJobs;

const DEFAULT_DATA: CronJobsData = {
  jobs: [],
  lastUpdated: '',
};

/**
 * cron.list - List all cron jobs
 */
export async function list(
  _body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ jobs: CronJob[]; schedulerRunning: boolean; activeJobCount: number }> {
  const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
  return {
    jobs: data.jobs,
    schedulerRunning: cronScheduler.isRunning(),
    activeJobCount: cronScheduler.getActiveJobCount(),
  };
}

/**
 * cron.create - Create a new cron job
 */
export async function create(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ job: CronJob }> {
  const name = body.name;
  const schedule = body.schedule;
  const jobType = body.jobType as CronJobType | undefined;

  if (!name || typeof name !== 'string') throw new Error('name is required');
  if (!schedule || typeof schedule !== 'string') throw new Error('schedule is required');
  if (!jobType || !['shell', 'tmux-send', 'api-call', 'agent-reminder'].includes(jobType)) {
    throw new Error('jobType must be shell, tmux-send, api-call, or agent-reminder');
  }
  if (jobType === 'agent-reminder') {
    if (typeof body.reminderChannelId !== 'string'
        || typeof body.reminderParticipantId !== 'string'
        || typeof body.reminderText !== 'string'
        || !body.reminderText.trim()) {
      throw new Error('agent-reminder requires reminderChannelId, reminderParticipantId, and reminderText');
    }
  }

  const now = new Date().toISOString();
  const newJob: CronJob = {
    id: randomUUID(),
    name,
    schedule,
    jobType,
    enabled: body.enabled !== false,
    command: typeof body.command === 'string' ? body.command : undefined,
    tmuxTarget: typeof body.tmuxTarget === 'string' ? body.tmuxTarget : undefined,
    tmuxText: typeof body.tmuxText === 'string' ? body.tmuxText : undefined,
    apiUrl: typeof body.apiUrl === 'string' ? body.apiUrl : undefined,
    apiMethod: typeof body.apiMethod === 'string' ? body.apiMethod as CronJob['apiMethod'] : undefined,
    apiHeaders: body.apiHeaders as Record<string, string> | undefined,
    apiBody: typeof body.apiBody === 'string' ? body.apiBody : undefined,
    reminderChannelId: typeof body.reminderChannelId === 'string' ? body.reminderChannelId : undefined,
    reminderParticipantId: typeof body.reminderParticipantId === 'string' ? body.reminderParticipantId : undefined,
    reminderText: typeof body.reminderText === 'string' ? body.reminderText : undefined,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: typeof body.createdBy === 'string' ? body.createdBy : 'api',
    description: typeof body.description === 'string' ? body.description : undefined,
    tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === 'string') : undefined,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
  };

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    data.jobs.push(newJob);
    data.lastUpdated = now;
    await writeJsonFile(DATA_PATH, data);
  });

  await cronScheduler.reloadJobs();

  emitApiEvent({
    action: 'cron.create',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'info',
    summary: `Cron job created: ${name} (${schedule})`,
  });

  return { job: newJob };
}

/**
 * cron.update - Update a cron job
 */
export async function update(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ job: CronJob }> {
  const jobId = body.jobId;
  if (!jobId || typeof jobId !== 'string') throw new Error('jobId is required');

  let updatedJob: CronJob | undefined;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    if (body.name !== undefined && typeof body.name === 'string') job.name = body.name;
    if (body.schedule !== undefined && typeof body.schedule === 'string') job.schedule = body.schedule;
    if (body.jobType !== undefined) job.jobType = body.jobType as CronJobType;
    if (body.enabled !== undefined) job.enabled = !!body.enabled;
    if (body.command !== undefined) job.command = body.command as string;
    if (body.tmuxTarget !== undefined) job.tmuxTarget = body.tmuxTarget as string;
    if (body.tmuxText !== undefined) job.tmuxText = body.tmuxText as string;
    if (body.apiUrl !== undefined) job.apiUrl = body.apiUrl as string;
    if (body.apiMethod !== undefined) job.apiMethod = body.apiMethod as CronJob['apiMethod'];
    if (body.apiHeaders !== undefined) job.apiHeaders = body.apiHeaders as Record<string, string>;
    if (body.apiBody !== undefined) job.apiBody = body.apiBody as string;
    if (body.reminderChannelId !== undefined) job.reminderChannelId = body.reminderChannelId as string;
    if (body.reminderParticipantId !== undefined) job.reminderParticipantId = body.reminderParticipantId as string;
    if (body.reminderText !== undefined) job.reminderText = body.reminderText as string;
    if (body.description !== undefined) job.description = body.description as string;
    if (body.tags !== undefined) job.tags = body.tags as string[];
    if (body.timeoutMs !== undefined) job.timeoutMs = body.timeoutMs as number;

    job.updatedAt = new Date().toISOString();
    data.lastUpdated = job.updatedAt;
    await writeJsonFile(DATA_PATH, data);
    updatedJob = job;
  });

  if (!updatedJob) throw new Error(`Job not found: ${jobId}`);

  await cronScheduler.reloadJobs();

  return { job: updatedJob };
}

/**
 * cron.delete - Delete a cron job
 */
export async function remove(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deleted: boolean; jobId: string }> {
  const jobId = body.jobId;
  if (!jobId || typeof jobId !== 'string') throw new Error('jobId is required');

  let deleted = false;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    const idx = data.jobs.findIndex(j => j.id === jobId);
    if (idx === -1) throw new Error(`Job not found: ${jobId}`);

    data.jobs.splice(idx, 1);
    data.lastUpdated = new Date().toISOString();
    await writeJsonFile(DATA_PATH, data);
    deleted = true;
  });

  await cronScheduler.reloadJobs();

  emitApiEvent({
    action: 'cron.delete',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'info',
    summary: `Cron job deleted: ${jobId}`,
  });

  return { deleted, jobId: jobId as string };
}

/**
 * cron.toggle - Enable/disable a cron job
 */
export async function toggle(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ job: CronJob }> {
  const jobId = body.jobId;
  if (!jobId || typeof jobId !== 'string') throw new Error('jobId is required');

  let toggledJob: CronJob | undefined;

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<CronJobsData>(DATA_PATH, DEFAULT_DATA);
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    job.enabled = !job.enabled;
    job.status = job.enabled ? 'active' : 'paused';
    job.updatedAt = new Date().toISOString();
    data.lastUpdated = job.updatedAt;
    await writeJsonFile(DATA_PATH, data);
    toggledJob = job;
  });

  if (!toggledJob) throw new Error(`Job not found: ${jobId}`);

  await cronScheduler.reloadJobs();

  return { job: toggledJob };
}

/**
 * cron.trigger - Manually trigger a job execution
 */
export async function trigger(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ execution: CronExecution }> {
  const jobId = body.jobId;
  if (!jobId || typeof jobId !== 'string') throw new Error('jobId is required');

  const execution = await cronScheduler.executeJob(jobId as string, 'manual');

  emitApiEvent({
    action: 'cron.trigger',
    status: 200,
    durationMs: 0,
    requestId: _auth.requestId,
    severity: 'info',
    summary: `Cron job triggered manually: ${jobId}`,
  });

  return { execution };
}

/**
 * cron.history - Get execution history for a job
 */
export async function history(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ executions: CronExecution[]; total: number }> {
  const jobId = body.jobId;
  if (!jobId || typeof jobId !== 'string') throw new Error('jobId is required');

  const limit = typeof body.limit === 'number' ? body.limit : 50;
  const logPath = cronLogFile(jobId as string);
  const logData = await readJsonFile<CronJobLogData>(logPath, {
    jobId: jobId as string,
    executions: [],
    lastUpdated: '',
  });

  const executions = logData.executions
    .slice(-limit)
    .reverse();

  return {
    executions,
    total: logData.executions.length,
  };
}
