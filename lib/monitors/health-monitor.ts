/**
 * Health check + watchdog monitor
 * Runs every 15s; watchdog evaluates every 30s (every other cycle).
 */
import { eventBus } from '../event-bus';
import { getProjects } from '../config';
import { runProjectHealthChecks } from '../health-checks';
import { logEvent } from '../log-writer';
import { evaluate as watchdogEvaluate } from '../service-watchdog';
import { isServiceExpectedOnline } from '../stability-helpers';
import type { ProjectHealthStatus } from '../types';

const INTERVAL = 15_000;

export function startHealthMonitor(): () => void {
  let cycle = 0;
  const prevHealthFail = new Map<string, boolean>();

  const run = async () => {
    try {
      const projects = await getProjects();
      const statuses = await Promise.all(projects.map((p) => runProjectHealthChecks(p)));

      const statusMap: Record<string, unknown> = {};
      for (const s of statuses) statusMap[s.projectId] = s;

      for (const s of statuses) {
        const failing = s.overallStatus === 'offline' || s.overallStatus === 'warning';
        const wasFailing = prevHealthFail.get(s.projectId) ?? false;
        const checkDetails = s.checks.map((c) => ({
          label: c.label,
          status: c.status,
          responseTime: c.responseTime,
          message: c.message,
        }));
        const avg =
          checkDetails.reduce((sum, c) => sum + (c.responseTime ?? 0), 0) / (checkDetails.length || 1);

        if (failing && !wasFailing) {
          // 2026-05-18: services that aren't expected to be online (dev servers,
          // optional/manual-start services) shouldn't drive medium-severity
          // alerts when they go offline — that's their normal state. Demote to
          // 'low' so the dashboard still gets the status update but the alerts
          // panel isn't flooded with "dev-Acme-media health check offline"
          // every time a dev site isn't running.
          const expectedOnline = isServiceExpectedOnline(s.projectId, projects);
          const severity = expectedOnline ? 'medium' : 'low';
          logEvent('service', severity, `${s.projectId} health check ${s.overallStatus}`, {
            event: 'health-fail',
            serviceName: s.projectId,
            reason: s.overallStatus,
            expectedOnline,
            checks: checkDetails,
            failedChecks: s.checks
              .filter((c) => c.status === 'offline' || c.status === 'warning')
              .map((c) => c.label),
            avgResponseTime: avg,
          }).catch(() => {});
        } else if (!failing && wasFailing) {
          logEvent('service', 'info', `${s.projectId} health check recovered`, {
            event: 'health-recover',
            serviceName: s.projectId,
            checks: checkDetails,
            avgResponseTime: avg,
          }).catch(() => {});
        }
        prevHealthFail.set(s.projectId, failing);
      }

      if (eventBus.getClientCount() > 0) {
        eventBus.emitEvent('health:status', { statuses: statusMap });
      }

      cycle++;
      if (cycle % 2 === 0) {
        await watchdogEvaluate(
          projects,
          statusMap as Record<string, ProjectHealthStatus>
        ).catch((err: unknown) => {
          console.error('[DevFlow] Watchdog evaluation error:', err);
        });
      }
    } catch {
      // Silently ignore health check errors in background loop
    }
  };

  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] SSE health check loop started (15s interval, watchdog every 30s)');
  return () => clearInterval(timer);
}
