import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { pm2Status } from '@/lib/host-bridge/client';
import { runProjectHealthChecks } from '@/lib/health-checks';
import { readJsonFile } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import { requireAuthOrLocal } from '@/lib/api-auth';
import type { Project, PM2Process, ProjectHealthStatus, CronJob, CronJobsData, WatchdogState } from '@/lib/types';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

interface WatchdogLogsData {
  services: WatchdogState[];
}

export interface ServiceDetailData {
  project: Project;
  pm2Process: PM2Process | null;
  health: ProjectHealthStatus | null;
  cronJobs: CronJob[];
  watchdog: WatchdogState | null;
}

export const GET = tracked('/api/services/:id', async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const { id } = await params;

  try {
    const config = await loadConfig();
    const project = config.projects.find(p => p.id === id);

    if (!project) {
      return NextResponse.json({ success: false, error: `Service '${id}' not found` }, { status: 404 });
    }

    // Fetch PM2, health, cron, and watchdog data in parallel
    const [pm2Result, healthResult, cronData, watchdogData] = await Promise.allSettled([
      pm2Status(),
      runProjectHealthChecks(project),
      readJsonFile<CronJobsData>(DataPaths.cronJobs, { jobs: [], lastUpdated: '' }),
      readJsonFile<WatchdogLogsData>(DataPaths.watchdogLogs, { services: [] }),
    ]);

    // PM2 process — match by pm2Name or project name
    let pm2Process: PM2Process | null = null;
    if (pm2Result.status === 'fulfilled') {
      const pm2Name = project.server?.pm2Name ?? project.name;
      pm2Process = pm2Result.value.processes.find(p => p.name === pm2Name) ?? null;
    }

    // Health status
    let health: ProjectHealthStatus | null = null;
    if (healthResult.status === 'fulfilled') {
      health = healthResult.value;
    }

    // Cron jobs associated with this service (by tags or service name match)
    let cronJobs: CronJob[] = [];
    if (cronData.status === 'fulfilled') {
      const pm2Name = project.server?.pm2Name ?? project.name;
      cronJobs = cronData.value.jobs.filter(job =>
        job.tags?.includes(id) ||
        job.tags?.includes(pm2Name) ||
        job.name.toLowerCase().includes(project.name.toLowerCase())
      );
    }

    // Watchdog state for this service
    let watchdog: WatchdogState | null = null;
    if (watchdogData.status === 'fulfilled') {
      watchdog = watchdogData.value.services?.find(s => s.projectId === id) ?? null;
    }

    const response: ServiceDetailData = {
      project,
      pm2Process,
      health,
      cronJobs,
      watchdog,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
});
