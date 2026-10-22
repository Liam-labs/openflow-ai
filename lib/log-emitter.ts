/**
 * API Event Emitter — Event-driven logging for API mutations
 *
 * Replaces request-level middleware logging with targeted emission
 * on state-changing operations only. Read-only calls never emit.
 *
 * Usage in action handlers:
 *   emitApiEvent({
 *     action: 'collab.message',
 *     status: 200,
 *     durationMs: timing,
 *     requestId,
 *     severity: 'info',
 *     actor: participantId,
 *     channelId,
 *     summary: `${senderName} sent message in ${channelName}`,
 *   });
 */

import { writeLogEntry, makeLogEntry } from './log-writer';
import { trackResponse } from './error-rate-tracker';
import type { LogSeverity } from './log-types';

export interface ApiEventLog {
  action: string;            // e.g. "collab.message", "roster.spawn"
  status: number;            // HTTP status code
  durationMs: number;
  requestId?: string;
  severity: LogSeverity;
  actor?: string;            // participantId or agent name
  channelId?: string;        // If action is channel-scoped
  summary: string;           // Human-readable one-liner
  error?: string;            // Error message if non-2xx
  metadata?: Record<string, unknown>;
}

/**
 * Emit an API event to the unified log and SSE stream.
 * Non-blocking — never throws.
 */
export function emitApiEvent(entry: ApiEventLog): void {
  const logEntry = makeLogEntry(
    'api',
    entry.severity,
    entry.summary,
    {
      event: entry.action,
      status: entry.status,
      durationMs: entry.durationMs,
      requestId: entry.requestId,
      actor: entry.actor,
      channelId: entry.channelId,
      error: entry.error,
      ...entry.metadata,
    },
  );
  writeLogEntry(logEntry).catch(() => {});
  // Track response status for error rate monitoring — converts action to route-like path
  trackResponse(`/api/${entry.action.split('.')[0]}`, entry.status);
}
