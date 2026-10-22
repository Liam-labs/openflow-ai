import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import type { RalphLoop, LoopsResponse, LoopActionRequest, LoopActionResponse, LoopsConfig } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appPath, appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

const CONFIG_PATH = appPath('config', 'projects.json');
const METRICS_FILENAME = '.claude/ralph-loop-metrics.json';
const STATE_FILENAME = '.claude/ralph-loop.local.md';
const INPUT_FILENAME = '.claude/ralph-loop-input.json';

async function getLoopsConfig(): Promise<LoopsConfig> {
  try {
    const configData = await fs.readFile(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(configData);
    return config.loopsConfig || { watchPaths: [], historyLimit: 20 };
  } catch {
    return { watchPaths: [], historyLimit: 20 };
  }
}

async function readMetricsFile(projectPath: string): Promise<RalphLoop | null> {
  const metricsPath = path.join(projectPath, METRICS_FILENAME);
  try {
    const data = await fs.readFile(metricsPath, 'utf-8');
    const metrics = JSON.parse(data);

    // Validate required fields
    if (!metrics.session_id || !metrics.project_path) {
      return null;
    }

    return metrics as RalphLoop;
  } catch {
    return null;
  }
}

async function isLoopActive(projectPath: string): Promise<boolean> {
  const statePath = path.join(projectPath, STATE_FILENAME);
  try {
    await fs.access(statePath);
    return true;
  } catch {
    return false;
  }
}

async function scanForLoops(watchPaths: string[], historyLimit: number): Promise<{ active: RalphLoop[]; history: RalphLoop[] }> {
  const active: RalphLoop[] = [];
  const history: RalphLoop[] = [];

  for (const watchPath of watchPaths) {
    try {
      // Check if directory exists
      await fs.access(watchPath);

      const metrics = await readMetricsFile(watchPath);
      if (metrics) {
        // Check if this loop is currently active (state file exists)
        const isActive = await isLoopActive(watchPath);

        // Active if state file exists AND status is running or awaiting_input
        const isActiveStatus = metrics.final_status === 'running' || metrics.final_status === 'awaiting_input';

        if (isActive && isActiveStatus) {
          active.push(metrics);
        } else {
          // Update status if state file is gone but metrics says running/awaiting
          if (metrics.final_status === 'running' || metrics.final_status === 'awaiting_input') {
            metrics.final_status = 'cancelled';
            metrics.completed_at = metrics.last_heartbeat; // Use last heartbeat as end time
            // Persist the correction to the file
            try {
              const metricsPath = path.join(watchPath, METRICS_FILENAME);
              await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2));
            } catch {
              // Ignore write errors
            }
          }
          history.push(metrics);
        }
      }
    } catch {
      // Directory doesn't exist or can't be read - skip
      continue;
    }
  }

  // Sort history by started_at descending and limit
  history.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  return {
    active,
    history: history.slice(0, historyLimit)
  };
}

/** Returns true if the resolved path is under an allowed root. */
function isAllowedProjectPath(projectPath: string): boolean {
  const resolved = path.resolve(projectPath);
  const HOME = getHomeDir();
  return resolved.startsWith(HOME + path.sep) || resolved.startsWith(appRoot() + path.sep);
}

export const GET = tracked('/api/claude/loops', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const config = await getLoopsConfig();

    if (config.watchPaths.length === 0) {
      return NextResponse.json<LoopsResponse>({
        active: [],
        history: [],
        timestamp: new Date().toISOString(),
        error: 'No watch paths configured. Add loopsConfig.watchPaths to config/projects.json'
      });
    }

    const { active, history } = await scanForLoops(config.watchPaths, config.historyLimit);

    return NextResponse.json<LoopsResponse>({
      active,
      history,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching loops:', error);
    return NextResponse.json<LoopsResponse>({
      active: [],
      history: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Failed to fetch loops'
    });
  }
});

export const POST = tracked('/api/claude/loops', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body: LoopActionRequest = await request.json();

    if (!body.project_path) {
      return NextResponse.json<LoopActionResponse>({
        success: false,
        error: 'project_path is required'
      }, { status: 400 });
    }

    // Path traversal guard: only allow paths under $HOME or project root
    if (!isAllowedProjectPath(body.project_path)) {
      return NextResponse.json<LoopActionResponse>({
        success: false,
        error: 'Access to this path is not allowed'
      }, { status: 403 });
    }

    const metricsPath = path.join(body.project_path, METRICS_FILENAME);

    if (body.action === 'submit_input') {
      // Write input response file for Ralph to pick up
      const inputPath = path.join(body.project_path, INPUT_FILENAME);

      // Get session_id from metrics
      let sessionId = 'unknown';
      try {
        const metricsData = await fs.readFile(metricsPath, 'utf-8');
        const metrics = JSON.parse(metricsData);
        sessionId = metrics.session_id || 'unknown';
      } catch {
        // Continue without session_id
      }

      const inputResponse = {
        session_id: sessionId,
        response: body.input_response || '',
        selected_option: body.selected_option,
        submitted_at: new Date().toISOString()
      };

      try {
        await fs.writeFile(inputPath, JSON.stringify(inputResponse, null, 2));

        // Update metrics to show input was submitted (Ralph will update to running when it picks up)
        try {
          const metricsData = await fs.readFile(metricsPath, 'utf-8');
          const metrics = JSON.parse(metricsData);
          metrics.input_submitted_at = new Date().toISOString();
          await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2));
        } catch {
          // Metrics update optional
        }

        return NextResponse.json<LoopActionResponse>({
          success: true,
          message: 'Input submitted successfully. Ralph will resume shortly.'
        });
      } catch (error) {
        console.error('Error writing input file:', error);
        return NextResponse.json<LoopActionResponse>({
          success: false,
          error: 'Failed to write input file'
        }, { status: 500 });
      }
    }

    if (body.action === 'cancel') {
      // Delete the state file to cancel the loop
      const statePath = path.join(body.project_path, STATE_FILENAME);

      try {
        await fs.unlink(statePath);

        // Update metrics to show cancelled
        try {
          const metricsData = await fs.readFile(metricsPath, 'utf-8');
          const metrics = JSON.parse(metricsData);
          metrics.final_status = 'cancelled';
          metrics.completed_at = new Date().toISOString();
          await fs.writeFile(metricsPath, JSON.stringify(metrics, null, 2));
        } catch {
          // Metrics file might not exist - that's OK
        }

        return NextResponse.json<LoopActionResponse>({
          success: true,
          message: 'Loop cancelled successfully'
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return NextResponse.json<LoopActionResponse>({
            success: false,
            error: 'Loop is not currently active'
          }, { status: 404 });
        }
        throw error;
      }
    }

    return NextResponse.json<LoopActionResponse>({
      success: false,
      error: `Unknown action: ${body.action}`
    }, { status: 400 });
  } catch (error) {
    console.error('Error executing loop action:', error);
    return NextResponse.json<LoopActionResponse>({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to execute action'
    }, { status: 500 });
  }
});
