/**
 * Ralph Loop Actions
 *
 * Actions for monitoring and controlling Ralph automated development loops.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig, saveConfig } from '@/lib/config';
import type { AgentApiRequest, AgentAuthContext, RalphLoop, LoopsConfig } from '@/lib/types';

const METRICS_FILE = 'ralph-loop-metrics.json';
const INPUT_FILE = 'ralph-loop-input.json';
const LOCAL_FILE = 'ralph-loop.local.md';

async function loadLoopMetrics(projectPath: string): Promise<RalphLoop | null> {
  try {
    const metricsPath = path.join(projectPath, '.claude', METRICS_FILE);
    const content = await fs.readFile(metricsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function isLoopActive(projectPath: string): Promise<boolean> {
  try {
    const localPath = path.join(projectPath, '.claude', LOCAL_FILE);
    await fs.access(localPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * loops.list - List active and history loops
 */
export async function list(
  _body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  active: RalphLoop[];
  history: RalphLoop[];
  watchPaths: string[];
}> {
  const config = await loadConfig();
  const loopsConfig = (config as unknown as { loopsConfig?: LoopsConfig }).loopsConfig;
  const watchPaths = loopsConfig?.watchPaths || [];

  const active: RalphLoop[] = [];
  const history: RalphLoop[] = [];

  for (const projectPath of watchPaths) {
    const loop = await loadLoopMetrics(projectPath);
    if (!loop) continue;

    const isActive = await isLoopActive(projectPath);
    const isRunning = loop.final_status === 'running' || loop.final_status === 'awaiting_input';

    if (isActive && isRunning) {
      active.push(loop);
    } else {
      history.push(loop);
    }
  }

  // Sort history by started_at descending
  history.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  // Limit history
  const historyLimit = loopsConfig?.historyLimit || 10;

  return {
    active,
    history: history.slice(0, historyLimit),
    watchPaths,
  };
}

/**
 * loops.get - Get details of a specific loop
 */
export async function get(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ loop: RalphLoop | null; found: boolean; isActive: boolean }> {
  const projectPath = body.projectPath;

  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath is required');
  }

  const loop = await loadLoopMetrics(projectPath);
  const isActive = loop ? await isLoopActive(projectPath) : false;

  return {
    loop,
    found: !!loop,
    isActive,
  };
}

/**
 * loops.submit_input - Submit human input to an awaiting loop
 */
export async function submitInput(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ submitted: boolean; message: string }> {
  const projectPath = body.projectPath;
  const response = body.response;
  const selectedOption = body.selectedOption;

  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath is required');
  }

  if (response === undefined && selectedOption === undefined) {
    throw new Error('Either response or selectedOption is required');
  }

  // Check if loop exists and is awaiting input
  const loop = await loadLoopMetrics(projectPath);
  if (!loop) {
    throw new Error(`No loop found at: ${projectPath}`);
  }

  if (loop.final_status !== 'awaiting_input') {
    throw new Error(`Loop is not awaiting input (status: ${loop.final_status})`);
  }

  // Write input file
  const inputPath = path.join(projectPath, '.claude', INPUT_FILE);
  const inputData = {
    timestamp: new Date().toISOString(),
    response: typeof response === 'string' ? response : undefined,
    selectedOption: typeof selectedOption === 'number' ? selectedOption : undefined,
    iteration: loop.awaiting_input?.iteration,
  };

  await fs.writeFile(inputPath, JSON.stringify(inputData, null, 2));

  return {
    submitted: true,
    message: 'Input submitted successfully. Loop will continue.',
  };
}

/**
 * loops.cancel - Cancel a running loop
 */
export async function cancel(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ cancelled: boolean; message: string }> {
  const projectPath = body.projectPath;

  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath is required');
  }

  // Check if loop exists
  const loop = await loadLoopMetrics(projectPath);
  if (!loop) {
    throw new Error(`No loop found at: ${projectPath}`);
  }

  // Remove the local file to signal cancellation
  try {
    const localPath = path.join(projectPath, '.claude', LOCAL_FILE);
    await fs.unlink(localPath);
  } catch {
    // File might not exist
  }

  // Update metrics to cancelled status
  const metricsPath = path.join(projectPath, '.claude', METRICS_FILE);
  loop.final_status = 'cancelled';
  loop.completed_at = new Date().toISOString();
  await fs.writeFile(metricsPath, JSON.stringify(loop, null, 2));

  return {
    cancelled: true,
    message: 'Loop cancelled successfully.',
  };
}

/**
 * loops.register - Register a project for loop monitoring
 */
export async function register(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ registered: boolean; watchPaths: string[] }> {
  const projectPath = body.path || body.projectPath;

  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('path or projectPath is required');
  }

  // Verify path exists
  try {
    await fs.access(projectPath);
  } catch {
    throw new Error(`Path does not exist: ${projectPath}`);
  }

  const config = await loadConfig();

  // Initialize loopsConfig if needed
  const configWithLoops = config as unknown as { loopsConfig?: LoopsConfig };
  if (!configWithLoops.loopsConfig) {
    configWithLoops.loopsConfig = {
      watchPaths: [],
      historyLimit: 10,
    };
  }

  // Add path if not already registered
  if (!configWithLoops.loopsConfig.watchPaths.includes(projectPath)) {
    configWithLoops.loopsConfig.watchPaths.push(projectPath);
    await saveConfig(config);
  }

  return {
    registered: true,
    watchPaths: configWithLoops.loopsConfig.watchPaths,
  };
}
