/**
 * Browser Testing Actions
 *
 * Actions for interacting with the browser bridge for automated testing.
 */

import { promises as fs } from 'fs';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { emitApiError } from '@/lib/event-bus';
import type {
  AgentApiRequest,
  AgentAuthContext,
  BrowserBridgeData,
  BrowserTask,
  BrowserTaskResult,
  BrowserSession,
} from '@/lib/types';
import { getWindowsHome } from '@/lib/home-dir';

const BRIDGE_PATH = DataPaths.bridges.browser;

const DEFAULT_BRIDGE_DATA: BrowserBridgeData = {
  sessions: [],
  pendingTasks: [],
  completedTasks: [],
  config: {
    bridgePath: `${getWindowsHome()}/devflow-bridge`,
    pollInterval: 10000,
    taskTimeout: 60000,
    maxHistory: 50,
    autoCleanup: true,
  },
  lastUpdated: new Date().toISOString(),
};

async function loadBridgeData(): Promise<BrowserBridgeData> {
  return readJsonFile<BrowserBridgeData>(BRIDGE_PATH, DEFAULT_BRIDGE_DATA);
}

async function saveBridgeData(data: BrowserBridgeData): Promise<void> {
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(BRIDGE_PATH, data);
}

/**
 * browser.status - Get browser bridge status
 */
export async function status(
  _body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  sessions: BrowserSession[];
  pendingTasks: number;
  recentResults: number;
  config: BrowserBridgeData['config'];
}> {
  const data = await loadBridgeData();

  return {
    sessions: data.sessions,
    pendingTasks: data.pendingTasks.length,
    recentResults: data.completedTasks.length,
    config: data.config,
  };
}

/**
 * browser.submit - Submit a browser test task
 */
export async function submit(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ taskId: string; submitted: boolean }> {
  const task = body.task as Partial<BrowserTask> | undefined;

  if (!task) {
    throw new Error('task object is required');
  }

  if (!task.context || typeof task.context !== 'string') {
    throw new Error('task.context is required (description of what to test)');
  }

  const data = await loadBridgeData();
  const now = new Date().toISOString();
  const taskId = crypto.randomUUID();

  const newTask: BrowserTask = {
    id: taskId,
    timestamp: now,
    project: typeof task.project === 'string' ? task.project : 'agent-api',
    from: 'devflow',
    devServerUrl: typeof task.devServerUrl === 'string' ? task.devServerUrl : 'http://localhost:3000',
    context: task.context,
    type: task.type && ['navigate', 'screenshot', 'interact', 'inspect', 'verify', 'debug'].includes(task.type)
      ? task.type
      : 'verify',
    steps: Array.isArray(task.steps) ? task.steps : [],
    status: 'pending',
    priority: task.priority && ['low', 'normal', 'high'].includes(task.priority)
      ? task.priority
      : 'normal',
    timeout: typeof task.timeout === 'number' ? task.timeout : 60000,
  };

  data.pendingTasks.push(newTask);

  // Also write to bridge directory for the watcher
  try {
    const bridgeTaskPath = `${data.config.bridgePath}/tasks/${taskId}.json`;
    await fs.writeFile(bridgeTaskPath, JSON.stringify(newTask, null, 2));
  } catch (error) {
  }

  await saveBridgeData(data);

  return { taskId, submitted: true };
}

/**
 * browser.result - Get results of a browser task
 */
export async function result(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  result: BrowserTaskResult | null;
  task: BrowserTask | null;
  found: boolean;
  status: string;
}> {
  const taskId = body.taskId;

  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }

  const data = await loadBridgeData();

  // Check completed tasks
  const completedResult = data.completedTasks.find(r => r.taskId === taskId);
  if (completedResult) {
    return {
      result: completedResult,
      task: null,
      found: true,
      status: 'completed',
    };
  }

  // Check pending tasks
  const pendingTask = data.pendingTasks.find(t => t.id === taskId);
  if (pendingTask) {
    return {
      result: null,
      task: pendingTask,
      found: true,
      status: pendingTask.status,
    };
  }

  // Check bridge results directory
  try {
    const bridgeResultPath = `${data.config.bridgePath}/results/${taskId}.json`;
    const content = await fs.readFile(bridgeResultPath, 'utf-8');
    const bridgeResult = JSON.parse(content) as BrowserTaskResult;

    // Add to completed tasks
    data.completedTasks.push(bridgeResult);

    // Remove from pending if present
    const pendingIndex = data.pendingTasks.findIndex(t => t.id === taskId);
    if (pendingIndex !== -1) {
      data.pendingTasks.splice(pendingIndex, 1);
    }

    await saveBridgeData(data);

    return {
      result: bridgeResult,
      task: null,
      found: true,
      status: 'completed',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[browser.result] Failed to read bridge result file:', error);
      emitApiError(error, 'api/agent/actions/browser', { severity: 'medium', context: { taskId } });
    }
  }

  return {
    result: null,
    task: null,
    found: false,
    status: 'not_found',
  };
}

/**
 * browser.cancel - Cancel a pending browser task
 */
export async function cancel(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ cancelled: boolean; taskId: string }> {
  const taskId = body.taskId;

  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }

  const data = await loadBridgeData();

  const taskIndex = data.pendingTasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    throw new Error(`Task not found or already completed: ${taskId}`);
  }

  // Remove from pending
  data.pendingTasks.splice(taskIndex, 1);

  // Try to remove from bridge directory
  try {
    const bridgeTaskPath = `${data.config.bridgePath}/tasks/${taskId}.json`;
    await fs.unlink(bridgeTaskPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    }
  }

  await saveBridgeData(data);

  return { cancelled: true, taskId };
}
