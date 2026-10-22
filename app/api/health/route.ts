import { NextRequest, NextResponse } from 'next/server';
import { getProjects } from '@/lib/config';
import { runProjectHealthChecks, runHealthCheck } from '@/lib/health-checks';
import { ProjectHealthStatus, HealthCheck } from '@/lib/types';
import { eventBus } from '@/lib/event-bus';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

/** Build a status map and emit via SSE event bus */
function emitHealthStatuses(statuses: ProjectHealthStatus[]) {
  const statusMap: Record<string, ProjectHealthStatus> = {};
  for (const s of statuses) {
    statusMap[s.projectId] = s;
  }
  eventBus.emitEvent('health:status', { statuses: statusMap });
}

interface CustomCheckRequest {
  id: string;
  type: string;
  url?: string;
  port?: number;
  label: string;
}

export const POST = tracked('/api/health', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    let projectIds: string[] | undefined;
    let customChecks: CustomCheckRequest[] | undefined;
    try {
      const body = await request.json();
      projectIds = body?.projectIds;
      customChecks = body?.customChecks;
    } catch {
      // Empty or invalid body — treat as "check all projects"
    }

    const statuses: ProjectHealthStatus[] = [];

    // Run project health checks if requested (or all if no filters)
    if (!customChecks || (projectIds && projectIds.length > 0)) {
      const allProjects = await getProjects();
      const projectsToCheck = projectIds && projectIds.length > 0
        ? allProjects.filter((p) => projectIds!.includes(p.id))
        : customChecks ? [] : allProjects;

      const projectStatuses = await Promise.all(
        projectsToCheck.map((project) => runProjectHealthChecks(project))
      );
      statuses.push(...projectStatuses);
    }

    // Run custom ad-hoc health checks (used by AppLibrary for app-registry entries)
    if (customChecks && Array.isArray(customChecks)) {
      const customStatuses = await Promise.all(
        customChecks.map(async (check) => {
          let healthCheck: HealthCheck;
          if (check.type === 'http' && check.url) {
            healthCheck = { type: 'http', url: check.url, label: check.label };
          } else if (check.type === 'port' && check.port) {
            healthCheck = { type: 'port', port: check.port, label: check.label };
          } else {
            return {
              projectId: check.id,
              overallStatus: 'unknown' as const,
              checks: [],
              lastChecked: new Date().toISOString(),
            };
          }
          const result = await runHealthCheck(healthCheck, 0);
          return {
            projectId: check.id,
            overallStatus: result.status,
            checks: [result],
            lastChecked: new Date().toISOString(),
          } as ProjectHealthStatus;
        })
      );
      statuses.push(...customStatuses);
    }

    // Push project statuses to SSE clients (not custom checks)
    const projectStatuses = statuses.filter(
      (s) => !customChecks?.some((c) => c.id === s.projectId)
    );
    if (projectStatuses.length > 0) {
      emitHealthStatuses(projectStatuses);
    }

    return NextResponse.json({ statuses });
  } catch (error) {
    console.error('Error running health checks:', error);
    return NextResponse.json(
      { error: 'Failed to run health checks' },
      { status: 500 }
    );
  }
});

export const GET = tracked('/api/health', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const projects = await getProjects();
    const statuses: ProjectHealthStatus[] = await Promise.all(
      projects.map((project) => runProjectHealthChecks(project))
    );

    // Push to SSE clients
    emitHealthStatuses(statuses);

    return NextResponse.json({ statuses });
  } catch (error) {
    console.error('Error running health checks:', error);
    return NextResponse.json(
      { error: 'Failed to run health checks' },
      { status: 500 }
    );
  }
});
