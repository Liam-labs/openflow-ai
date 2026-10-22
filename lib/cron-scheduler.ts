/**
 * Cron Scheduler Engine
 *
 * Core scheduler that loads jobs from data/cron-jobs.json, evaluates cron
 * expressions via the `croner` library, and executes jobs on schedule.
 *
 * Supports four job types:
 * - shell: Execute a shell command via child_process.exec
 * - tmux-send: Send text to a running tmux session (e.g., trigger Jack)
 * - api-call: Make an HTTP request to an API endpoint
 * - agent-reminder: Queue a durable reminder for an exact channel participant
 *
 * Execution results are logged to data/cron-logs/{jobId}.json.
 *
 * Usage (from instrumentation.ts):
 *   import { cronScheduler } from '@/lib/cron-scheduler';
 *   await cronScheduler.start();
 */

import { Cron } from 'croner';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DataPaths, cronLogFile } from './data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import { eventBus } from './event-bus';
import { logEvent } from './log-writer';
import { sendScheduledAgentReminder } from './scheduled-agent-reminder';
import type {
  CronJob,
  CronExecution,
  CronJobsData,
  CronJobLogData,
  CollabChannelsData,
  Project,
  ServiceCronJob,
} from './types';
import { appRoot } from '@/lib/app-paths';

const execAsync = promisify(exec);

// ============================================
// Agent Tmux Session Resolver
// ============================================

/**
 * Pure resolver: find a running agent's live tmux session name by agent name.
 * Takes channels data as input so it's trivially unit-testable.
 *
 * Search order across all channels' rosters:
 *   1. Exact name match on a "running" agent (returns their tmuxSessionName)
 *   2. Exact name match on any agent (returns their tmuxSessionName if present)
 *
 * Returns null if the agent isn't found, has no tmuxSessionName, or match fails.
 */
export function resolveAgentTmuxSessionFromData(
  data: CollabChannelsData,
  agentName: string,
): string | null {
  if (!agentName) return null;
  const wanted = agentName.trim();
  if (!wanted) return null;

  let fallback: string | null = null;
  for (const ch of data.channels || []) {
    const agents = ch.roster?.agents || [];
    for (const agent of agents) {
      if (agent.name === wanted && agent.tmuxSessionName) {
        if (agent.status === 'running') {
          return agent.tmuxSessionName;
        }
        if (!fallback) fallback = agent.tmuxSessionName;
      }
    }
  }
  return fallback;
}

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

/**
 * Load channels data and resolve the agent's live tmux session.
 * Thin wrapper around the pure resolver for production use.
 */
export async function resolveAgentTmuxSession(agentName: string): Promise<string | null> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, DEFAULT_CHANNELS_DATA);
  return resolveAgentTmuxSessionFromData(data, agentName);
}

const MAX_OUTPUT_LENGTH = 10_000; // Truncate execution output to ~10KB
const DEFAULT_TIMEOUT_MS = 60_000; // 1 minute default timeout
const MAX_EXECUTIONS_PER_JOB = 200; // Keep last 200 executions per job

// ============================================
// Scheduler Singleton
// ============================================

class CronScheduler {
  private cronInstances = new Map<string, Cron>();
  private running = false;

  /**
   * Start the scheduler — loads all enabled jobs and schedules them.
   * Safe to call multiple times (idempotent).
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log('[CronScheduler] Starting...');

    // Ensure cron-logs directory exists
    await fs.mkdir(DataPaths.cronLogs, { recursive: true }).catch(() => {});

    // Sync service-defined cron jobs from project configs
    try {
      const { getProjects } = await import('./config');
      const projects = await getProjects();
      await this.syncServiceCronJobs(projects);
    } catch (err) {
      console.error('[CronScheduler] Failed to sync service cron jobs:', err);
    }

    await this.reloadJobs();

    console.log(`[CronScheduler] Started with ${this.cronInstances.size} active jobs`);
  }

  /**
   * Stop all scheduled jobs.
   */
  stop(): void {
    for (const [id, cron] of this.cronInstances) {
      cron.stop();
      this.cronInstances.delete(id);
    }
    this.running = false;
    console.log('[CronScheduler] Stopped');
  }

  /**
   * Reload all jobs from disk. Stops existing schedules and re-creates them.
   * Called on start and whenever jobs are created/updated/deleted via API.
   */
  async reloadJobs(): Promise<void> {
    // Stop all existing cron instances
    for (const cron of this.cronInstances.values()) {
      cron.stop();
    }
    this.cronInstances.clear();

    // Lazy migration: jobs created before the 2026-05-18 timezone fix have no
    // `timezone` field, which historically meant they were evaluated in
    // Australia/Brisbane (hard-coded). Backfill them to Europe/London so the
    // stored JSON record matches the new default, then persist once (file
    // lock keeps this safe against concurrent API writes).
    let didMigrate = false;
    await withFileLock(DataPaths.cronJobs, async () => {
      const data = await readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' });
      for (const job of data.jobs) {
        if (!job.timezone) {
          job.timezone = CronScheduler.DEFAULT_TIMEZONE;
          didMigrate = true;
        }
      }
      if (didMigrate) {
        data.lastUpdated = new Date().toISOString();
        await writeJsonFile(DataPaths.cronJobs, data);
        console.log(`[CronScheduler] Backfilled timezone=${CronScheduler.DEFAULT_TIMEZONE} on legacy jobs.`);
      }
    });

    const data = await readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' });

    for (const job of data.jobs) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /**
   * Schedule a single job. Creates a Cron instance that fires on the job's schedule.
   *
   * Timezone resolution (2026-05-18 fix — replaces a hard-coded `Australia/Brisbane`
   * default that silently shifted every UK schedule by 10 hours, e.g. `0 9 * * 1`
   * resolved to Sunday 23:00 UTC instead of Monday 09:00 UTC):
   *   1. `job.timezone` if explicitly set on the job
   *   2. `process.env.TZ` if set in the DevFlow process env
   *   3. fall back to `Europe/London` (the owner's actual locale — DST-aware via croner)
   *
   * Existing jobs without a `timezone` field are silently backfilled to
   * `Europe/London` and persisted on the next reload, so the JSON record matches
   * the actual fire time visible to the user.
   */
  private static readonly DEFAULT_TIMEZONE = 'Europe/London';

  private scheduleJob(job: CronJob): void {
    try {
      const tz = job.timezone || process.env.TZ || CronScheduler.DEFAULT_TIMEZONE;
      const cron = new Cron(job.schedule, { name: job.id, timezone: tz }, () => {
        this.executeJob(job.id, 'scheduled').catch(err => {
          console.error(`[CronScheduler] Execution error for ${job.name}:`, err);
        });
      });

      this.cronInstances.set(job.id, cron);

      // Update nextRun in the job data
      const nextRun = cron.nextRun();
      if (nextRun) {
        this.updateJobField(job.id, 'nextRun', nextRun.toISOString()).catch(() => {});
      }
    } catch (err) {
      console.error(`[CronScheduler] Failed to schedule ${job.name} (${job.schedule}):`, err);
      this.updateJobField(job.id, 'status', 'error').catch(() => {});
      this.updateJobField(job.id, 'lastRunError', `Invalid cron expression: ${err}`).catch(() => {});
    }
  }

  /**
   * Execute a job immediately (by ID). Called by scheduler or manual trigger.
   */
  async executeJob(jobId: string, trigger: 'scheduled' | 'manual'): Promise<CronExecution> {
    const data = await readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' });
    const job = data.jobs.find(j => j.id === jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const execution: CronExecution = {
      id: uuidv4(),
      jobId: job.id,
      jobName: job.name,
      startedAt: new Date().toISOString(),
      status: 'running',
      trigger,
    };

    console.log(`[CronScheduler] Executing ${job.name} (${trigger})`);
    logEvent('cron', 'info', `Cron start: ${job.name}`, {
      jobId: job.id, jobName: job.name, trigger, schedule: job.schedule,
    }).catch(() => {});

    try {
      const startTime = Date.now();
      const timeout = job.timeoutMs || DEFAULT_TIMEOUT_MS;

      let output = '';
      let exitCode = 0;

      switch (job.jobType) {
        case 'shell':
          ({ output, exitCode } = await this.execShell(job.command || '', timeout));
          break;

        case 'tmux-send':
          ({ output } = await this.execTmuxSend(job.tmuxTarget || '', job.tmuxText || '', timeout, job.agentName));
          break;

        case 'api-call':
          ({ output } = await this.execApiCall(
            job.apiUrl || '',
            job.apiMethod || 'GET',
            job.apiHeaders,
            job.apiBody,
            timeout,
          ));
          break;

        case 'agent-reminder': {
          const result = await sendScheduledAgentReminder({
            channelId: job.reminderChannelId || '',
            participantId: job.reminderParticipantId || '',
            text: job.reminderText || '',
            jobId: job.id,
            executionId: execution.id,
          });
          output = JSON.stringify(result);
          break;
        }

        default:
          throw new Error(`Unknown job type: ${job.jobType}`);
      }

      const durationMs = Date.now() - startTime;
      execution.completedAt = new Date().toISOString();
      execution.durationMs = durationMs;
      execution.exitCode = exitCode;
      execution.output = output.slice(0, MAX_OUTPUT_LENGTH);
      execution.status = exitCode === 0 ? 'success' : 'failed';

      logEvent('cron', exitCode === 0 ? 'info' : 'high',
        `Cron ${execution.status}: ${job.name}`,
        { jobId: job.id, jobName: job.name, trigger, durationMs, exitCode,
          output: output.slice(0, 500) },
      ).catch(() => {});

      // Update job runtime state
      await this.updateJobRunState(job.id, {
        lastRun: execution.startedAt,
        lastRunDurationMs: durationMs,
        lastRunExitCode: exitCode,
        lastRunError: exitCode !== 0 ? output.slice(0, 200) : undefined,
        status: 'active',
      });

    } catch (err) {
      execution.completedAt = new Date().toISOString();
      execution.durationMs = Date.now() - new Date(execution.startedAt).getTime();
      execution.error = err instanceof Error ? err.message : String(err);
      execution.status = execution.error.includes('timeout') ? 'timeout' : 'failed';

      logEvent('cron', 'high', `Cron ${execution.status}: ${job.name}`,
        { jobId: job.id, jobName: job.name, trigger,
          durationMs: execution.durationMs, error: execution.error },
      ).catch(() => {});

      await this.updateJobRunState(job.id, {
        lastRun: execution.startedAt,
        lastRunDurationMs: execution.durationMs,
        lastRunError: execution.error.slice(0, 200),
        status: 'error',
      });
    }

    // Log execution
    await this.logExecution(execution);

    // Update nextRun
    const cronInstance = this.cronInstances.get(job.id);
    if (cronInstance) {
      const nextRun = cronInstance.nextRun();
      if (nextRun) {
        await this.updateJobField(job.id, 'nextRun', nextRun.toISOString());
      }
    }

    // Emit SSE event
    eventBus.emitEvent('cron:status', {
      type: 'cron:execution',
      jobId: job.id,
      jobName: job.name,
      execution,
    });

    return execution;
  }

  // ============================================
  // Job Type Executors
  // ============================================

  /**
   * Execute a shell command with a hard wall-clock timeout.
   *
   * 2026-05-18 rewrite — was `promisify(exec)` which buffered the child's
   * stdout/stderr unbounded into JS strings, then on timeout-kill resolved the
   * promise synchronously with the full buffered strings. With a chatty child
   * (e.g. `bash model-changelog-fetch.sh` doing curl + diff output) this stalled
   * the main event loop for ~9.6s during the resolve path (observed 2026-05-17
   * 23:01:02). Cascaded: 13 health checks + all `/api/collab` requests timed
   * out simultaneously then recovered together when the loop drained.
   *
   * The rewrite:
   *   - Uses `spawn` instead of `exec` so stdio is streamed, not accumulated.
   *   - Caps each stream at MAX_STDIO_BYTES (16 KB) with a rolling tail — once
   *     full, additional chunks overwrite the oldest, so a runaway child can
   *     never balloon parent RSS.
   *   - Spawns in a new process group (`detached: true`) so we can kill the
   *     whole tree (including any backgrounded shell jobs) via `process.kill(-pid)`.
   *   - On timeout: SIGTERM the group, schedule SIGKILL after SIGKILL_GRACE_MS
   *     via `setTimeout` (NON-blocking — event loop stays responsive while the
   *     child winds down). Both signals are best-effort; we resolve as soon as
   *     the child emits `close`, regardless of which signal won.
   */
  private async execShell(command: string, timeout: number): Promise<{ output: string; exitCode: number }> {
    if (!command) throw new Error('No command specified');

    const MAX_STDIO_BYTES = 64 * 1024;       // 64 KB rolling tail per stream — enough for a useful crash report, can't OOM
    const SIGKILL_GRACE_MS = 2000;            // wait this long after SIGTERM before SIGKILL

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: appRoot(),
        env: { ...process.env },
        detached: true,                      // own process group; lets us kill the whole tree via -pid
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Bounded rolling-tail buffers — never grow past MAX_STDIO_BYTES per stream.
      const tailBuf = (): { append: (chunk: Buffer) => void; toString: () => string } => {
        const chunks: Buffer[] = [];
        let totalLen = 0;
        return {
          append(chunk: Buffer): void {
            chunks.push(chunk);
            totalLen += chunk.length;
            while (totalLen > MAX_STDIO_BYTES && chunks.length > 1) {
              const dropped = chunks.shift()!;
              totalLen -= dropped.length;
            }
            if (totalLen > MAX_STDIO_BYTES && chunks.length === 1) {
              const overshoot = totalLen - MAX_STDIO_BYTES;
              chunks[0] = chunks[0].subarray(overshoot);
              totalLen = MAX_STDIO_BYTES;
            }
          },
          toString(): string {
            return Buffer.concat(chunks, totalLen).toString('utf8');
          },
        };
      };
      const stdoutBuf = tailBuf();
      const stderrBuf = tailBuf();

      child.stdout?.on('data', (c: Buffer) => stdoutBuf.append(c));
      child.stderr?.on('data', (c: Buffer) => stderrBuf.append(c));

      let killedByTimeout = false;
      let sigtermSentAt: number | null = null;
      let sigkillSentAt: number | null = null;
      let sigkillTimer: NodeJS.Timeout | null = null;

      // Best-effort kill the whole process group (negative pid). Wrapped because
      // the group may already have exited between the timeout firing and the
      // signal landing — both signals can ESRCH and that's fine.
      const killGroup = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, signal);
          }
        } catch {
          // ESRCH: child or group already gone. Not an error.
        }
      };

      const timeoutTimer = setTimeout(() => {
        killedByTimeout = true;
        sigtermSentAt = Date.now();
        killGroup('SIGTERM');
        // Escalate to SIGKILL after a grace period — scheduled via setTimeout
        // so the event loop is never blocked waiting for the child to die.
        sigkillTimer = setTimeout(() => {
          sigkillSentAt = Date.now();
          killGroup('SIGKILL');
        }, SIGKILL_GRACE_MS);
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve({
          output: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        const stdoutStr = stdoutBuf.toString();
        const stderrStr = stderrBuf.toString();
        let output: string;
        let exitCode: number;
        if (killedByTimeout) {
          // Match the historical contract: keep the "Process killed (timeout)"
          // marker so downstream classifiers (e.g. inferValidationStatusCode)
          // still recognise this as a timeout vs. a generic non-zero exit.
          // Also tag which signal ultimately won so the cron history shows
          // whether SIGTERM was honoured cleanly or we had to fall through
          // to SIGKILL (= the child was ignoring termination).
          const winner = sigkillSentAt !== null ? 'SIGKILL (SIGTERM ignored)' : (signal || 'SIGTERM');
          const tail = (stdoutStr || stderrStr) ? `\n--- last output before kill ---\n${stdoutStr}${stderrStr ? '\nSTDERR:\n' + stderrStr : ''}` : '';
          output = `Process killed (timeout, via ${winner})${tail}`;
          exitCode = 137;
        } else if (signal) {
          output = `Process killed by signal ${signal}\n${stdoutStr}${stderrStr ? '\nSTDERR:\n' + stderrStr : ''}`.trim();
          exitCode = 128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1);
        } else {
          output = (stdoutStr + (stderrStr ? '\nSTDERR:\n' + stderrStr : '')).trim();
          exitCode = code ?? 1;
        }
        resolve({ output, exitCode });
      });
    });
  }

  private async execTmuxSend(
    target: string,
    text: string,
    timeout: number,
    agentName?: string,
  ): Promise<{ output: string }> {
    // Prefer dynamic resolution by agent name — survives tmux session respawns.
    // Falls back to static target if no agentName or resolver returns null.
    let resolvedTarget = target;
    if (agentName) {
      const live = await resolveAgentTmuxSession(agentName);
      if (live) {
        resolvedTarget = live;
      } else if (!target) {
        throw new Error(`No tmux target specified (agent '${agentName}' not found in any roster)`);
      }
    }

    if (!resolvedTarget) throw new Error('No tmux target specified');
    if (!text) throw new Error('No tmux text specified');

    // Send keys to tmux session, then Enter
    const cmd = `tmux send-keys -t ${JSON.stringify(resolvedTarget)} ${JSON.stringify(text)} Enter`;

    try {
      const { stdout } = await execAsync(cmd, { timeout });
      const label = agentName ? `${agentName} (${resolvedTarget})` : resolvedTarget;
      return { output: `Sent to tmux ${label}: ${text}\n${stdout}`.trim() };
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      throw new Error(`tmux send failed: ${execErr.stderr || execErr.message || String(err)}`);
    }
  }

  private async execApiCall(
    url: string,
    method: string,
    headers?: Record<string, string>,
    body?: string,
    timeout?: number,
  ): Promise<{ output: string }> {
    if (!url) throw new Error('No API URL specified');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || DEFAULT_TIMEOUT_MS);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        signal: controller.signal,
      };

      if (body && method !== 'GET') {
        fetchOptions.body = body;
      }

      const response = await fetch(url, fetchOptions);
      const responseText = await response.text();

      return {
        output: `${response.status} ${response.statusText}\n${responseText}`.trim(),
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`API call timeout after ${timeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================
  // Data Persistence Helpers
  // ============================================

  private async updateJobField(jobId: string, field: string, value: unknown): Promise<void> {
    await withFileLock(DataPaths.cronJobs, async () => {
      const data = await readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' });
      const job = data.jobs.find(j => j.id === jobId);
      if (job) {
        (job as unknown as Record<string, unknown>)[field] = value;
        job.updatedAt = new Date().toISOString();
        data.lastUpdated = new Date().toISOString();
        await writeJsonFile(DataPaths.cronJobs, data);
      }
    });
  }

  private async updateJobRunState(jobId: string, updates: Partial<CronJob>): Promise<void> {
    await withFileLock(DataPaths.cronJobs, async () => {
      const data = await readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' });
      const job = data.jobs.find(j => j.id === jobId);
      if (job) {
        Object.assign(job, updates);
        job.updatedAt = new Date().toISOString();
        data.lastUpdated = new Date().toISOString();
        await writeJsonFile(DataPaths.cronJobs, data);
      }
    });
  }

  private async logExecution(execution: CronExecution): Promise<void> {
    const logPath = cronLogFile(execution.jobId);

    await withFileLock(logPath, async () => {
      const logData = await readJsonFile<CronJobLogData>(logPath, {
        jobId: execution.jobId,
        executions: [],
        lastUpdated: '',
      });

      logData.executions.push(execution);

      // Trim to max executions
      if (logData.executions.length > MAX_EXECUTIONS_PER_JOB) {
        logData.executions = logData.executions.slice(-MAX_EXECUTIONS_PER_JOB);
      }

      logData.lastUpdated = new Date().toISOString();
      await writeJsonFile(logPath, logData);
    });
  }

  /**
   * Sync service-defined cron jobs from project configs.
   * Creates cron jobs for services that define cronJobs in their config.
   * Tags them with `service:{projectId}` for lifecycle management.
   * Removes orphaned service cron jobs if the service config changes.
   */
  async syncServiceCronJobs(projects: Project[]): Promise<void> {
    await withFileLock(DataPaths.cronJobs, async () => {
      const data = await readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' });

      // Collect all desired service cron jobs
      const desiredJobs = new Map<string, { project: Project; cronJob: ServiceCronJob }>();

      for (const project of projects) {
        if (!project.server?.cronJobs) continue;
        for (const svc of project.server.cronJobs) {
          const key = `service:${project.id}:${svc.name}`;
          desiredJobs.set(key, { project, cronJob: svc });
        }
      }

      // Find existing service-tagged cron jobs
      const existingServiceJobs = data.jobs.filter(j =>
        j.tags?.some(t => t.startsWith('service:'))
      );

      // Remove orphaned service jobs (in config but no longer defined)
      const toRemove = existingServiceJobs.filter(j => {
        const serviceTag = j.tags?.find(t => t.startsWith('service:'));
        return serviceTag && !desiredJobs.has(serviceTag);
      });

      for (const job of toRemove) {
        const idx = data.jobs.indexOf(job);
        if (idx >= 0) {
          data.jobs.splice(idx, 1);
          console.log(`[CronScheduler] Removed orphaned service cron job: ${job.name}`);
        }
      }

      // Create missing service jobs
      for (const [key, { project, cronJob }] of desiredJobs) {
        const exists = data.jobs.some(j => j.tags?.includes(key));
        if (exists) continue;

        const now = new Date().toISOString();
        let jobType: CronJob['jobType'] = 'shell';
        let command: string | undefined;

        if (cronJob.action === 'restart') {
          // Build restart command: stop then start
          const parts: string[] = [];
          if (project.server?.stopCommand) parts.push(project.server.stopCommand);
          if (project.server?.startCommand) parts.push(project.server.startCommand);
          command = parts.join(' && ');
          jobType = 'shell';
        } else if (cronJob.action === 'shell') {
          command = cronJob.command;
          jobType = 'shell';
        }

        const newJob: CronJob = {
          id: uuidv4(),
          name: `[${project.name}] ${cronJob.name}`,
          schedule: cronJob.schedule,
          jobType,
          enabled: cronJob.enabled !== false,
          command,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          createdBy: 'system',
          tags: [key, `service:${project.id}`],
          description: cronJob.description || `Auto-generated from ${project.name} service config`,
        };

        data.jobs.push(newJob);
        console.log(`[CronScheduler] Created service cron job: ${newJob.name} (${cronJob.schedule})`);
      }

      data.lastUpdated = new Date().toISOString();
      await writeJsonFile(DataPaths.cronJobs, data);
    });
  }

  /**
   * Get the next run time for a job (if scheduled).
   */
  getNextRun(jobId: string): Date | null {
    const cron = this.cronInstances.get(jobId);
    return cron ? cron.nextRun() : null;
  }

  /**
   * Check if the scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get count of active scheduled jobs.
   */
  getActiveJobCount(): number {
    return this.cronInstances.size;
  }
}

// ============================================
// Singleton (survives hot reloads)
// ============================================

const globalForCron = globalThis as typeof globalThis & {
  __cronScheduler?: CronScheduler;
};

export const cronScheduler: CronScheduler =
  globalForCron.__cronScheduler ?? new CronScheduler();

globalForCron.__cronScheduler = cronScheduler;
