/**
 * Watchdog Agent API Actions
 *
 * Provides programmatic access to the service watchdog system.
 * Actions: watchdog.status, watchdog.toggle, watchdog.logs, watchdog.reset
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import * as watchdog from '@/lib/service-watchdog';

/**
 * Get current watchdog status for all monitored services
 */
export async function status(
  _body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<unknown> {
  const states = watchdog.getStates();
  const events = await watchdog.getRecentEvents(50);

  return {
    services: states,
    recentEvents: events,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get watchdog event log
 */
export async function logs(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<unknown> {
  const limit = typeof body.limit === 'number' ? body.limit : 50;
  const events = await watchdog.getRecentEvents(limit);

  return {
    events,
    count: events.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Toggle watchdog for a specific service (runtime only)
 */
export async function toggle(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<unknown> {
  const { projectId, enabled } = body as { projectId?: string; enabled?: boolean };

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('MISSING_FIELD:projectId');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('MISSING_FIELD:enabled');
  }

  watchdog.toggleService(projectId, enabled);

  return {
    projectId,
    enabled,
    message: `Watchdog ${enabled ? 'enabled' : 'disabled'} for ${projectId}`,
  };
}

/**
 * Reset cooldown for a specific service
 */
export async function reset(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<unknown> {
  const { projectId } = body as { projectId?: string };

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('MISSING_FIELD:projectId');
  }

  watchdog.resetCooldown(projectId);

  return {
    projectId,
    message: `Cooldown reset for ${projectId}`,
  };
}
