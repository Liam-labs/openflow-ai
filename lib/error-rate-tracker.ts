/**
 * Error Rate Tracker — Rolling window aggregation of API response status codes
 *
 * Tracks 4xx and 5xx responses from DevFlow API routes.
 * Maintains in-memory circular buffers for 1m, 5m, and 1h windows.
 * Exposed via GET /api/logs/error-rates.
 *
 * Usage in API routes:
 *   import { trackResponse } from '@/lib/error-rate-tracker';
 *   trackResponse('/api/collab', 200);  // in finally block or response wrapper
 */

interface ResponseRecord {
  timestamp: number;
  route: string;
  status: number;
}

// Circular buffer — keeps last N records, auto-prunes on read
const MAX_RECORDS = 10_000;
const records: ResponseRecord[] = [];
let writeIndex = 0;
let totalRecords = 0;

// Window durations in ms
const WINDOWS = {
  '1m':  60_000,
  '5m':  300_000,
  '1h':  3_600_000,
} as const;

/**
 * Record an API response. Call this after sending the response.
 * Lightweight — no async, no I/O.
 */
export function trackResponse(route: string, status: number): void {
  const record: ResponseRecord = {
    timestamp: Date.now(),
    route: normalizeRoute(route),
    status,
  };

  if (totalRecords < MAX_RECORDS) {
    records.push(record);
  } else {
    records[writeIndex % MAX_RECORDS] = record;
  }
  writeIndex++;
  totalRecords = Math.min(totalRecords + 1, MAX_RECORDS);
}

/**
 * Normalize route paths — strip dynamic segments and query params
 * /api/collab/tasks?channelId=xxx → /api/collab/tasks
 * /api/logs/memory-timeline → /api/logs/memory-timeline
 */
function normalizeRoute(route: string): string {
  // Strip query params
  const base = route.split('?')[0];
  // Collapse UUID-like segments
  return base.replace(/\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '/:id');
}

interface WindowStats {
  total: number;
  success: number;    // 2xx/3xx
  clientError: number; // 4xx
  serverError: number; // 5xx
  // 2026-05-18: server fault only. 4xx = client bad-request (e.g. SSE
  // subscriptions with missing participantId), which is normal protocol
  // chatter and shouldn't pollute the server-health metric. The combined
  // rate is still available as `combinedErrorRate` for granular reporting.
  errorRate: number;
  combinedErrorRate: number;
}

interface RouteStats {
  route: string;
  total: number;
  clientError: number;
  serverError: number;
  errorRate: number;          // server fault rate (5xx / total)
  combinedErrorRate: number;  // 4xx + 5xx / total — for compat & route diagnostics
}

export interface ErrorRateData {
  windows: Record<string, WindowStats>;
  topErrorRoutes: RouteStats[];
  recentErrors: Array<{
    timestamp: string;
    route: string;
    status: number;
  }>;
}

/**
 * Get error rate aggregation across all windows.
 */
export function getErrorRates(): ErrorRateData {
  const now = Date.now();

  // Aggregate per window
  const windows: Record<string, WindowStats> = {};
  const routeErrors = new Map<string, { total: number; clientError: number; serverError: number }>();
  const recentErrors: Array<{ timestamp: string; route: string; status: number }> = [];

  for (const [windowName, windowMs] of Object.entries(WINDOWS)) {
    const cutoff = now - windowMs;
    let total = 0, success = 0, clientError = 0, serverError = 0;

    for (let i = 0; i < Math.min(totalRecords, MAX_RECORDS); i++) {
      const r = records[i];
      if (r.timestamp < cutoff) continue;

      total++;
      if (r.status >= 200 && r.status < 400) success++;
      else if (r.status >= 400 && r.status < 500) clientError++;
      else if (r.status >= 500) serverError++;

      // Track per-route errors (only for the 1h window to avoid counting multiple times)
      if (windowName === '1h') {
        const existing = routeErrors.get(r.route) ?? { total: 0, clientError: 0, serverError: 0 };
        existing.total++;
        if (r.status >= 400 && r.status < 500) existing.clientError++;
        else if (r.status >= 500) existing.serverError++;
        routeErrors.set(r.route, existing);

        // Collect recent errors (last 20)
        if ((r.status >= 400) && recentErrors.length < 20) {
          recentErrors.push({
            timestamp: new Date(r.timestamp).toISOString(),
            route: r.route,
            status: r.status,
          });
        }
      }
    }

    windows[windowName] = {
      total,
      success,
      clientError,
      serverError,
      errorRate: total > 0 ? Math.round((serverError / total) * 1000) / 10 : 0,
      combinedErrorRate: total > 0 ? Math.round(((clientError + serverError) / total) * 1000) / 10 : 0,
    };
  }

  // Top error routes sorted by error count
  const topErrorRoutes: RouteStats[] = Array.from(routeErrors.entries())
    .filter(([, stats]) => stats.clientError + stats.serverError > 0)
    .map(([route, stats]) => ({
      route,
      total: stats.total,
      clientError: stats.clientError,
      serverError: stats.serverError,
      errorRate: Math.round((stats.serverError / stats.total) * 1000) / 10,
      combinedErrorRate: Math.round(((stats.clientError + stats.serverError) / stats.total) * 1000) / 10,
    }))
    .sort((a, b) => (b.clientError + b.serverError) - (a.clientError + a.serverError))
    .slice(0, 10);

  // Sort recent errors by timestamp descending
  recentErrors.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { windows, topErrorRoutes, recentErrors };
}
