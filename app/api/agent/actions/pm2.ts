/**
 * PM2 Process Management Actions
 *
 * Actions for managing PM2 processes via host-bridge client.
 */

import { pm2Status, pm2List, pm2Exec, pm2Logs as pm2LogsClient } from '@/lib/host-bridge/client';
import type { AgentApiRequest, AgentAuthContext, PM2Process } from '@/lib/types';

/**
 * pm2.list - List all PM2 processes
 */
export async function list(
  _body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  processes: PM2Process[];
  portsInUse: Record<number, string>;
  count: number;
}> {
  try {
    const { processes, portsInUse } = await pm2Status();
    return { processes, portsInUse, count: processes.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('PM2') || message.includes('ENOENT')) {
      return { processes: [], portsInUse: {}, count: 0 };
    }
    throw error;
  }
}

/**
 * pm2.status - Get status of a specific PM2 process
 */
export async function status(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  process: PM2Process | null;
  found: boolean;
}> {
  const target = body.target || body.name;

  if (!target || typeof target !== 'string') {
    throw new Error('target (process name or ID) is required');
  }

  try {
    const processes = await pm2List();
    const proc = processes.find(
      p => p.name === target || p.pm_id.toString() === target
    );
    return { process: proc || null, found: !!proc };
  } catch {
    return { process: null, found: false };
  }
}

/**
 * pm2.start - Start a PM2 process
 */
export async function start(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  success: boolean;
  message: string;
  portConflict?: { port: number; ownedBy: string };
}> {
  const target = body.target || body.name;
  const port = body.port;

  if (!target || typeof target !== 'string') {
    throw new Error('target (process name or config file) is required');
  }

  // Check for port conflicts if port specified
  if (port && typeof port === 'number') {
    const { portsInUse } = await pm2Status();
    const portOwner = portsInUse[port];
    if (portOwner && portOwner !== target) {
      return {
        success: false,
        message: `Port ${port} is already in use by ${portOwner}`,
        portConflict: { port, ownedBy: portOwner },
      };
    }
  }

  await pm2Exec('start', target, { timeout: 30000 });
  return { success: true, message: `Successfully started: ${target}` };
}

/**
 * pm2.stop - Stop a PM2 process
 */
export async function stop(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ success: boolean; message: string }> {
  const target = body.target || body.name;

  if (!target || typeof target !== 'string') {
    throw new Error('target (process name or ID) is required');
  }

  await pm2Exec('stop', target, { timeout: 30000 });
  return { success: true, message: `Successfully stopped: ${target}` };
}

/**
 * pm2.restart - Restart a PM2 process
 */
export async function restart(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  success: boolean;
  message: string;
  portConflict?: { port: number; ownedBy: string };
}> {
  const target = body.target || body.name;
  const port = body.port;

  if (!target || typeof target !== 'string') {
    throw new Error('target (process name or ID) is required');
  }

  // Check for port conflicts if port specified
  if (port && typeof port === 'number') {
    const { portsInUse } = await pm2Status();
    const portOwner = portsInUse[port];
    if (portOwner && portOwner !== target) {
      return {
        success: false,
        message: `Port ${port} is already in use by ${portOwner}`,
        portConflict: { port, ownedBy: portOwner },
      };
    }
  }

  await pm2Exec('restart', target, { timeout: 30000 });
  return { success: true, message: `Successfully restarted: ${target}` };
}

/**
 * pm2.logs - Get recent logs from a PM2 process
 */
export async function logs(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  logs: string[];
  lines: number;
  processName: string;
}> {
  const target = body.target || body.name;
  const lineCount = typeof body.lines === 'number' ? Math.min(body.lines, 500) : 50;

  if (!target || typeof target !== 'string') {
    throw new Error('target (process name or ID) is required');
  }

  try {
    const result = await pm2LogsClient(target, lineCount);
    return {
      logs: result.lines,
      lines: result.count,
      processName: target,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to get logs for ${target}: ${message}`);
  }
}
