/**
 * Cron jobs monitor
 * Polls cron job state every 10s and emits SSE events on change.
 */
import { eventBus } from '../event-bus';
import { DataPaths } from '../data-paths';
import { readJsonFile } from '../data-io';

const INTERVAL = 10_000;

interface CronJobSummary {
  id: string;
  name: string;
  schedule: string;
  jobType: string;
  enabled: boolean;
  status: string;
  lastRun?: string;
  nextRun?: string;
  lastRunError?: string;
}

export function startCronMonitor(): () => void {
  let lastFingerprint: string | null = null;

  const run = async () => {
    try {
      if (eventBus.getClientCount() === 0) return;

      const data = await readJsonFile<{ jobs: CronJobSummary[]; lastUpdated: string }>(
        DataPaths.cronJobs,
        { jobs: [], lastUpdated: '' }
      );

      const fingerprint = data.jobs
        .map((j) => `${j.id}:${j.enabled}:${j.status}:${j.lastRun || ''}`)
        .sort()
        .join('|');

      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        eventBus.emitEvent('cron:status', {
          jobs: data.jobs.map((j) => ({
            id: j.id,
            name: j.name,
            schedule: j.schedule,
            jobType: j.jobType,
            enabled: j.enabled,
            status: j.status,
            lastRun: j.lastRun,
            nextRun: j.nextRun,
            lastRunError: j.lastRunError,
          })),
          enabledCount: data.jobs.filter((j) => j.enabled).length,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Silently ignore cron check errors in background loop
    }
  };

  const timer = setInterval(run, INTERVAL);
  console.log('[DevFlow] SSE cron jobs monitor loop started (10s interval)');
  return () => clearInterval(timer);
}
