/**
 * Browser Bridge API
 *
 * Enables communication between Claude Code instances running in different environments:
 * - WSL (code editing, builds, git)
 * - Windows PowerShell (Chrome browser control via /chrome)
 *
 * Uses a shared file bridge at /mnt/c/Users/<windows-user>/devflow-bridge/ for cross-environment
 * communication, with this API providing a structured interface for DevFlow UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';
import {
  BrowserBridgeResponse,
  BrowserBridgeActionRequest,
  BrowserBridgeActionResponse,
  BrowserBridgeData,
  BrowserTask,
  BrowserTaskResult,
  BrowserSession,
} from '@/lib/types';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { validateBodySize } from '@/lib/fetch-utils';

// Bridge paths - Windows path accessible from WSL
const BRIDGE_BASE = `${getWindowsHome()}/devflow-bridge`;
const TASKS_DIR = path.join(BRIDGE_BASE, 'tasks');
const RESULTS_DIR = path.join(BRIDGE_BASE, 'results');
const WSL_TO_CHROME = path.join(BRIDGE_BASE, 'wsl-to-chrome.json');
const CHROME_TO_WSL = path.join(BRIDGE_BASE, 'chrome-to-wsl.json');

// DevFlow data storage
import { DataPaths } from '@/lib/data-paths';
import { tracked } from '@/lib/api-tracking';
import { getWindowsHome } from '@/lib/home-dir';
const DATA_FILE = DataPaths.bridges.browser;

/**
 * Initialize default data structure
 */
function getDefaultData(): BrowserBridgeData {
  return {
    sessions: [],
    pendingTasks: [],
    completedTasks: [],
    config: {
      bridgePath: BRIDGE_BASE,
      pollInterval: 5000,
      taskTimeout: 60000,
      maxHistory: 50,
      autoCleanup: true,
    },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Load data from DevFlow storage
 */
async function loadData(): Promise<BrowserBridgeData> {
  return readJsonFile<BrowserBridgeData>(DATA_FILE, getDefaultData());
}

/**
 * Save data to DevFlow storage (locked write)
 */
async function saveData(data: BrowserBridgeData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await withFileLock(DATA_FILE, () => writeJsonFile(DATA_FILE, data));
}

/**
 * Scan bridge directories for tasks and results
 */
async function scanBridge(): Promise<{
  tasks: BrowserTask[];
  results: BrowserTaskResult[];
  wslStatus: Record<string, unknown> | null;
  chromeStatus: Record<string, unknown> | null;
}> {
  const tasks: BrowserTask[] = [];
  const results: BrowserTaskResult[] = [];
  let wslStatus: Record<string, unknown> | null = null;
  let chromeStatus: Record<string, unknown> | null = null;

  try {
    // Scan tasks directory
    const taskFiles = await fs.readdir(TASKS_DIR).catch(() => []);
    for (const file of taskFiles) {
      if (file.endsWith('.json')) {
        try {
          const content = await fs.readFile(path.join(TASKS_DIR, file), 'utf-8');
          const task = JSON.parse(content) as BrowserTask;
          task.status = task.status || 'pending';
          tasks.push(task);
        } catch {
          // Skip invalid files
        }
      }
    }

    // Scan results directory
    const resultFiles = await fs.readdir(RESULTS_DIR).catch(() => []);
    for (const file of resultFiles) {
      if (file.endsWith('.json')) {
        try {
          const content = await fs.readFile(path.join(RESULTS_DIR, file), 'utf-8');
          results.push(JSON.parse(content) as BrowserTaskResult);
        } catch {
          // Skip invalid files
        }
      }
    }

    // Read status files
    try {
      const wslContent = await fs.readFile(WSL_TO_CHROME, 'utf-8');
      wslStatus = JSON.parse(wslContent);
    } catch {
      // No WSL status
    }

    try {
      const chromeContent = await fs.readFile(CHROME_TO_WSL, 'utf-8');
      chromeStatus = JSON.parse(chromeContent);
    } catch {
      // No Chrome status
    }
  } catch {
    // Bridge directory might not exist
  }

  return { tasks, results, wslStatus, chromeStatus };
}

/**
 * Derive session status from bridge files
 */
function deriveSession(
  platform: 'wsl' | 'chrome-powershell',
  status: Record<string, unknown> | null
): BrowserSession | null {
  if (!status) return null;

  const now = new Date();
  const statusTime = status.timestamp ? new Date(status.timestamp as string) : now;
  const ageMs = now.getTime() - statusTime.getTime();
  const isStale = ageMs > 60000; // 1 minute threshold

  return {
    sessionId: `${platform}-${statusTime.getTime()}`,
    platform: platform === 'wsl' ? 'wsl' : 'windows-powershell',
    status: isStale ? 'disconnected' : (status.ready_for_tasks ? 'connected' : 'busy'),
    connectedAt: statusTime.toISOString(),
    lastHeartbeat: statusTime.toISOString(),
    capabilities: (status.capabilities_confirmed as string[] || []).map(name => ({
      name,
      available: true,
    })),
    currentPage: status.connection_test
      ? (status.connection_test as Record<string, unknown>).url as string
      : undefined,
    projectContext: status.project as string,
  };
}

/**
 * GET - Retrieve bridge status, pending tasks, and recent results
 */
export const GET = tracked('/api/browser-bridge', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied as NextResponse<BrowserBridgeResponse>;

  try {
    const data = await loadData();
    const bridge = await scanBridge();

    // Derive sessions from status files
    const sessions: BrowserSession[] = [];
    const wslSession = deriveSession('wsl', bridge.wslStatus);
    const chromeSession = deriveSession('chrome-powershell', bridge.chromeStatus);
    if (wslSession) sessions.push(wslSession);
    if (chromeSession) sessions.push(chromeSession);

    // Sort results by timestamp (newest first)
    const sortedResults = bridge.results.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Mark tasks as completed if a matching result exists
    const completedTaskIds = new Set(bridge.results.map(r => r.taskId || r.id));
    const pendingTasks = bridge.tasks.filter(t =>
      t.status === 'pending' && !completedTaskIds.has(t.id)
    );

    return NextResponse.json({
      sessions,
      pendingTasks,
      recentResults: sortedResults.slice(0, data.config.maxHistory),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({
      sessions: [],
      pendingTasks: [],
      recentResults: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST - Submit tasks, register sessions, etc.
 */
export const POST = tracked('/api/browser-bridge', async (
  request: NextRequest
) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied as NextResponse<BrowserBridgeActionResponse>;
  const sizeError = validateBodySize(request);
  if (sizeError) return sizeError;

  try {
    const body = (await request.json()) as BrowserBridgeActionRequest;
    const data = await loadData();

    switch (body.action) {
      case 'submit_task': {
        if (!body.task) {
          return NextResponse.json({ success: false, error: 'Task required' });
        }

        const task: BrowserTask = {
          id: body.task.id || `task-${Date.now()}`,
          timestamp: new Date().toISOString(),
          project: body.task.project || 'unknown',
          from: body.task.from || 'devflow',
          devServerUrl: body.task.devServerUrl || 'http://localhost:3000',
          context: body.task.context || '',
          type: body.task.type || 'verify',
          steps: body.task.steps || [],
          status: 'pending',
          priority: body.task.priority || 'normal',
          timeout: body.task.timeout || data.config.taskTimeout,
        };

        // Write task to bridge
        const taskFile = path.join(TASKS_DIR, `${task.id}.json`);
        await fs.writeFile(taskFile, JSON.stringify(task, null, 2));

        // Update wsl-to-chrome status (locked — shared file read by Chrome extension)
        await withFileLock(WSL_TO_CHROME, () => fs.writeFile(
          WSL_TO_CHROME,
          JSON.stringify({
            status: 'task_pending',
            from: 'devflow',
            timestamp: new Date().toISOString(),
            message: `New task: ${task.id}`,
            task_file: `tasks/${task.id}.json`,
            project: task.project,
            dev_server: task.devServerUrl,
          }, null, 2)
        ));

        data.pendingTasks.push(task);
        await saveData(data);

        return NextResponse.json({ success: true, taskId: task.id });
      }

      case 'cancel_task': {
        if (!body.taskId) {
          return NextResponse.json({ success: false, error: 'Task ID required' });
        }

        // Remove from bridge
        const taskFile = path.join(TASKS_DIR, `${body.taskId}.json`);
        await fs.unlink(taskFile).catch(() => {});

        // Update local data
        data.pendingTasks = data.pendingTasks.filter(t => t.id !== body.taskId);
        await saveData(data);

        return NextResponse.json({ success: true, taskId: body.taskId });
      }

      case 'get_results': {
        const bridge = await scanBridge();
        const result = body.taskId
          ? bridge.results.find(r => r.taskId === body.taskId)
          : bridge.results[0];

        return NextResponse.json({
          success: true,
          result: result || undefined,
        });
      }

      case 'clear_history': {
        // Clear results directory
        const resultFiles = await fs.readdir(RESULTS_DIR).catch(() => []);
        for (const file of resultFiles) {
          await fs.unlink(path.join(RESULTS_DIR, file)).catch(() => {});
        }

        data.completedTasks = [];
        await saveData(data);

        return NextResponse.json({ success: true });
      }

      case 'register_session':
      case 'heartbeat': {
        // Sessions are auto-discovered from bridge files
        // This endpoint is for manual registration if needed
        return NextResponse.json({
          success: true,
          sessionId: body.sessionId,
        });
      }

      default:
        return NextResponse.json({ success: false, error: 'Unknown action' });
    }
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
