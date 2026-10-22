import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { PM2Response, PM2ActionRequest, PM2ActionResponse } from '@/lib/types';
import { eventBus } from '@/lib/event-bus';
import { pm2Status, pm2Exec } from '@/lib/host-bridge/client';
import { requireAuthOrLocal, errorResponse } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

// GET - Fetch all PM2 processes with metrics
export const GET = tracked('/api/pm2', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'read');
    if (authDenied) return authDenied;

    const { processes, portsInUse } = await pm2Status();

    const response: PM2Response = {
      processes,
      portsInUse,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    // PM2 might not be running or no processes
    const message = error instanceof Error ? error.message : 'Unknown error';

    // Check if PM2 daemon is not running
    if (message.includes('PM2') || message.includes('ENOENT')) {
      return NextResponse.json({
        processes: [],
        portsInUse: {},
        timestamp: new Date().toISOString(),
        warning: 'PM2 daemon may not be running',
      });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
});

// POST - Execute PM2 actions (start, stop, restart, delete)
export const POST = tracked('/api/pm2', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'write');
    if (authDenied) return authDenied;

    const body: PM2ActionRequest = await request.json();
    const { action, target, port } = body;

    if (!action || !target) {
      return NextResponse.json(
        { success: false, error: 'Missing action or target' },
        { status: 400 }
      );
    }

    // Validate action
    const validActions = ['start', 'stop', 'restart', 'delete'];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { success: false, error: `Invalid action: ${action}` },
        { status: 400 }
      );
    }

    // For start/restart, check port conflicts using actual TCP sockets.
    // Use explicitly passed port, or look up the registered port from projects.json.
    if (action === 'start' || action === 'restart') {
      let portToCheck = port;

      if (!portToCheck) {
        // Auto-resolve: find the project registered with this pm2Name and use its declared port
        const config = await loadConfig();
        const registeredProject = config.projects.find(p => p.server?.pm2Name === target);
        if (registeredProject?.server?.port && registeredProject.server.port > 0) {
          portToCheck = registeredProject.server.port;
        }
      }

      if (portToCheck) {
        const { portsInUse: portsMap } = await pm2Status();

        // Check if port is already bound by another process
        const portOwner = portsMap[portToCheck];
        if (portOwner && portOwner !== target) {
          const response: PM2ActionResponse = {
            success: false,
            error: 'port_conflict',
            portConflict: {
              port: portToCheck,
              ownedBy: portOwner,
            },
          };
          return NextResponse.json(response);
        }
      }
    }

    // Execute the PM2 command
    const { stderr } = await pm2Exec(action, target, { timeout: 30000 });

    // For delete action, we might get an error if process doesn't exist
    if (stderr && !stderr.includes('Process') && !stderr.includes('Applying')) {
    }

    // After mutation, fetch fresh PM2 status and push via SSE
    // Small delay to let PM2 settle after the action
    setTimeout(async () => {
      try {
        const { processes: freshProcesses, portsInUse: freshPorts } = await pm2Status();

        const pm2Update: PM2Response = {
          processes: freshProcesses,
          portsInUse: freshPorts,
          timestamp: new Date().toISOString(),
        };

        eventBus.emitEvent('pm2:status', pm2Update);
      } catch {
        // Best effort - instrumentation monitor will catch it on next cycle
      }
    }, 1000);

    const response: PM2ActionResponse = {
      success: true,
      message: `Successfully executed: ${action} ${target}`,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('PM2 action error:', message);

    const response: PM2ActionResponse = {
      success: false,
      error: message,
    };

    return NextResponse.json(response, { status: 500 });
  }
});
