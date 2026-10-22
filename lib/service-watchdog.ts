/**
 * Service Watchdog
 *
 * Monitors services via existing health check results (zero additional polling).
 * Auto-restarts services that go offline, with configurable limits and cooldowns.
 *
 * Architecture:
 * - Hooks into the health check loop in instrumentation.ts
 * - evaluate() is called after each health check cycle with the results
 * - If a service with watchdog.enabled is offline, attempts restart
 * - Respects port conflicts, max restart limits, and cooldown periods
 * - Logs all events to data/watchdog-logs.json
 * - Emits SSE events via eventBus for real-time UI updates
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { DataPaths } from './data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from './data-io';
import { eventBus } from './event-bus';
import type {
  Project,
  ProjectHealthStatus,
  WatchdogConfig,
  WatchdogEvent,
  WatchdogState,
  WatchdogLogData,
  WatchdogEventType,
} from './types';
import { appRoot } from '@/lib/app-paths';

const execAsync = promisify(exec);

// In-memory state (resets on server restart - intentional)
const serviceStates = new Map<string, WatchdogState>();

// Track which services have pending restart attempts (prevent duplicate restarts)
const pendingRestarts = new Set<string>();

// Default config values
const DEFAULTS = {
  maxRestarts: 3,
  cooldownMs: 300_000,       // 5 minutes
  restartDelayMs: 5_000,     // 5 seconds
  maxCycles: 3,              // Give up after 3 full restart→cooldown cycles
  maxLogEvents: 200,         // Keep last 200 events in log file
};

/**
 * Check if a port is currently in use by another process.
 * Returns true if port is bound (conflict), false if free.
 */
// Port-check cache to avoid hammering localhost TCP sockets every cycle.
// Key: port number, Value: { inUse: boolean, checkedAt: number (ms epoch) }
const portCheckCache = new Map<number, { inUse: boolean; checkedAt: number }>();
const PORT_CHECK_TTL_MS = 300_000; // 5 minutes
const PORT_CHECK_TIMEOUT_MS = 150; // localhost accept/refuse is instant; 150ms plenty

// Dedup port_conflict log events — same service, same port, same status doesn't need
// re-logging every 30 seconds. Log once per cooldown window.
const lastPortConflictLog = new Map<string, number>();
const PORT_CONFLICT_LOG_TTL_MS = 300_000; // 5 minutes

async function isPortInUse(port: number): Promise<boolean> {
  const cached = portCheckCache.get(port);
  if (cached && (Date.now() - cached.checkedAt) < PORT_CHECK_TTL_MS) {
    return cached.inUse;
  }

  const result = await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(PORT_CHECK_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });

  portCheckCache.set(port, { inUse: result, checkedAt: Date.now() });
  return result;
}

function clearPortCheckCache(port: number): void {
  portCheckCache.delete(port);
}

/**
 * Get the current state for a service, initializing if needed.
 */
function getState(projectId: string, watchdog: WatchdogConfig): WatchdogState {
  let state = serviceStates.get(projectId);
  if (!state) {
    state = {
      projectId,
      enabled: watchdog.enabled,
      restartCount: 0,
      failedCycles: 0,
    };
    serviceStates.set(projectId, state);
  }
  return state;
}

/**
 * Log a watchdog event to disk and emit via SSE.
 */
async function logEvent(event: WatchdogEvent): Promise<void> {
  try {
    await withFileLock(DataPaths.watchdogLogs, async () => {
      const data = await readJsonFile<WatchdogLogData>(DataPaths.watchdogLogs, {
        events: [],
        lastUpdated: new Date().toISOString(),
      });

      data.events.push(event);

      // Trim to max events
      if (data.events.length > DEFAULTS.maxLogEvents) {
        data.events = data.events.slice(-DEFAULTS.maxLogEvents);
      }

      data.lastUpdated = new Date().toISOString();
      await writeJsonFile(DataPaths.watchdogLogs, data);
    });
  } catch (err) {
    console.error('[Watchdog] Failed to write log:', err);
  }

  // Emit SSE event for real-time UI updates
  eventBus.emitEvent('watchdog:event', {
    event,
    states: Array.from(serviceStates.values()),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Create and log a watchdog event.
 */
async function emitEvent(
  projectId: string,
  projectName: string,
  eventType: WatchdogEventType,
  message: string,
  extra?: Partial<WatchdogEvent>
): Promise<void> {
  const event: WatchdogEvent = {
    id: uuidv4(),
    projectId,
    projectName,
    eventType,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  console.log(`[Watchdog] ${projectName}: ${message}`);
  await logEvent(event);
}

/**
 * Attempt to restart a service.
 */
async function restartService(project: Project): Promise<boolean> {
  const { server } = project;
  if (!server?.startCommand) return false;

  try {
    // If there's a stop command, run it first
    if (server.stopCommand) {
      try {
        await execAsync(server.stopCommand, { timeout: 15_000 });
      } catch {
        // Stop may fail if service is already dead - that's fine
      }
    }

    // Run start command (use project path as cwd for relative commands)
    await execAsync(server.startCommand, {
      timeout: 30_000,
      cwd: project.path || appRoot(),
    });
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Watchdog] Failed to restart ${project.name}:`, errMsg);
    return false;
  }
}

/**
 * Core evaluation function - called after each health check cycle.
 * Checks which watchdog-enabled services are offline and takes action.
 *
 * This function is the ONLY entry point. It runs inside the existing
 * health check loop, so there is zero additional polling overhead.
 */
export async function evaluate(
  projects: Project[],
  healthStatuses: Record<string, ProjectHealthStatus>
): Promise<void> {
  for (const project of projects) {
    const watchdog = project.server?.watchdog;
    if (!watchdog?.enabled) continue;
    if (!project.server?.startCommand) continue;

    const status = healthStatuses[project.id];
    if (!status) continue;

    const state = getState(project.id, watchdog);
    const isOffline = status.overallStatus === 'offline';
    const wasOffline = state.lastCheckStatus === 'offline';

    // Update tracked status
    state.lastCheckStatus = isOffline ? 'offline' : 'online';

    // If service is online, nothing to do
    if (!isOffline) {
      // If it was offline before and came back, reset everything including circuit breaker
      if (wasOffline && (state.restartCount > 0 || state.circuitBroken)) {
        state.restartCount = 0;
        state.failedCycles = 0;
        state.cooldownUntil = undefined;
        state.circuitBroken = false;
      }
      continue;
    }

    // Circuit breaker tripped — stop trying until manual reset or service recovers
    if (state.circuitBroken) continue;

    // Service is offline - check if we should attempt restart

    // Check if already handling this service
    if (pendingRestarts.has(project.id)) continue;

    // Check cooldown
    const maxRestarts = watchdog.maxRestarts ?? DEFAULTS.maxRestarts;
    const cooldownMs = watchdog.cooldownMs ?? DEFAULTS.cooldownMs;
    const restartDelayMs = watchdog.restartDelayMs ?? DEFAULTS.restartDelayMs;
    const maxCycles = watchdog.maxCycles ?? DEFAULTS.maxCycles;

    if (state.cooldownUntil) {
      const cooldownEnd = new Date(state.cooldownUntil).getTime();
      if (Date.now() < cooldownEnd) {
        // Still in cooldown
        continue;
      }
      // Cooldown expired — increment cycle counter and check circuit breaker
      state.failedCycles++;
      state.cooldownUntil = undefined;

      if (state.failedCycles >= maxCycles) {
        // Circuit breaker trips — stop trying
        state.circuitBroken = true;
        await emitEvent(project.id, project.name, 'circuit_broken',
          `Gave up after ${state.failedCycles} failed cycles (${state.failedCycles * maxRestarts} total restarts). Manual intervention required.`,
          { restartCount: state.restartCount, maxRestarts });
        continue;
      }

      state.restartCount = 0;
      await emitEvent(project.id, project.name, 'cooldown_ended',
        `Cooldown ended, monitoring resumed (cycle ${state.failedCycles}/${maxCycles})`);
    }

    // Check restart limit
    if (state.restartCount >= maxRestarts) {
      state.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
      await emitEvent(project.id, project.name, 'cooldown_started',
        `Max restarts (${maxRestarts}) reached, entering ${Math.round(cooldownMs / 60000)}min cooldown`,
        { restartCount: state.restartCount, maxRestarts });
      continue;
    }

    // Check port conflict before restarting
    if (project.server.port) {
      const portBusy = await isPortInUse(project.server.port);
      if (portBusy) {
        // Port is in use but health checks say offline - something else is on this port.
        // Dedup: only log once per PORT_CONFLICT_LOG_TTL_MS to avoid flooding logs
        // every 30 seconds for persistent false-positive health checks.
        const lastLog = lastPortConflictLog.get(project.id) ?? 0;
        if (Date.now() - lastLog >= PORT_CONFLICT_LOG_TTL_MS) {
          lastPortConflictLog.set(project.id, Date.now());
          await emitEvent(project.id, project.name, 'port_conflict',
            `Port ${project.server.port} is in use by another process, skipping restart`,
            { port: project.server.port });
        }
        continue;
      }
    }

    // Only restart if this is the second consecutive offline check
    // (avoids restarting on transient failures)
    if (!wasOffline) {
      // First time seeing offline - wait for next cycle to confirm
      continue;
    }

    // Attempt restart (with delay to avoid rapid-fire)
    pendingRestarts.add(project.id);
    state.restartCount++;
    state.lastRestartAt = new Date().toISOString();

    await emitEvent(project.id, project.name, 'restart_attempt',
      `Attempting restart (${state.restartCount}/${maxRestarts})`,
      { restartCount: state.restartCount, maxRestarts });

    // Delay before restart
    setTimeout(async () => {
      const svcPort = project.server?.port;
      try {
        const success = await restartService(project);
        // Clear cached port check so next cycle re-validates fresh
        if (svcPort) clearPortCheckCache(svcPort);
        if (success) {
          await emitEvent(project.id, project.name, 'restart_success',
            `Service restarted successfully`,
            { restartCount: state.restartCount, maxRestarts });
        } else {
          await emitEvent(project.id, project.name, 'restart_failed',
            `Restart command failed`,
            { restartCount: state.restartCount, maxRestarts });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await emitEvent(project.id, project.name, 'restart_failed',
          `Restart error: ${errMsg}`,
          { restartCount: state.restartCount, maxRestarts, error: errMsg });
      } finally {
        pendingRestarts.delete(project.id);
      }
    }, restartDelayMs);
  }
}

/**
 * Get current watchdog states for all monitored services.
 */
export function getStates(): WatchdogState[] {
  return Array.from(serviceStates.values());
}

/**
 * Get recent watchdog events from the log file.
 */
export async function getRecentEvents(limit: number = 50): Promise<WatchdogEvent[]> {
  const data = await readJsonFile<WatchdogLogData>(DataPaths.watchdogLogs, {
    events: [],
    lastUpdated: new Date().toISOString(),
  });
  return data.events.slice(-limit);
}

/**
 * Toggle watchdog for a specific service (runtime only - doesn't modify config).
 */
export function toggleService(projectId: string, enabled: boolean): void {
  const state = serviceStates.get(projectId);
  if (state) {
    state.enabled = enabled;
    if (!enabled) {
      state.restartCount = 0;
      state.failedCycles = 0;
      state.cooldownUntil = undefined;
      state.circuitBroken = false;
    }
  }
}

/**
 * Reset cooldown for a specific service.
 */
export function resetCooldown(projectId: string): void {
  const state = serviceStates.get(projectId);
  if (state) {
    state.restartCount = 0;
    state.failedCycles = 0;
    state.cooldownUntil = undefined;
    state.circuitBroken = false;
  }
}
