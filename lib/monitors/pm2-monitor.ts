/**
 * PM2 process monitor
 * Polls `pm2 jlist` every 5s and emits status + change events via SSE.
 */
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { eventBus } from '../event-bus';
import { parsePM2Processes, getPortsInUse, overlayActualPorts } from '../pm2-utils';
import { getActualListeningPorts, getChildPidMap } from '../port-utils';
import { logEvent } from '../log-writer';

const execAsync = promisify(execCb);
const INTERVAL = 5_000;

export function startPm2Monitor(): () => void {
  const prevStates = new Map<string, { status: string; restarts: number; unstableRestarts: number }>();

  const run = async () => {
    try {
      if (eventBus.getClientCount() === 0) return;

      const { stdout } = await execAsync('pm2 jlist', { timeout: 10000 });
      const rawProcesses = parsePM2Processes(stdout);

      const [actualPorts, childPidMap] = await Promise.all([
        getActualListeningPorts(),
        getChildPidMap(),
      ]);
      const processes = overlayActualPorts(rawProcesses, actualPorts, childPidMap);

      for (const proc of processes) {
        const name = proc.name || String(proc.pm_id);
        const prev = prevStates.get(name);
        const curStatus = (proc.status as string) || 'unknown';
        const curRestarts = proc.restarts ?? 0;
        const curUnstable = proc.unstableRestarts ?? 0;

        if (prev) {
          if (prev.status !== curStatus) {
            let eventType: string;
            let severity: 'info' | 'high' | 'critical' = 'info';
            if (curStatus === 'online' && prev.status !== 'online') {
              eventType = 'start';
            } else if (curStatus === 'stopped') {
              eventType = 'stop';
            } else if (curStatus === 'errored') {
              eventType = 'error';
              severity = 'high';
            } else {
              eventType = 'restart';
            }

            logEvent('service', severity, `${name} ${eventType} (${prev.status} → ${curStatus})`, {
              event: eventType,
              serviceName: name,
              pm2Id: proc.pm_id,
              pid: proc.pid,
              restartCount: curRestarts,
              memoryMB: proc.memory ? Math.round(proc.memory / 1024 / 1024) : undefined,
              cpuPercent: proc.cpu,
            }).catch(() => {});
          } else if (prev.restarts < curRestarts && curStatus === 'online') {
            // Severity heuristic: PM2 increments unstable_restarts when a restart fires
            // under min_uptime — that's the crash-loop signal. A restart that bumps
            // restart_time WITHOUT bumping unstable_restarts is either a clean
            // scheduled bounce (cron_restart) or a manual `pm2 restart`. Logging the
            // latter as 'high' put rag-qdrant-memory's hourly preemptive bounce into
            // recentAlerts 24×/day on equal footing with real crashes.
            const wasUnstable = curUnstable > prev.unstableRestarts;
            const isCronBacked = !!proc.cronRestart;
            const severity: 'info' | 'high' = wasUnstable ? 'high' : 'info';
            const planTag = isCronBacked && !wasUnstable ? ' (scheduled cron_restart)' : '';
            logEvent('service', severity, `${name} restarted (restart #${curRestarts})${planTag}`, {
              event: wasUnstable ? 'crash-restart' : 'planned-restart',
              serviceName: name,
              pm2Id: proc.pm_id,
              pid: proc.pid,
              restartCount: curRestarts,
              unstableRestarts: curUnstable,
              unstableDelta: curUnstable - prev.unstableRestarts,
              cronRestart: proc.cronRestart,
            }).catch(() => {});
          }
        }
        prevStates.set(name, { status: curStatus, restarts: curRestarts, unstableRestarts: curUnstable });
      }

      const portsInUse = getPortsInUse(processes);
      eventBus.emitEvent('pm2:status', {
        processes,
        portsInUse,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // PM2 not running or transient error - skip this cycle
    }
  };

  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] SSE PM2 monitor loop started (5s interval)');
  return () => clearInterval(timer);
}
