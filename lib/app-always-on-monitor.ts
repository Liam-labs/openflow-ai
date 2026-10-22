import os from 'os';
import { DataPaths } from './data-paths';
import { readJsonFile } from './data-io';
import { runHealthCheck } from './health-checks';
import { pm2Exec, pm2List } from './host-bridge/client';
import { logEvent } from './log-writer';
import { postStabilityAlert } from './stability-alerts';
import type { AppRegistryData, AppRegistryEntry, HealthCheck } from './types';

const CHECK_INTERVAL_MS = 30_000;
const HEALTH_FAILURE_THRESHOLD = 2;
const RESTART_COOLDOWN_MS = 60_000;
const PM2_EXEC_TIMEOUT_MS = 30_000;

const DEFAULT_DATA: AppRegistryData = {
  apps: [],
  lastUpdated: new Date(0).toISOString(),
};

type AlwaysOnConfig = Pick<AppRegistryEntry, 'alwaysOn' | 'pm2Name' | 'healthCheck'>;

/** This machine's host id: DEVFLOW_HOST_ID, else its OS hostname (the desktop | devflow), lower-cased. */
export function thisHostId(): string {
  return (process.env.DEVFLOW_HOST_ID || os.hostname()).trim().toLowerCase();
}

/** An app pinned to another host must never be started or restarted here (e.g. Signal/Baileys runs on one host only). */
export function runsOnThisHost(app: Pick<AppRegistryEntry, 'runsOn'>, hostId: string = thisHostId()): boolean {
  const pinned = app.runsOn?.trim().toLowerCase();
  return !pinned || pinned === hostId;
}

export interface AlwaysOnHealthResult {
  healthy: boolean;
  reason: string;
}

export interface AlwaysOnMonitorDependencies {
  listApps: () => Promise<AppRegistryEntry[]>;
  listProcesses: () => Promise<Array<{ name?: string; status?: string }>>;
  checkHealth: (app: AppRegistryEntry) => Promise<AlwaysOnHealthResult>;
  restartProcess: (app: AppRegistryEntry, processExists: boolean) => Promise<void>;
  recordFailure: (app: AppRegistryEntry, health: AlwaysOnHealthResult) => Promise<void>;
  recordRecovery: (app: AppRegistryEntry) => Promise<void>;
  recordRestartResult: (app: AppRegistryEntry, success: boolean, error?: string) => Promise<void>;
  now: () => number;
}

interface AppMonitorState {
  failureCount: number;
  incidentOpen: boolean;
  lastRestartAt?: number;
}

export function validateAlwaysOnConfig(config: AlwaysOnConfig): string | null {
  if (!config.alwaysOn) return null;

  const pm2Name = config.pm2Name?.trim();
  if (!pm2Name) return 'Always On requires a PM2 process name.';
  if (!/^[a-zA-Z0-9._-]+$/.test(pm2Name)) {
    return 'PM2 process name may only contain letters, numbers, dots, underscores, and hyphens.';
  }

  if (!config.healthCheck) return 'Always On requires a health check.';
  const target = config.healthCheck.target.trim();

  if (config.healthCheck.type === 'port') {
    const port = Number(target);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return 'Always On health-check port must be between 1 and 65535.';
    }
    return null;
  }

  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid protocol');
  } catch {
    return 'Always On health-check URL must be a valid HTTP or HTTPS URL.';
  }

  return null;
}

export function createAppAlwaysOnCycle(dependencies: AlwaysOnMonitorDependencies): () => Promise<void> {
  const states = new Map<string, AppMonitorState>();

  return async () => {
    const apps = (await dependencies.listApps()).filter(app => app.alwaysOn && runsOnThisHost(app));
    if (apps.length === 0) return;

    const processes = await dependencies.listProcesses();
    const processByName = new Map(processes.map(process => [process.name, process]));

    await Promise.all(apps.map(async app => {
      const state = states.get(app.id) ?? { failureCount: 0, incidentOpen: false };
      states.set(app.id, state);

      const configError = validateAlwaysOnConfig(app);
      const process = app.pm2Name ? processByName.get(app.pm2Name) : undefined;
      const processOnline = process?.status === 'online';
      let health: AlwaysOnHealthResult;

      if (configError) {
        health = { healthy: false, reason: configError };
      } else if (!processOnline) {
        health = {
          healthy: false,
          reason: process
            ? `PM2 process ${app.pm2Name} is ${process.status ?? 'not online'}`
            : `PM2 process ${app.pm2Name} was not found`,
        };
      } else {
        health = await dependencies.checkHealth(app);
      }

      if (health.healthy) {
        if (state.incidentOpen) await dependencies.recordRecovery(app);
        state.failureCount = 0;
        state.incidentOpen = false;
        state.lastRestartAt = undefined;
        return;
      }

      state.failureCount += 1;
      const shouldAct = !processOnline || state.failureCount >= HEALTH_FAILURE_THRESHOLD;
      if (!shouldAct) return;

      if (!state.incidentOpen) {
        state.incidentOpen = true;
        await dependencies.recordFailure(app, health);
      }

      const now = dependencies.now();
      if (state.lastRestartAt !== undefined && now - state.lastRestartAt < RESTART_COOLDOWN_MS) return;
      state.lastRestartAt = now;

      try {
        await dependencies.restartProcess(app, Boolean(process));
        await dependencies.recordRestartResult(app, true, undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await dependencies.recordRestartResult(app, false, message);
      }
    }));

    const activeIds = new Set(apps.map(app => app.id));
    for (const appId of states.keys()) {
      if (!activeIds.has(appId)) states.delete(appId);
    }
  };
}

function toHealthCheck(app: AppRegistryEntry): HealthCheck {
  const healthCheck = app.healthCheck!;
  if (healthCheck.type === 'port') {
    return { type: 'port', port: Number(healthCheck.target), label: `${app.name} Always On` };
  }
  return { type: 'http', url: healthCheck.target, expectedStatus: 200, label: `${app.name} Always On` };
}

const defaultDependencies: AlwaysOnMonitorDependencies = {
  listApps: async () => {
    const data = await readJsonFile<AppRegistryData>(DataPaths.appRegistry, DEFAULT_DATA);
    return data.apps;
  },
  listProcesses: async () => pm2List(),
  checkHealth: async app => {
    const result = await runHealthCheck(toHealthCheck(app), 0);
    return {
      healthy: result.status === 'online',
      reason: result.message ?? `Health check returned ${result.status}`,
    };
  },
  restartProcess: async (app, processExists) => {
    await pm2Exec(processExists ? 'restart' : 'start', app.pm2Name!, { timeout: PM2_EXEC_TIMEOUT_MS });
  },
  recordFailure: async (app, health) => {
    const metadata = {
      event: 'health-fail',
      module: 'app-always-on-monitor',
      appId: app.id,
      serviceName: app.name,
      pm2Name: app.pm2Name,
      alwaysOn: true,
      reason: health.reason,
    };
    await Promise.all([
      logEvent('service', 'high', `Always On app unhealthy: ${app.name}`, metadata, health.reason),
      postStabilityAlert(`Always On app unhealthy: ${app.name}`, 'high', health.reason),
    ]);
  },
  recordRecovery: async app => {
    await logEvent('service', 'info', `Always On app recovered: ${app.name}`, {
      event: 'health-recover',
      module: 'app-always-on-monitor',
      appId: app.id,
      serviceName: app.name,
      pm2Name: app.pm2Name,
      alwaysOn: true,
    });
  },
  recordRestartResult: async (app, success, error) => {
    await logEvent(
      'service',
      success ? 'info' : 'high',
      success ? `Always On restarted: ${app.name}` : `Always On restart failed: ${app.name}`,
      {
        event: 'watchdog-restart',
        module: 'app-always-on-monitor',
        appId: app.id,
        serviceName: app.name,
        pm2Name: app.pm2Name,
        alwaysOn: true,
        success,
        ...(error ? { error } : {}),
      },
      error,
    );
  },
  now: () => Date.now(),
};

export function startAppAlwaysOnMonitor(): () => void {
  const cycle = createAppAlwaysOnCycle(defaultDependencies);
  let running = false;

  const guardedCycle = async () => {
    if (running) return;
    running = true;
    try {
      await cycle();
    } catch (error) {
      console.error('[App Always On] Monitor cycle failed:', error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };

  void guardedCycle();
  const timer = setInterval(() => void guardedCycle(), CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
