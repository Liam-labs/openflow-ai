/**
 * GET /api/stability-digest
 *
 * Capstone stability health digest — aggregates agent uptime, crash events,
 * OOM kills, memory metrics, service health checks, and API error rates
 * into a single health snapshot.
 *
 * Query parameters:
 *   window   '1h' | '24h' | '7d' | '30d'  (default: '24h')
 *
 * Response:
 *   {
 *     generatedAt: string;
 *     window: { from: string; to: string };
 *     lastRestartAt: string | null;
 *     summary: {
 *       overallHealth: 'healthy' | 'degraded' | 'critical';
 *       score: number;
 *       agentCount: number;
 *       crashCount: number;
 *       oomKillCount: number;
 *       servicesDown: number;
 *       apiErrorRate1h: number;
 *     };
 *     sinceRestart: { crashCount, oomKillCount, windowMs } | null;
 *     agents: AgentUptimeResult[];
 *     serviceHealth: {
 *       total: number;
 *       healthy: number;
 *       degraded: number;
 *       offline: number;
 *       services: Array<{ name, status, failingChecks, lastCheckedAt }>;
 *     };
 *     apiErrors: {
 *       errorRate1m: number;
 *       errorRate5m: number;
 *       errorRate1h: number;
 *       totalRequests1h: number;
 *       topErrorRoutes: Array<{ route, errorRate, total }>;
 *     };
 *     memory: { current, peakUsedPercent, avgUsedPercent };
 *     recentAlerts: Array<{ ts, title, severity, source }>;
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { queryLogs } from '@/lib/log-reader';
import { getErrorRates } from '@/lib/error-rate-tracker';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import {
  isServiceExpectedOnline,
  loadProjectsRegistry,
  getLastBuildTimestamp,
  filterBuildRestartCrashes,
} from '@/lib/stability-helpers';
import { appPath } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

export const dynamic = 'force-dynamic';

const NIGHTLY_BUILD_LOG = path.join(
  getHomeDir(),
  'DevFlow', 'logs', 'nightly-build.log',
);
const PROJECTS_DATA_DIR = appPath('.AppData');

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7-day OOM guard

const WINDOW_PRESETS: Record<string, number> = {
  '1h':  1 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 7 * 24 * 60 * 60 * 1000, // capped to 7d to prevent OOM on large timeseries
};

const TIMESERIES_FILE = appPath('logs', 'memory-timeseries.jsonl');

// ============================================
// Types
// ============================================

interface AgentEvent {
  event: string;
  timestamp: number;
}

interface AgentUptimeResult {
  name: string;
  uptimePercent: number;
  crashCount: number;
  status: 'up' | 'down' | 'unknown';
  lastSeen: string | null;
}

interface ServiceHealthEntry {
  name: string;
  status: 'healthy' | 'degraded' | 'offline';
  expectedOnline: boolean;
  failingChecks: string[];
  lastCheckedAt: string;
}

interface MemorySample {
  ts: string;
  memTotalMB: number;
  memAvailMB: number;
  memUsedMB: number;
  swapUsedMB: number;
}

// ============================================
// Helpers
// ============================================

async function getWslBootTime(): Promise<number | null> {
  try {
    const content = await fs.readFile('/proc/uptime', 'utf-8');
    const uptimeSeconds = parseFloat(content.split(' ')[0]);
    if (isNaN(uptimeSeconds)) return null;
    return Date.now() - Math.floor(uptimeSeconds * 1000);
  } catch {
    return null;
  }
}

function computeAgentUptime(
  events: AgentEvent[],
  windowStart: number,
  windowEnd: number,
): { downtimeMs: number; crashCount: number; lastSeen: number | null; status: 'up' | 'down' | 'unknown' } {
  let downtimeMs = 0;
  let crashCount = 0;
  let downSince: number | null = null;
  let lastSeen: number | null = null;

  for (const ev of events) {
    const ts = ev.timestamp;
    if (lastSeen === null || ts > lastSeen) lastSeen = ts;

    if (ev.event === 'crash' || ev.event === 'exit') {
      if (ev.event === 'crash') crashCount++; // Graceful exits (ev.event === 'exit') don't count as crashes
      if (downSince === null) downSince = ts;
    } else if (ev.event === 'spawn' || ev.event === 'respawn' || ev.event === 'ready') {
      if (downSince !== null) {
        downtimeMs += ts - downSince;
        downSince = null;
      }
    }
  }

  if (downSince !== null) {
    downtimeMs += windowEnd - downSince;
  }

  const status: 'up' | 'down' | 'unknown' =
    events.length === 0 ? 'unknown' :
    downSince !== null ? 'down' : 'up';

  return { downtimeMs, crashCount, lastSeen, status };
}

async function getAgentUptime(from: Date, to: Date): Promise<AgentUptimeResult[]> {
  const result = await queryLogs({ sources: ['agent'], from, to, limit: 5000 });

  const byAgent = new Map<string, AgentEvent[]>();
  for (const entry of result.entries) {
    const meta = entry.metadata as Record<string, unknown>;
    const agentName = typeof meta.agentName === 'string' ? meta.agentName : null;
    const event = typeof meta.event === 'string' ? meta.event : null;
    if (!agentName || !event) continue;
    if (!byAgent.has(agentName)) byAgent.set(agentName, []);
    byAgent.get(agentName)!.push({ event, timestamp: new Date(entry.timestamp).getTime() });
  }

  for (const events of Array.from(byAgent.values())) {
    events.sort((a, b) => a.timestamp - b.timestamp);
  }

  const windowStart = from.getTime();
  const windowEnd = to.getTime();
  const windowMs = windowEnd - windowStart;
  const agents: AgentUptimeResult[] = [];

  for (const [name, events] of Array.from(byAgent.entries())) {
    const { downtimeMs, crashCount, lastSeen, status } = computeAgentUptime(events, windowStart, windowEnd);
    const uptimeMs = Math.max(0, windowMs - downtimeMs);
    const uptimePercent = windowMs > 0
      ? Math.min(100, Math.max(0, Math.round((uptimeMs / windowMs) * 1000) / 10))
      : 100;

    agents.push({ name, uptimePercent, crashCount, status, lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null });
  }

  return agents.sort((a, b) => a.uptimePercent - b.uptimePercent);
}

async function getOomKillCount(from: Date, to: Date): Promise<number> {
  const result = await queryLogs({ sources: ['service'], from, to, limit: 1000 });
  let count = 0;
  for (const entry of result.entries) {
    const meta = entry.metadata as Record<string, unknown>;
    if (meta.event === 'oom-kill') count++;
  }
  return count;
}

/**
 * Derive current per-service health status from the latest health check events.
 * For each service, take the most recent health-fail or health-recover event.
 * Also picks up health-check events directly (an agent's enhanced logging).
 */
async function getServiceHealth(from: Date, to: Date): Promise<{
  total: number;
  healthy: number;
  degraded: number;
  offline: number;
  unexpectedOffline: number;
  services: ServiceHealthEntry[];
}> {
  const [result, projects] = await Promise.all([
    queryLogs({ sources: ['service'], from, to, limit: 2000 }),
    loadProjectsRegistry(PROJECTS_DATA_DIR),
  ]);

  // Keep only the latest event per service
  const latestByService = new Map<string, { ts: number; entry: typeof result.entries[0] }>();

  for (const entry of result.entries) {
    const meta = entry.metadata as Record<string, unknown>;
    const svcName = typeof meta.serviceName === 'string' ? meta.serviceName : null;
    const eventType = typeof meta.event === 'string' ? meta.event : null;
    if (!svcName || !eventType) continue;

    // Only track health-related events
    if (!['health-fail', 'health-recover', 'health-check'].includes(eventType)) continue;

    const ts = new Date(entry.timestamp).getTime();
    const existing = latestByService.get(svcName);
    if (!existing || ts > existing.ts) {
      latestByService.set(svcName, { ts, entry });
    }
  }

  const services: ServiceHealthEntry[] = [];

  for (const [name, { entry }] of Array.from(latestByService.entries())) {
    const meta = entry.metadata as Record<string, unknown>;
    const eventType = meta.event as string;

    // Determine status
    let status: 'healthy' | 'degraded' | 'offline';
    if (eventType === 'health-recover') {
      status = 'healthy';
    } else if (eventType === 'health-fail') {
      const reason = typeof meta.reason === 'string' ? meta.reason : '';
      status = reason === 'offline' ? 'offline' : 'degraded';
    } else {
      // health-check: look at checks array for failures
      const checks = Array.isArray(meta.checks) ? meta.checks as Array<Record<string, unknown>> : [];
      const hasFailure = checks.some(c => c.status !== 'online' && c.status !== 'healthy');
      status = hasFailure ? 'degraded' : 'healthy';
    }

    // Extract failing check names
    const checks = Array.isArray(meta.checks) ? meta.checks as Array<Record<string, unknown>> : [];
    const failingChecks = checks
      .filter(c => c.status !== 'online' && c.status !== 'healthy')
      .map(c => typeof c.label === 'string' ? c.label : 'unknown');

    const expectedOnline = isServiceExpectedOnline(name, projects);
    services.push({ name, status, expectedOnline, failingChecks, lastCheckedAt: entry.timestamp });
  }

  // Sort: offline first, then degraded, then healthy
  const ORDER = { offline: 0, degraded: 1, healthy: 2 };
  services.sort((a, b) => ORDER[a.status] - ORDER[b.status]);

  const healthy  = services.filter(s => s.status === 'healthy').length;
  const degraded = services.filter(s => s.status === 'degraded').length;
  const offline  = services.filter(s => s.status === 'offline').length;
  const unexpectedOffline = services.filter(s => s.status === 'offline' && s.expectedOnline).length;

  return { total: services.length, healthy, degraded, offline, unexpectedOffline, services };
}

/**
 * Collect individual crash-event timestamps from agent logs.
 * Used by the build-restart filter to identify which crashes fall within the
 * 10-minute post-build window.
 */
async function getAgentCrashTimestamps(from: Date, to: Date): Promise<number[]> {
  const result = await queryLogs({ sources: ['agent'], from, to, limit: 5000 });
  const timestamps: number[] = [];
  for (const entry of result.entries) {
    const meta = entry.metadata as Record<string, unknown>;
    if (meta.event === 'crash') {
      timestamps.push(new Date(entry.timestamp).getTime());
    }
  }
  return timestamps;
}

async function getMemorySummary(from: number, to: number): Promise<{
  current: { memUsedPercent: number; memAvailMB: number; swapUsedMB: number } | null;
  peakUsedPercent: number | null;
  avgUsedPercent: number | null;
}> {
  // Stream the JSONL file line-by-line to avoid loading entire file into memory
  let fileExists = true;
  try {
    await fs.access(TIMESERIES_FILE);
  } catch {
    fileExists = false;
  }
  if (!fileExists) return { current: null, peakUsedPercent: null, avgUsedPercent: null };

  let latest: { memUsedPercent: number; memAvailMB: number; swapUsedMB: number; ts: number } | null = null;
  let peakUsedPercent = 0;
  let totalUsedPercent = 0;
  let count = 0;

  const rl = createInterface({
    input: createReadStream(TIMESERIES_FILE, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const sample = JSON.parse(trimmed) as MemorySample;
      const sampleTime = new Date(sample.ts).getTime();
      if (sampleTime < from || sampleTime > to) continue;
      if (!sample.memTotalMB || sample.memTotalMB === 0) continue;
      const memUsedPercent = Math.round((sample.memUsedMB / sample.memTotalMB) * 1000) / 10;

      if (!latest || sampleTime > latest.ts) {
        latest = { ts: sampleTime, memUsedPercent, memAvailMB: sample.memAvailMB, swapUsedMB: sample.swapUsedMB };
      }
      if (memUsedPercent > peakUsedPercent) peakUsedPercent = memUsedPercent;
      totalUsedPercent += memUsedPercent;
      count++;
    } catch { /* skip malformed */ }
  }

  if (count === 0 || !latest) return { current: null, peakUsedPercent: null, avgUsedPercent: null };

  return {
    current: { memUsedPercent: latest.memUsedPercent, memAvailMB: latest.memAvailMB, swapUsedMB: latest.swapUsedMB },
    peakUsedPercent,
    avgUsedPercent: Math.round((totalUsedPercent / count) * 10) / 10,
  };
}

/**
 * Compute composite health score (0–100).
 *
 * Deductions:
 *   Crashes (post-restart if applicable): -5 each, cap -40
 *   OOM kills:                            -10 each, cap -30
 *   Agent down:                           -10 each
 *   Agent uptime < 90%:                   -5 each
 *   Services unexpectedly offline:         -10 each, cap -20
 *   Services degraded:                    -5 each, cap -10
 *   API error rate (1h) > 5%:             -10
 *   API error rate (1h) > 20%:            -20 (replaces -10)
 *   Memory peak > 85%:                    -10
 *   Memory peak > 95%:                    -20 (replaces -10)
 */
function computeHealthScore(
  agents: AgentUptimeResult[],
  totalCrashes: number,
  oomKillCount: number,
  serviceHealth: { unexpectedOffline: number; degraded: number },
  apiErrorRate1h: number,
  peakMemPercent: number | null,
): number {
  let score = 100;

  score -= Math.min(40, totalCrashes * 5);
  score -= Math.min(30, oomKillCount * 10);

  for (const agent of agents) {
    if (agent.status === 'down') score -= 10;
    else if (agent.uptimePercent < 90) score -= 5;
  }

  score -= Math.min(20, serviceHealth.unexpectedOffline * 10);
  score -= Math.min(10, serviceHealth.degraded * 5);

  if (apiErrorRate1h > 20) score -= 20;
  else if (apiErrorRate1h > 5) score -= 10;

  if (peakMemPercent !== null) {
    if (peakMemPercent > 95) score -= 20;
    else if (peakMemPercent > 85) score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

// ============================================
// Route handler
// ============================================

export const GET = tracked('/api/stability-digest', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = request.nextUrl;
    const windowParam = searchParams.get('window') || '24h';
    const windowMs = WINDOW_PRESETS[windowParam] ?? WINDOW_PRESETS['24h'];

    const now = new Date();
    const from = new Date(now.getTime() - windowMs);
    const to = now;

    // All fetches in parallel
    const [agents, oomKillCount, serviceHealth, memorySummary, alertsResult, wslBootTime, agentCrashTimestamps, lastBuildTs] = await Promise.all([
      getAgentUptime(from, to),
      getOomKillCount(from, to),
      getServiceHealth(from, to),
      getMemorySummary(from.getTime(), to.getTime()),
      queryLogs({ sources: ['crash', 'service', 'agent'], severity: ['critical', 'high'], from, to, limit: 20 }),
      getWslBootTime(),
      getAgentCrashTimestamps(from, to),
      getLastBuildTimestamp(NIGHTLY_BUILD_LOG),
    ]);

    // Error rates are in-memory — synchronous
    const errorRateData = getErrorRates();
    const errorRate1h = errorRateData.windows['1h']?.errorRate ?? 0;

    // Restart baseline
    const restartWithinWindow =
      wslBootTime !== null &&
      wslBootTime > from.getTime() &&
      wslBootTime < to.getTime();

    const lastRestartAt = wslBootTime ? new Date(wslBootTime).toISOString() : null;

    let scoringCrashes = agents.reduce((sum, a) => sum + a.crashCount, 0);
    let scoringOom = oomKillCount;
    let sinceRestart: { crashCount: number; oomKillCount: number; windowMs: number } | null = null;

    if (restartWithinWindow && wslBootTime !== null) {
      const restartFrom = new Date(wslBootTime);
      const [postAgents, postOom] = await Promise.all([
        getAgentUptime(restartFrom, to),
        getOomKillCount(restartFrom, to),
      ]);
      const postCrashes = postAgents.reduce((sum, a) => sum + a.crashCount, 0);
      sinceRestart = { crashCount: postCrashes, oomKillCount: postOom, windowMs: to.getTime() - wslBootTime };
      scoringCrashes = postCrashes;
      scoringOom = postOom;
    }

    // Exclude crashes that are nightly build restarts (within 10m of last successful build)
    const buildFilter = filterBuildRestartCrashes(scoringCrashes, agentCrashTimestamps, lastBuildTs);
    scoringCrashes = buildFilter.scoringCrashes;

    const totalCrashes = agents.reduce((sum, a) => sum + a.crashCount, 0);
    const score = computeHealthScore(
      agents, scoringCrashes, scoringOom, serviceHealth, errorRate1h, memorySummary.peakUsedPercent,
    );

    const overallHealth: 'healthy' | 'degraded' | 'critical' =
      score >= 80 ? 'healthy' :
      score >= 50 ? 'degraded' :
      'critical';

    const recentAlerts = alertsResult.entries.slice(0, 10).map(e => ({
      ts: e.timestamp,
      title: e.title,
      severity: e.severity,
      source: e.source,
    }));

    return NextResponse.json({
      generatedAt: now.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      lastRestartAt,
      summary: {
        overallHealth,
        score,
        agentCount: agents.length,
        crashCount: totalCrashes,
        oomKillCount,
        // Headline counts actionable problems only — services that are *expected* online but
        // are offline, plus anything in a degraded state. Was `offline + degraded`, which
        // surfaced 7 dev-server projects (expectedOnline: false) as "servicesDown: 7" even
        // when score was 100/healthy. 2026-05-19 alignment with the score calc at line 391.
        servicesDown: serviceHealth.unexpectedOffline + serviceHealth.degraded,
        apiErrorRate1h: errorRate1h,
      },
      sinceRestart,
      agents,
      serviceHealth,
      apiErrors: {
        errorRate1m:      errorRateData.windows['1m']?.errorRate ?? 0,
        errorRate5m:      errorRateData.windows['5m']?.errorRate ?? 0,
        errorRate1h:      errorRate1h,
        totalRequests1h:  errorRateData.windows['1h']?.total ?? 0,
        topErrorRoutes:   errorRateData.topErrorRoutes.slice(0, 5).map(r => ({
          route: r.route,
          errorRate: r.errorRate,
          total: r.total,
        })),
      },
      memory: memorySummary,
      recentAlerts,
    });
  } catch (err) {
    console.error('[api/stability-digest] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});
