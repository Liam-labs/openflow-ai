/**
 * Delivery health monitor
 *
 * Reads delivery-status telemetry and the durable-delivery ledger every five
 * minutes. Alerts via the stability-alerts channel when failures cross their
 * thresholds or a replayable recipient queue stops making progress.
 *
 * Thresholds (configurable via env):
 *   DELIVERY_FAILURE_COUNT_THRESHOLD  — failures per agent per hour (default: 5)
 *   DELIVERY_FAILURE_RATE_THRESHOLD   — failure rate 0–1 per agent per hour (default: 0.10)
 *   DELIVERY_ALERT_COOLDOWN_MINS      — minutes between repeat alerts per agent (default: 30)
 *   DELIVERY_BACKLOG_ALERT_MINS       — oldest replayable record age (default: 5)
 *   DELIVERY_STUCK_MINS               — idle Codex seat leaving its queue unclaimed this long is "stuck" (default: 3)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getTelemetryStorePath, type DeliveryEvent } from '../delivery-telemetry';
import {
  DELIVERY_RECONCILIATION_WINDOW_MS,
  enqueueDurableDeliveries,
  getDeliveryRecords,
  quarantineStalePendingDeliveries,
  resolveDurableRecipientIds,
  type DeliveryRecord,
} from '../collab-delivery-ledger';
import { postStabilityAlert } from '../stability-alerts';
import { DataPaths } from '../data-paths';
import { readJsonFile } from '../data-io';
import { readChannelMessages } from '../collab-message-io';
import type { CollabChannelsData } from '../types';
import { participantReachable, ONLINE_THRESHOLD_MS } from '../collab-presence';
import { replaceStuckSeats, seatKey, type StuckSeat } from '../collab-seat-health';
import { appRoot } from '@/lib/app-paths';

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STUCK_CHECK_INTERVAL = 60 * 1000; // stuck-seat sweep: 1 minute
const STUCK_CONFIRM_MS = 60 * 1000; // a seat must look stuck on two sweeps before it is reported
const WINDOW_HOURS = 1;

// Sprint 51 T1 — verifier false-positives that must NOT trigger alerts.
// Mirrors NON_FAILURE_REASONS in delivery-telemetry.ts. Kept local to keep
// this module independently testable without cross-module coupling.
const NON_ALERT_FAILURE_REASONS = new Set<string>([
  'jsonl_ingestion_timeout',
  'jsonl_verify_timeout_noreinject',
]);

// Sprint 57 T2 — defense-in-depth. Even after the Python test harness was
// fixed to mock log_delivery_event (Sprint 57 T1), any future test or ad-hoc
// script that POSTs to /api/collab/delivery-status with a test-origin agent
// name would still leak into telemetry. Drop these before they reach the
// byAgent bucket so they never influence counts OR rate denominators, and so
// they never appear in result arrays consumers might iterate.
//
// Matches: "TestAgent" (exact, case-insensitive), "test-*", "test_*" prefixes.
// Does NOT match: "Tester", "contestant", "latest-agent" — real-looking names
// that happen to contain "test".
const TEST_AGENT_NAME_PATTERN = /^TestAgent$|^test[-_]/i;

export function parsePositiveMinutes(value: string | undefined, fallbackMinutes: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMinutes;
}

function getThresholds() {
  return {
    failureCountThreshold: parseInt(process.env.DELIVERY_FAILURE_COUNT_THRESHOLD ?? '5', 10),
    failureRateThreshold: parseFloat(process.env.DELIVERY_FAILURE_RATE_THRESHOLD ?? '0.10'),
    alertCooldownMs: parseInt(process.env.DELIVERY_ALERT_COOLDOWN_MINS ?? '30', 10) * 60 * 1000,
  };
}

export interface DeliveryAlertOpts {
  windowHours: number;
  failureCountThreshold: number;
  failureRateThreshold: number;
  lastAlertTimes: Record<string, number>; // agentName → epoch ms of last alert
  nowMs: number;
  alertCooldownMs: number;
}

export interface DeliveryCheckResult {
  agentName: string;
  failures: number;
  delivered: number;
  failureRate: number;
  shouldAlert: boolean;
  reason: string;
}

export interface DeliveryBacklogRecord {
  channelId: string;
  participantId: string;
  messageId: string;
  state: string;
  createdAt: string;
}

export interface DeliveryBacklogResult {
  channelId: string;
  participantId: string;
  count: number;
  oldestAgeMs: number;
  oldestMessageId: string;
}

export interface DeliveryLoopResult {
  key: string;
  agentName: string;
  channelId: string;
  participantId: string;
  messageId: string;
  attempts: number;
  windowMs: number;
}

/** Detect repeated attempts for one delivery even when its failure reason is noisy. */
export function evaluateDeliveryLoops(
  events: DeliveryEvent[],
  nowMs: number,
  windowMs = 2 * 60_000,
  threshold = 3,
): DeliveryLoopResult[] {
  const cutoff = nowMs - windowMs;
  const groups = new Map<string, DeliveryLoopResult>();
  for (const event of events) {
    const timestamp = new Date(event.timestamp).getTime();
    if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > nowMs) continue;
    if (event.status !== 'delivery_failure') continue;
    const participantId = event.participantId || 'unknown';
    const channelId = event.channelId || 'unknown';
    const messageId = event.messageId || 'unknown';
    const key = `${channelId}:${participantId}:${messageId}`;
    const current = groups.get(key) || {
      key,
      agentName: event.agentName || participantId,
      channelId,
      participantId,
      messageId,
      attempts: 0,
      windowMs,
    };
    current.attempts += 1;
    groups.set(key, current);
  }
  return [...groups.values()].filter(group => group.attempts >= threshold);
}

/** Find replayable records old enough to indicate a jammed recipient queue. */
export function evaluateDeliveryBacklogs(
  records: DeliveryBacklogRecord[],
  nowMs: number,
  staleAfterMs: number,
): DeliveryBacklogResult[] {
  const replayableStates = new Set(['pending', 'leased', 'submitted']);
  const groups = new Map<string, DeliveryBacklogResult>();

  for (const record of records) {
    if (!replayableStates.has(record.state)) continue;
    const createdMs = new Date(record.createdAt).getTime();
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = Math.max(0, nowMs - createdMs);
    if (ageMs < staleAfterMs) continue;

    const key = `${record.channelId}:${record.participantId}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        channelId: record.channelId,
        participantId: record.participantId,
        count: 1,
        oldestAgeMs: ageMs,
        oldestMessageId: record.messageId,
      });
      continue;
    }
    existing.count += 1;
    if (ageMs > existing.oldestAgeMs) {
      existing.oldestAgeMs = ageMs;
      existing.oldestMessageId = record.messageId;
    }
  }

  return [...groups.values()].sort((a, b) => b.oldestAgeMs - a.oldestAgeMs);
}

/**
 * Pure function: evaluate which agents need delivery alerts.
 * Testable without any I/O.
 */
export function evaluateDeliveryAlerts(
  events: DeliveryEvent[],
  opts: DeliveryAlertOpts
): DeliveryCheckResult[] {
  const cutoff = opts.nowMs - opts.windowHours * 3600 * 1000;

  // Bucket events by agent within the time window
  const byAgent = new Map<string, { failures: number; delivered: number }>();
  const deliveredSeen = new Set<string>();

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    if (e.status !== 'delivery_failure' && e.status !== 'delivered') continue;

    // Sprint 51 T1 — drop verifier false-positives so they don't show up in
    // failure counts OR rate denominators. Real loss reasons keep flowing.
    if (e.status === 'delivery_failure' && NON_ALERT_FAILURE_REASONS.has(e.failureReason ?? '')) {
      continue;
    }

    // Sprint 57 T2 — drop test-origin events entirely so they're invisible to
    // the alerts pipeline. Must happen BEFORE bucket allocation so the agent
    // name never lands in results at all.
    if (TEST_AGENT_NAME_PATTERN.test(e.agentName ?? '')) {
      continue;
    }

    const agent = e.agentName ?? 'unknown';
    if (e.status === 'delivered') {
      const terminalKey = `${agent}:${e.channelId || ''}:${e.participantId || ''}:${e.messageId}`;
      if (deliveredSeen.has(terminalKey)) continue;
      deliveredSeen.add(terminalKey);
    }
    if (!byAgent.has(agent)) byAgent.set(agent, { failures: 0, delivered: 0 });
    const bucket = byAgent.get(agent)!;
    if (e.status === 'delivery_failure') bucket.failures++;
    else bucket.delivered++;
  }

  if (byAgent.size === 0) return [];

  const results: DeliveryCheckResult[] = [];

  for (const [agentName, { failures, delivered }] of byAgent) {
    const total = failures + delivered;
    const failureRate = total > 0 ? failures / total : 0;

    let shouldAlert = false;
    let reason = '';

    const countExceeded = failures > opts.failureCountThreshold;
    const rateExceeded = total > 0 && failureRate > opts.failureRateThreshold;

    if (countExceeded || rateExceeded) {
      // Check cooldown
      const lastAlert = opts.lastAlertTimes[agentName] ?? 0;
      if (opts.nowMs - lastAlert >= opts.alertCooldownMs) {
        shouldAlert = true;
        if (countExceeded && rateExceeded) {
          reason = `failure count (${failures}) exceeds threshold and rate (${(failureRate * 100).toFixed(1)}%) exceeds threshold`;
        } else if (countExceeded) {
          reason = `failure count (${failures}) exceeds threshold of ${opts.failureCountThreshold}`;
        } else {
          reason = `failure rate (${(failureRate * 100).toFixed(1)}%) exceeds threshold of ${(opts.failureRateThreshold * 100).toFixed(0)}%`;
        }
      }
    }

    results.push({ agentName, failures, delivered, failureRate, shouldAlert, reason });
  }

  return results;
}

async function readTelemetryEvents(): Promise<DeliveryEvent[]> {
  try {
    const raw = await fs.readFile(getTelemetryStorePath(), 'utf-8');
    return JSON.parse(raw) as DeliveryEvent[];
  } catch {
    return [];
  }
}

function getMonitorStatePath(): string {
  const appDataDir = process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData';
  const base = path.resolve(appRoot(), appDataDir);
  return path.join(base, 'delivery-monitor-state.json');
}

export async function readAlertCooldowns(): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await fs.readFile(getMonitorStatePath(), 'utf-8')) as { lastAlertTimes?: unknown };
    if (!parsed.lastAlertTimes || typeof parsed.lastAlertTimes !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.lastAlertTimes as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[delivery-monitor] cooldown state read failed:', error);
    }
    return {};
  }
}

export async function writeAlertCooldowns(lastAlertTimes: Record<string, number>): Promise<void> {
  const target = getMonitorStatePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, lastAlertTimes }, null, 2), 'utf-8');
  await fs.rename(tmp, target);
}

interface DeliveryReconciliationDeps {
  readChannels?: () => Promise<CollabChannelsData>;
  readMessages?: typeof readChannelMessages;
  readRecords?: () => Promise<DeliveryRecord[]>;
  enqueue?: typeof enqueueDurableDeliveries;
}

/** Repair canonical-message/ledger gaps after a transient ledger write failure. */
export async function reconcileCanonicalDeliveries(
  nowMs = Date.now(),
  deps: DeliveryReconciliationDeps = {},
): Promise<number> {
  const readChannels = deps.readChannels ?? (() => readJsonFile<CollabChannelsData>(DataPaths.collabChannels, {
    channels: [],
    lastUpdated: new Date(0).toISOString(),
  }));
  const readMessages = deps.readMessages ?? readChannelMessages;
  const readRecords = deps.readRecords ?? (() => getDeliveryRecords({ includeHandled: true }));
  const enqueue = deps.enqueue ?? enqueueDurableDeliveries;
  const [data, deliveryRecords] = await Promise.all([readChannels(), readRecords()]);
  const existingIds = new Set(deliveryRecords.map(record => record.id));
  const cutoff = nowMs - DELIVERY_RECONCILIATION_WINDOW_MS;
  let repaired = 0;
  for (const channel of data.channels) {
    const canonical = await readMessages(channel.id);
    for (const message of canonical.messages) {
      if (message.metadata?.durableDelivery !== 'ledger-v1') continue;
      if (new Date(message.timestamp).getTime() < cutoff) continue;
      const expectedIds = resolveDurableRecipientIds(message.from.id, message, channel)
        .map(participantId => `${channel.id}:${participantId}:${message.id}`);
      const missingIds = expectedIds.filter(id => !existingIds.has(id));
      if (missingIds.length === 0) continue;
      const records = await enqueue(message.from.id, message, channel);
      for (const record of records) existingIds.add(record.id);
      repaired += missingIds.filter(id => existingIds.has(id)).length;
    }
  }
  return repaired;
}

/** Presence-based liveness so a busy recipient's queue waits for its idle claim. */
export async function loadRecipientLiveness(
  readChannels: () => Promise<CollabChannelsData> = () => readJsonFile<CollabChannelsData>(
    DataPaths.collabChannels,
    { channels: [], lastUpdated: new Date(0).toISOString() },
  ),
  nowMs = Date.now(),
): Promise<(record: DeliveryRecord) => boolean> {
  const data = await readChannels();
  return record => {
    const channel = data.channels.find(candidate => candidate.id === record.channelId);
    const participant = channel?.participants.find(candidate => candidate.id === record.participantId);
    return !!(channel && participant && participantReachable(participant, channel, data, nowMs));
  };
}

/**
 * Dead-letter records not yet alerted. A quarantine is a one-time event, so each
 * record alerts once rather than on every cooldown; keys for records that have
 * left the dead-letter queue are pruned so the persisted state stays bounded.
 */
export function selectNewDeadLetters(
  records: DeliveryRecord[],
  lastAlertTimes: Record<string, number>,
): DeliveryRecord[] {
  const deadLetters = records.filter(record => record.state === 'dead_letter');
  const current = new Set(deadLetters.map(record => `dead-letter:${record.id}`));
  for (const key of Object.keys(lastAlertTimes)) {
    if (key.startsWith('dead-letter:') && !current.has(key)) delete lastAlertTimes[key];
  }
  return deadLetters.filter(record => !lastAlertTimes[`dead-letter:${record.id}`]);
}

/** How long an idle Codex seat may leave its queue unclaimed before it counts as stuck. */
export function stuckSeatWaitMs(env: string | undefined = process.env.DELIVERY_STUCK_MINS): number {
  return Math.max(60_000, parsePositiveMinutes(env, 3) * 60_000);
}

/**
 * Seats that look alive but are not picking up their durable queue.
 *
 * A Codex ledger seat that heartbeats "idle" claims a waiting record within
 * seconds. One that leaves records unclaimed for minutes while idle is not
 * listening, whatever its heartbeat says (Jack, 15-17 Oct 2026: 85,573 refused
 * claims over 37 hours of "online"). A busy seat is not stuck, because wrappers
 * claim only between turns. The wait is counted from when the seat could first
 * have claimed, so a record queued while the seat was down does not count
 * against a seat that has only just started.
 */
export function findStuckSeats(
  data: CollabChannelsData,
  records: DeliveryRecord[],
  nowMs: number,
  waitMs: number,
): StuckSeat[] {
  const seats = new Map<string, StuckSeat>();
  for (const record of records) {
    if (record.state !== 'pending') continue;
    const channel = data.channels.find(candidate => candidate.id === record.channelId);
    const participant = channel?.participants.find(candidate => candidate.id === record.participantId);
    const agent = channel?.roster?.agents.find(candidate => candidate.participantId === record.participantId);
    if (!channel || !participant || !agent) continue;
    if (agent.agentType !== 'codex' || agent.deliveryProtocol !== 'ledger-v1') continue;
    if (agent.status !== 'running' && agent.status !== 'away') continue;
    if (participant.activityStatus !== 'idle') continue;
    const lastSeenMs = Date.parse(participant.lastSeen);
    if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > ONLINE_THRESHOLD_MS) continue;

    const queuedSinceMs = Math.max(Date.parse(record.updatedAt) || 0, Date.parse(agent.lastStartedAt ?? '') || 0);
    const waitedMs = nowMs - queuedSinceMs;
    if (!(waitedMs >= waitMs)) continue;

    const key = seatKey(channel.id, participant.id);
    const seat = seats.get(key);
    if (!seat) {
      seats.set(key, {
        channelId: channel.id,
        participantId: participant.id,
        name: participant.name,
        channelName: channel.name,
        count: 1,
        oldestWaitMs: waitedMs,
        oldestMessageId: record.messageId,
      });
    } else {
      seat.count += 1;
      if (waitedMs > seat.oldestWaitMs) {
        seat.oldestWaitMs = waitedMs;
        seat.oldestMessageId = record.messageId;
      }
    }
  }
  return [...seats.values()];
}

/** Keep the seats that have looked stuck since at least `confirmMs` ago; forget the rest. */
export function confirmStuckSeats(
  candidates: StuckSeat[],
  firstSeen: Map<string, number>,
  nowMs: number,
  confirmMs: number,
): StuckSeat[] {
  const current = new Set<string>();
  const confirmed: StuckSeat[] = [];
  for (const seat of candidates) {
    const key = seatKey(seat.channelId, seat.participantId);
    current.add(key);
    const first = firstSeen.get(key) ?? nowMs;
    firstSeen.set(key, first);
    if (nowMs - first >= confirmMs) confirmed.push(seat);
  }
  for (const key of [...firstSeen.keys()]) {
    if (!current.has(key)) firstSeen.delete(key);
  }
  return confirmed;
}

export interface StuckSeatSweepState {
  /** First sweep on which each seat looked stuck. */
  firstSeen: Map<string, number>;
  /** Seats already alerted in their current episode. */
  alerted: Set<string>;
}

export function newStuckSeatSweepState(): StuckSeatSweepState {
  return { firstSeen: new Map(), alerted: new Set() };
}

/**
 * One stuck-seat sweep: find seats, confirm them across two sweeps, publish the
 * set to presence (so senders see the seat offline and its queue stops counting
 * as live), and raise one alert per episode.
 */
export async function sweepStuckSeats(
  state: StuckSeatSweepState,
  options: {
    nowMs?: number;
    waitMs?: number;
    readChannels?: () => Promise<CollabChannelsData>;
    readRecords?: () => Promise<DeliveryRecord[]>;
    alert?: (title: string, severity: 'high', details: string) => Promise<void>;
  } = {},
): Promise<StuckSeat[]> {
  const nowMs = options.nowMs ?? Date.now();
  const data = await (options.readChannels ?? (() => readJsonFile<CollabChannelsData>(
    DataPaths.collabChannels,
    { channels: [], lastUpdated: new Date(0).toISOString() },
  )))();
  const records = await (options.readRecords ?? (() => getDeliveryRecords({ includeHandled: false })))();
  const candidates = findStuckSeats(data, records, nowMs, options.waitMs ?? stuckSeatWaitMs());
  const confirmed = confirmStuckSeats(candidates, state.firstSeen, nowMs, STUCK_CONFIRM_MS);
  replaceStuckSeats(confirmed, nowMs);

  const current = new Set(confirmed.map(seat => seatKey(seat.channelId, seat.participantId)));
  for (const key of [...state.alerted]) {
    if (!current.has(key)) state.alerted.delete(key);
  }
  const alert = options.alert ?? ((title, severity, details) => postStabilityAlert(title, severity, details));
  for (const seat of confirmed) {
    const key = seatKey(seat.channelId, seat.participantId);
    if (state.alerted.has(key)) continue;
    state.alerted.add(key);
    const minutes = Math.max(1, Math.floor(seat.oldestWaitMs / 60_000));
    await alert(
      `Seat not picking up messages: ${seat.name} (${seat.channelName})`,
      'high',
      `${seat.name} is online and idle in ${seat.channelName} but has ${seat.count} ` +
      `message${seat.count === 1 ? '' : 's'} waiting that it has not picked up, the oldest for ${minutes} min ` +
      `(message \`${seat.oldestMessageId}\`). Its session is probably stuck: restart it from the roster. ` +
      'Senders now see it as offline until it recovers.',
    ).catch((e: unknown) => {
      console.error('[delivery-monitor] stuck-seat alert failed:', e instanceof Error ? e.message : String(e));
    });
  }
  return confirmed;
}

export function startDeliveryMonitor(): () => void {
  const lastAlertTimes: Record<string, number> = {};
  let cooldownsLoaded = false;

  const run = async () => {
    try {
      const events = await readTelemetryEvents();
      if (!cooldownsLoaded) {
        Object.assign(lastAlertTimes, await readAlertCooldowns());
        cooldownsLoaded = true;
      }
      await reconcileCanonicalDeliveries();
      await quarantineStalePendingDeliveries(undefined, {
        isRecipientLive: await loadRecipientLiveness(),
      });
      const thresholds = getThresholds();
      const opts: DeliveryAlertOpts = {
        windowHours: WINDOW_HOURS,
        nowMs: Date.now(),
        lastAlertTimes,
        ...thresholds,
      };
      const results = evaluateDeliveryAlerts(events, opts);

      for (const r of results) {
        if (!r.shouldAlert) continue;
        lastAlertTimes[r.agentName] = Date.now();
        const details =
          `Agent **${r.agentName}** — ${r.reason} in the last ${WINDOW_HOURS}h. ` +
          `Failures: ${r.failures}, Delivered: ${r.delivered} ` +
          `(${(r.failureRate * 100).toFixed(1)}% failure rate).`;
        await postStabilityAlert(
          `Delivery failures: ${r.agentName}`,
          'high',
          details,
        ).catch((e: unknown) => {
          console.error('[delivery-monitor] alert post failed:', e instanceof Error ? e.message : String(e));
        });
      }

      const loopThreshold = Math.max(2, Number.parseInt(process.env.DELIVERY_LOOP_ATTEMPT_THRESHOLD || '3', 10));
      const loops = evaluateDeliveryLoops(events, Date.now(), 2 * 60_000, loopThreshold);
      for (const loop of loops) {
        const alertKey = `loop:${loop.key}`;
        if (Date.now() - (lastAlertTimes[alertKey] || 0) < thresholds.alertCooldownMs) continue;
        lastAlertTimes[alertKey] = Date.now();
        await postStabilityAlert(
          `Delivery loop stopped: ${loop.agentName}`,
          'critical',
          `Message \`${loop.messageId}\` for \`${loop.participantId}\` in channel ` +
          `\`${loop.channelId}\` recorded ${loop.attempts} failed attempts inside two minutes.`,
        ).catch((e: unknown) => {
          console.error('[delivery-monitor] loop alert failed:', e instanceof Error ? e.message : String(e));
        });
      }

      const backlogAlertMs = Math.max(
        60_000,
        parsePositiveMinutes(process.env.DELIVERY_BACKLOG_ALERT_MINS, 5) * 60_000,
      );
      const deliveryRecords = await getDeliveryRecords({ includeHandled: false });
      const backlog = evaluateDeliveryBacklogs(deliveryRecords, Date.now(), backlogAlertMs);
      for (const item of backlog) {
        const alertKey = `ledger:${item.channelId}:${item.participantId}`;
        const lastAlert = lastAlertTimes[alertKey] ?? 0;
        if (Date.now() - lastAlert < thresholds.alertCooldownMs) continue;
        lastAlertTimes[alertKey] = Date.now();
        const ageMinutes = Math.max(1, Math.floor(item.oldestAgeMs / 60_000));
        await postStabilityAlert(
          `Delivery backlog: ${item.participantId}`,
          'high',
          `Durable delivery queue has ${item.count} replayable record(s) in channel ` +
          `\`${item.channelId}\`; oldest is ${ageMinutes}m old ` +
          `(message \`${item.oldestMessageId}\`).`,
        ).catch((e: unknown) => {
          console.error('[delivery-monitor] backlog alert failed:', e instanceof Error ? e.message : String(e));
        });
      }
      for (const record of selectNewDeadLetters(deliveryRecords, lastAlertTimes)) {
        lastAlertTimes[`dead-letter:${record.id}`] = Date.now();
        await postStabilityAlert(
          `Delivery quarantined: ${record.participantId}`,
          'critical',
          `Message \`${record.messageId}\` in channel \`${record.channelId}\` was quarantined ` +
          `after ${record.attempts} attempt(s): ${record.recoveryReason || 'unknown reason'}.`,
        ).catch((e: unknown) => {
          console.error('[delivery-monitor] dead-letter alert failed:', e instanceof Error ? e.message : String(e));
        });
      }
      await writeAlertCooldowns(lastAlertTimes);
    } catch (e) {
      // Never crash the monitor
      console.error('[delivery-monitor] check failed:', e instanceof Error ? e.message : String(e));
    }
  };

  const timer = setInterval(run, CHECK_INTERVAL);
  // Run immediately on startup so there's no 5-min blind spot after restart
  run().catch(() => {});

  // Stuck-seat sweep: a seat that heartbeats idle but leaves its queue unclaimed
  // must stop counting as online within minutes, not hours.
  const stuckState = newStuckSeatSweepState();
  const sweep = () => {
    sweepStuckSeats(stuckState).catch((e: unknown) => {
      console.error('[delivery-monitor] stuck-seat sweep failed:', e instanceof Error ? e.message : String(e));
    });
  };
  const stuckTimer = setInterval(sweep, STUCK_CHECK_INTERVAL);
  sweep();

  return () => {
    clearInterval(timer);
    clearInterval(stuckTimer);
  };
}
