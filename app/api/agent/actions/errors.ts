/**
 * Error Tracker Actions
 *
 * Query the in-memory error ring buffer.
 *
 * Actions:
 *   errors.list  — list recent errors with optional filters
 *   errors.stats — counts by category for last 1h / 24h
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { errorTracker } from '@/lib/error-tracker';
import type { TrackedError, StatsSnapshot } from '@/lib/error-tracker';

/**
 * errors.list
 *
 * Optional body fields:
 *   severity  — 'critical' | 'high' | 'medium' | 'low'
 *   source    — partial string match against source field
 *   type      — 'error:api' | 'error:collab' | 'error:agent'
 *   since     — ISO timestamp, only errors with lastSeen >= since
 *   limit     — max results (default 100)
 *   offset    — pagination offset (default 0)
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ errors: TrackedError[]; total: number }> {
  const { severity, source, type, since, limit, offset } = body as {
    severity?: TrackedError['severity'];
    source?: string;
    type?: TrackedError['type'];
    since?: string;
    limit?: number;
    offset?: number;
  };

  return errorTracker.list({
    severity,
    source,
    type,
    since,
    limit: typeof limit === 'number' ? limit : 100,
    offset: typeof offset === 'number' ? offset : 0,
  });
}

/**
 * errors.stats
 *
 * Returns counts bucketed by type and severity for last 1h and 24h.
 */
export async function stats(
  _body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  last1h: StatsSnapshot;
  last24h: StatsSnapshot;
  total: number;
  bufferSize: number;
}> {
  return errorTracker.stats();
}
