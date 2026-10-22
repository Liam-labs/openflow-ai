/**
 * Keep Alive Actions (Agent API)
 *
 * Manages persistent keep-alive pings for roster agents.
 * Cron jobs fire at the configured interval, sending goal-directed
 * messages to keep agents focused and auto-respawning crashed ones.
 *
 * Modes: start, stop, status, update, ping (internal — called by cron)
 *
 * Event-driven nudge (the owner 30 Sep 2026: "nothing is going to prompt you to keep
 * working once the build finished"): the idle monitor below watches agent
 * activity and nudges a keep-alive agent ~90s after it goes idle, instead of
 * leaving it idle until the next cron tick. The cron stays as the safety net
 * (respawn + periodic check) but no longer interrupts an agent mid-task.
 */

import type {
  AgentApiRequest,
  AgentAuthContext,
  AgentRosterEntry,
  CollabParticipant,
  CollabChannelsData,
  CronJobsData,
} from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { cronScheduler } from '@/lib/cron-scheduler';
import { appendMessage } from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { selfOrigin } from '@/lib/self-origin';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KeepAliveConfig {
  channelId: string;
  agentId: string;
  participantId: string;
  agentName: string;
  goal: string;
  goalFile: string;
  duration: string;
  interval: string;
  selfEvolving: boolean;
  startedAt: string;
  expiresAt: string | null;   // null for "indefinite"
  status: 'active' | 'stopped' | 'expired';
  cronJobId?: string;
  lastPingedAt?: string;      // ISO timestamp of most recent ping
}

type KeepAliveMode = 'start' | 'stop' | 'status' | 'update' | 'ping';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEEP_ALIVE_DIR = path.join(DataPaths.base, 'keep-alive');

const VALID_DURATIONS = ['1h', '2h', '4h', '8h', 'indefinite'] as const;
const VALID_INTERVALS = ['5m', '10m', '15m', '30m', '1h'] as const;

const DURATION_MS: Record<string, number> = {
  '1h': 3600000,
  '2h': 7200000,
  '4h': 14400000,
  '8h': 28800000,
};

const INTERVAL_MS: Record<string, number> = {
  '5m': 300000,
  '10m': 600000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
};

const INTERVAL_CRON: Record<string, string> = {
  '5m': '*/5 * * * *',
  '10m': '*/10 * * * *',
  '15m': '*/15 * * * *',
  '30m': '*/30 * * * *',
  '1h': '0 * * * *',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PTY_API_URL = `${selfOrigin()}/api/collab/pty`;

const IDLE_NUDGE_DELAY_MS = 90_000;      // idle this long after working → nudge
const MIN_PING_GAP_MS = 3 * 60_000;      // never nudge more often than this
const BUSY_FRESH_MS = 90_000;            // wrapper heartbeats refresh activity every 30s

/**
 * Call /api/collab/pty and return both HTTP status and body so callers can
 * propagate 4xx status codes on thrown errors (T2.2/T2.3 root cause fix).
 */
interface PtyCallResult {
  status: number;
  body: { success?: boolean; error?: string; [k: string]: unknown };
}
async function callPtyApi(body: Record<string, unknown>): Promise<PtyCallResult> {
  const res = await fetch(PTY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed as PtyCallResult['body'] };
}

function ptyErrorStatusCode(status: number): number {
  return status >= 400 && status < 600 ? status : 500;
}

function configPath(channelId: string, agentId: string): string {
  return path.join(KEEP_ALIVE_DIR, `${channelId}-${agentId}.json`);
}

function goalPath(channelId: string, agentId: string): string {
  return path.join(KEEP_ALIVE_DIR, `${channelId}-${agentId}.md`);
}

async function ensureKeepAliveDir(): Promise<void> {
  await fs.mkdir(KEEP_ALIVE_DIR, { recursive: true });
}

async function readConfig(channelId: string, agentId: string): Promise<KeepAliveConfig | null> {
  const fp = configPath(channelId, agentId);
  const data = await readJsonFile<KeepAliveConfig | null>(fp, null);
  return data;
}

async function writeConfig(config: KeepAliveConfig): Promise<void> {
  const fp = configPath(config.channelId, config.agentId);
  await writeJsonFile(fp, config);
}

function makeSystemSender(): CollabParticipant {
  const now = new Date().toISOString();
  return {
    id: 'system',
    type: 'user',
    name: 'System',
    source: 'DevFlow',
    joinedAt: now,
    lastSeen: now,
  };
}

async function sendChannelMessage(channelId: string, content: string, mentions?: string[]): Promise<void> {
  const message = {
    id: randomUUID(),
    channelId,
    from: makeSystemSender(),
    content,
    timestamp: new Date().toISOString(),
    mentions,
    system: true,
    metadata: { isHidden: true },
  };
  await appendMessage(channelId, message);
  // Emit SSE event so real-time listeners (agents via collab-claude wrapper, Grok, frontend) receive it
  eventBus.emitEvent('collab:message', { channelId, message });
}

async function getApiToken(): Promise<string> {
  const token = process.env.DEVFLOW_API_TOKEN;
  if (!token) throw new Error('DEVFLOW_API_TOKEN not set — cannot create keep-alive cron job');
  return token;
}

// Creates (or recreates) the cron job for a keep-alive config
async function createCronJob(config: KeepAliveConfig): Promise<string> {
  const token = await getApiToken();
  const cronSchedule = INTERVAL_CRON[config.interval];
  if (!cronSchedule) throw new Error(`Invalid interval: ${config.interval}`);

  const res = await fetch(`${selfOrigin()}/api/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'cron.create',
      name: `keep-alive-${config.agentName}`,
      schedule: cronSchedule,
      jobType: 'api-call',
      apiUrl: `${selfOrigin()}/api/agent`,
      apiMethod: 'POST',
      apiHeaders: { 'Authorization': `Bearer ${token}` },
      apiBody: JSON.stringify({
        action: 'roster.keepAlive',
        mode: 'ping',
        channelId: config.channelId,
        agentId: config.agentId,
      }),
      description: `Keep-alive ping for ${config.agentName} (${config.interval})`,
      tags: ['keep-alive', config.agentName.toLowerCase()],
      createdBy: 'keep-alive-system',
    }),
  });

  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Failed to create cron job');
  return data.data.job.id;
}

/**
 * Purge ALL keep-alive crons for a given agent by tag.
 * Reads the cron data directly — no HTTP self-call, no auth token needed.
 */
async function purgeKeepAliveCrons(agentName: string): Promise<string[]> {
  const cronPath = DataPaths.cronJobs;
  const defaultData: CronJobsData = { jobs: [], lastUpdated: '' };
  let removedIds: string[] = [];

  await withFileLock(cronPath, async () => {
    const data = await readJsonFile<CronJobsData>(cronPath, defaultData);
    const agentTag = agentName.toLowerCase();
    const toRemove = data.jobs.filter(j =>
      j.tags?.includes('keep-alive') && j.tags?.includes(agentTag)
    );
    if (toRemove.length === 0) return;

    removedIds = toRemove.map(j => j.id);
    data.jobs = data.jobs.filter(j => !removedIds.includes(j.id));
    data.lastUpdated = new Date().toISOString();
    await writeJsonFile(cronPath, data);
  });

  if (removedIds.length > 0) {
    await cronScheduler.reloadJobs();
  }
  return removedIds;
}

// ---------------------------------------------------------------------------
// Mode Handlers
// ---------------------------------------------------------------------------

async function handleStart(body: AgentApiRequest): Promise<Record<string, unknown>> {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  const goal = body.goal as string;
  const duration = (body.duration as string) || '4h';
  const interval = (body.interval as string) || '15m';
  const selfEvolving = !!body.selfEvolving;

  if (!channelId || !agentId || !goal) {
    throw new Error('channelId, agentId, and goal are required');
  }
  if (!VALID_DURATIONS.includes(duration as typeof VALID_DURATIONS[number])) {
    throw new Error(`Invalid duration: ${duration}. Must be one of: ${VALID_DURATIONS.join(', ')}`);
  }
  if (!VALID_INTERVALS.includes(interval as typeof VALID_INTERVALS[number])) {
    throw new Error(`Invalid interval: ${interval}. Must be one of: ${VALID_INTERVALS.join(', ')}`);
  }

  // Look up agent in roster (outside lock — read-only, no race concern)
  const { status: rosterStatus, body: rosterData } = await callPtyApi({ action: 'roster_list', channelId });
  if (!rosterData.success) throw Object.assign(new Error(rosterData.error || 'Failed to list roster'), { statusCode: ptyErrorStatusCode(rosterStatus) });
  const agent = (rosterData.agents as AgentRosterEntry[]).find(a => a.id === agentId);
  if (!agent) throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 });

  await ensureKeepAliveDir();

  // Entire read-check-create-write flow under one lock to prevent TOCTOU races
  const fp = configPath(channelId, agentId);
  const config = await withFileLock(fp, async () => {
    // Check for existing active keep-alive (inside lock)
    const existing = await readConfig(channelId, agentId);
    if (existing && existing.status === 'active') {
      throw new Error('Keep-alive already active for this agent. Stop it first or use update.');
    }

    // Purge any orphaned keep-alive crons for this agent before creating a new one
    await purgeKeepAliveCrons(agent.name);

    const now = new Date();
    const expiresAt = duration === 'indefinite'
      ? null
      : new Date(now.getTime() + DURATION_MS[duration]).toISOString();

    const newConfig: KeepAliveConfig = {
      channelId,
      agentId,
      participantId: agent.participantId,
      agentName: agent.name,
      goal,
      goalFile: goalPath(channelId, agentId),
      duration,
      interval,
      selfEvolving,
      startedAt: now.toISOString(),
      expiresAt,
      status: 'active',
    };

    // Save goal file
    await fs.writeFile(newConfig.goalFile, goal, 'utf-8');

    // Create cron job
    const cronJobId = await createCronJob(newConfig);
    newConfig.cronJobId = cronJobId;

    // Save config
    await writeConfig(newConfig);
    return newConfig;
  });

  return { config, started: true };
}

async function handleStop(body: AgentApiRequest): Promise<Record<string, unknown>> {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const fp = configPath(channelId, agentId);
  const config = await readConfig(channelId, agentId);
  if (!config) return { active: false, message: 'No keep-alive found' };

  // Delete cron jobs directly from the data file (no HTTP self-call).
  // First remove by tracked ID, then purge by tag as safety net for orphans.
  const cronPath = DataPaths.cronJobs;
  const defaultCronData: CronJobsData = { jobs: [], lastUpdated: '' };
  let removedCount = 0;

  await withFileLock(cronPath, async () => {
    const data = await readJsonFile<CronJobsData>(cronPath, defaultCronData);
    const before = data.jobs.length;

    // Remove by tracked cronJobId
    if (config.cronJobId) {
      data.jobs = data.jobs.filter(j => j.id !== config.cronJobId);
    }

    // Also remove any orphaned keep-alive crons for this agent (by tag)
    const agentTag = config.agentName.toLowerCase();
    data.jobs = data.jobs.filter(j =>
      !(j.tags?.includes('keep-alive') && j.tags?.includes(agentTag))
    );

    removedCount = before - data.jobs.length;
    if (removedCount > 0) {
      data.lastUpdated = new Date().toISOString();
      await writeJsonFile(cronPath, data);
    }

    // Mark config stopped inside the same critical section so PM2 restart
    // between cron removal and config update can't leave a stale 'active' state.
    config.status = 'stopped';
    await writeJsonFile(fp, config);
  });

  // Reload scheduler to stop in-memory cron instances
  if (removedCount > 0) {
    await cronScheduler.reloadJobs();
  }

  return { stopped: true, agentName: config.agentName };
}

async function handleStatus(body: AgentApiRequest): Promise<Record<string, unknown>> {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const config = await readConfig(channelId, agentId);
  if (!config || config.status !== 'active') {
    return { active: false };
  }

  // Server-side expiry check — auto-expire if past expiresAt
  if (config.expiresAt && Date.now() >= new Date(config.expiresAt).getTime()) {
    await purgeKeepAliveCrons(config.agentName);
    config.status = 'expired';
    await withFileLock(configPath(channelId, agentId), async () => {
      await writeConfig(config);
    });
    return { active: false, expired: true, expiresAt: config.expiresAt };
  }

  // Calculate time remaining until expiry
  let remainingMs: number | null = null;
  if (config.expiresAt) {
    remainingMs = new Date(config.expiresAt).getTime() - Date.now();
    if (remainingMs < 0) remainingMs = 0;
  }

  // Calculate next ping time based on last ping (or startedAt if never pinged)
  const intervalMs = INTERVAL_MS[config.interval] ?? 900000;
  const baseTime = config.lastPingedAt
    ? new Date(config.lastPingedAt).getTime()
    : new Date(config.startedAt).getTime();
  const nextPingAt = new Date(baseTime + intervalMs).toISOString();

  return {
    active: true,
    config,
    remainingMs,
    nextPingAt,
  };
}

async function handleUpdate(body: AgentApiRequest): Promise<Record<string, unknown>> {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const fp = configPath(channelId, agentId);
  const config = await readConfig(channelId, agentId);
  if (!config || config.status !== 'active') {
    throw new Error('No active keep-alive to update');
  }

  const goal = body.goal as string | undefined;
  const duration = body.duration as string | undefined;
  const interval = body.interval as string | undefined;
  const selfEvolving = body.selfEvolving as boolean | undefined;

  if (duration && !VALID_DURATIONS.includes(duration as typeof VALID_DURATIONS[number])) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  if (interval && !VALID_INTERVALS.includes(interval as typeof VALID_INTERVALS[number])) {
    throw new Error(`Invalid interval: ${interval}`);
  }

  // Update fields
  if (goal !== undefined) {
    config.goal = goal;
    await fs.writeFile(config.goalFile, goal, 'utf-8');
  }
  if (duration !== undefined) {
    config.duration = duration;
    config.expiresAt = duration === 'indefinite'
      ? null
      : new Date(new Date(config.startedAt).getTime() + DURATION_MS[duration]).toISOString();
  }
  if (selfEvolving !== undefined) {
    config.selfEvolving = selfEvolving;
  }

  // Recreate cron job if interval changed
  if (interval !== undefined && interval !== config.interval) {
    // Purge all existing keep-alive crons for this agent (catches orphans too)
    await purgeKeepAliveCrons(config.agentName);
    config.interval = interval;
    const cronJobId = await createCronJob(config);
    config.cronJobId = cronJobId;
  }

  await withFileLock(fp, async () => {
    await writeConfig(config);
  });

  return { updated: true, config };
}

/**
 * Ping handler — called by the cron job on each interval.
 *
 * 1. Check expiry → auto-stop if expired
 * 2. Check agent status → auto-respawn if crashed/stopped
 * 3. Check idle → nudge if agent silent for 2x interval
 * 4. Send the keep-alive message with goal directive
 */
async function handlePing(body: AgentApiRequest): Promise<Record<string, unknown>> {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  const config = await readConfig(channelId, agentId);
  if (!config || config.status !== 'active') {
    return { pinged: false, reason: 'no active keep-alive' };
  }

  // 1. Expiry check
  if (config.expiresAt && Date.now() >= new Date(config.expiresAt).getTime()) {
    const expiryMsg = `@${config.agentName} KEEP-ALIVE EXPIRED: Your ${config.duration} keep-alive session has ended. Save your progress to today.md.`;
    await sendChannelMessage(channelId, expiryMsg, [config.participantId]);

    // Auto-stop: purge all keep-alive crons for this agent (catches orphans)
    await purgeKeepAliveCrons(config.agentName);
    await withFileLock(configPath(channelId, agentId), async () => {
      config.status = 'expired';
      await writeConfig(config);
    });

    return { pinged: false, reason: 'expired', expiryMessage: expiryMsg };
  }

  // 2. Agent status check + auto-respawn
  let respawned = false;
  try {
    const { body: rosterData } = await callPtyApi({ action: 'roster_list', channelId });
    if (rosterData.success) {
      const agent = (rosterData.agents as AgentRosterEntry[]).find(a => a.id === agentId);
      if (agent && (agent.status === 'stopped' || agent.status === 'crashed')) {
        // Attempt respawn before sending the ping
        const { body: spawnResult } = await callPtyApi({ action: 'roster_spawn', channelId, agentId });
        respawned = spawnResult.success === true;
      }
    }
  } catch {
    // Non-fatal — continue with ping even if status check fails
  }

  // 3. Activity check. lastSeen is refreshed by heartbeats, so it can never
  //    show idleness; the wrapper-reported activityStatus can. A working agent
  //    is left alone — a ping mid-task only interrupts it.
  const activity = await readAgentActivity(channelId, config.participantId);
  if (activity === 'busy' && !respawned) {
    return { pinged: false, reason: 'agent busy' };
  }
  const idle = body.trigger === 'idle' || activity === 'idle';
  if (body.trigger === 'idle' && config.lastPingedAt
      && Date.now() - new Date(config.lastPingedAt).getTime() < MIN_PING_GAP_MS) {
    return { pinged: false, reason: 'pinged recently' };
  }

  // 4. Build and send the message
  const goalFirstLine = config.goal.split('\n')[0].slice(0, 200);
  let message: string;

  if (idle) {
    message = `@${config.agentName} ⚡ KEEP-ALIVE — DO NOT IGNORE. This message REQUIRES ACTION unless you are actively executing a specific task RIGHT NOW. You appear idle: read your goal file at ${config.goalFile} and resume work. If your backlog is genuinely empty, dispatch sub-tasks against the goal (catalog issues, follow-ups, tests, refactors) — "holding idle" / "standing by" is NOT a valid response when a goal is set. If truly blocked, post a visible blocker (not a silent hold) so the user can intervene.`;
  } else {
    message = `@${config.agentName} ⚡ KEEP-ALIVE — DO NOT IGNORE. This message REQUIRES ACTION unless you are actively executing a specific task RIGHT NOW. Objective: ${goalFirstLine}. Brief: ${config.goalFile}. If the current task is done, decompose the goal into the next concrete sub-task and dispatch it — do not stop, do not "hold idle", do not journal "no new work". Manufactured churn is bad; deliberate slow-down when work remains is worse.`;
  }

  // Append Self-Evolving directive
  if (config.selfEvolving) {
    message += `\nSELF-EVOLVING MODE: If you encounter a blocker you cannot resolve, provision or @mention a Researcher agent to investigate. Do not stop working — find another task from your goal file while waiting.`;
  }

  await sendChannelMessage(channelId, message, [config.participantId]);

  // Record last ping time
  await withFileLock(configPath(channelId, agentId), async () => {
    const fresh = await readConfig(channelId, agentId);
    if (fresh && fresh.status === 'active') {
      fresh.lastPingedAt = new Date().toISOString();
      await writeConfig(fresh);
    }
  });

  return {
    pinged: true,
    agentName: config.agentName,
    idle,
    respawned,
    selfEvolving: config.selfEvolving,
  };
}

async function readAgentActivity(channelId: string, participantId: string): Promise<'busy' | 'idle' | 'unknown'> {
  try {
    const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, { channels: [], lastUpdated: '' });
    const p = data.channels.find(c => c.id === channelId)?.participants.find(x => x.id === participantId);
    if (!p?.activityStatus || !p.activityUpdatedAt) return 'unknown';
    const fresh = Date.now() - new Date(p.activityUpdatedAt).getTime() < BUSY_FRESH_MS;
    if (fresh && (p.activityStatus === 'working' || p.activityStatus === 'typing')) return 'busy';
    return p.activityStatus === 'idle' ? 'idle' : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function findActiveConfig(channelId: string, participantId: string): Promise<KeepAliveConfig | null> {
  try {
    for (const file of await fs.readdir(KEEP_ALIVE_DIR)) {
      if (!file.startsWith(channelId) || !file.endsWith('.json')) continue;
      const config = await readJsonFile<KeepAliveConfig | null>(path.join(KEEP_ALIVE_DIR, file), null);
      if (config?.status === 'active' && config.participantId === participantId) return config;
    }
  } catch { /* no keep-alive dir yet */ }
  return null;
}

// ---------------------------------------------------------------------------
// Idle monitor — nudge a keep-alive agent soon after it goes idle
// ---------------------------------------------------------------------------

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Pure decision used by the monitor (exported for tests). */
export function nextIdleTimerAction(status: string, hasTimer: boolean): 'start' | 'cancel' | 'keep' {
  if (status === 'idle') return hasTimer ? 'keep' : 'start';  // heartbeats repeat 'idle' every 30s
  return hasTimer ? 'cancel' : 'keep';
}

export function startKeepAliveIdleMonitor(): () => void {
  const listener = (event: { type: string; data: unknown }) => {
    if (event.type !== 'collab:typing') return;
    const { channelId, participantId, activityStatus } = (event.data || {}) as {
      channelId?: string; participantId?: string; activityStatus?: string;
    };
    if (!channelId || !participantId || !activityStatus) return;
    const key = `${channelId}:${participantId}`;
    const action = nextIdleTimerAction(activityStatus, idleTimers.has(key));
    if (action === 'cancel') {
      clearTimeout(idleTimers.get(key));
      idleTimers.delete(key);
    } else if (action === 'start') {
      const timer = setTimeout(() => {
        idleTimers.delete(key);
        void (async () => {
          const config = await findActiveConfig(channelId, participantId);
          if (!config) return;
          if (await readAgentActivity(channelId, participantId) !== 'idle') return;
          await handlePing({ action: 'roster.keepAlive', mode: 'ping', channelId, agentId: config.agentId, trigger: 'idle' } as AgentApiRequest);
        })().catch(err => console.error('[keep-alive] idle nudge failed:', err instanceof Error ? err.message : err));
      }, IDLE_NUDGE_DELAY_MS);
      timer.unref?.();
      idleTimers.set(key, timer);
    }
  };
  eventBus.on('sse-event', listener);
  return () => {
    eventBus.off('sse-event', listener);
    idleTimers.forEach(t => clearTimeout(t));
    idleTimers.clear();
  };
}

// ---------------------------------------------------------------------------
// Startup Recovery — runs on DevFlow boot (e.g. after WSL restart)
// ---------------------------------------------------------------------------

/**
 * Scan all keep-alive configs. Expire stale ones, recreate missing cron jobs
 * for still-valid ones. Called from instrumentation.ts on startup.
 */
export async function recoverKeepAlives(): Promise<{ expired: number; recovered: number }> {
  let expired = 0;
  let recovered = 0;

  try {
    await ensureKeepAliveDir();
    const files = await fs.readdir(KEEP_ALIVE_DIR);
    const configFiles = files.filter(f => f.endsWith('.json'));

    for (const file of configFiles) {
      try {
        const fp = path.join(KEEP_ALIVE_DIR, file);
        const config = await readJsonFile<KeepAliveConfig | null>(fp, null);
        if (!config || config.status !== 'active') continue;

        // Check expiry
        if (config.expiresAt && Date.now() >= new Date(config.expiresAt).getTime()) {
          await purgeKeepAliveCrons(config.agentName);
          config.status = 'expired';
          await writeJsonFile(fp, config);
          expired++;
          continue;
        }

        // Check if cron job still exists
        const cronData = await readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' });
        const hasCron = config.cronJobId
          ? cronData.jobs.some(j => j.id === config.cronJobId)
          : cronData.jobs.some(j => j.tags?.includes('keep-alive') && j.tags?.includes(config.agentName.toLowerCase()));

        if (!hasCron) {
          // Recreate missing cron job
          try {
            const cronJobId = await createCronJob(config);
            config.cronJobId = cronJobId;
            await writeJsonFile(fp, config);
            recovered++;
          } catch (err) {
            console.error(`[keep-alive] Failed to recover cron for ${config.agentName}:`, err instanceof Error ? err.message : err);
          }
        }
      } catch {
        // Skip individual config file errors
      }
    }
  } catch {
    // Keep-alive dir doesn't exist yet — nothing to recover
  }

  return { expired, recovered };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export async function keepAlive(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<Record<string, unknown>> {
  const mode = body.mode as KeepAliveMode;
  if (!mode) throw new Error('mode is required (start, stop, status, update, ping)');

  switch (mode) {
    case 'start':  return handleStart(body);
    case 'stop':   return handleStop(body);
    case 'status': return handleStatus(body);
    case 'update': return handleUpdate(body);
    case 'ping':   return handlePing(body);
    default:
      throw new Error(`Invalid keep-alive mode: ${mode}`);
  }
}
