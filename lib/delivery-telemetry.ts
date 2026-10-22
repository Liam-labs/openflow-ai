import { appPath } from '@/lib/app-paths';
/**
 * Delivery telemetry: types, storage path, and stats computation.
 *
 * The collab-claude.py wrapper writes DeliveryEvent records via
 * POST /api/collab/delivery-status. This module provides the
 * shared types and the computeDeliveryStats() pure function used
 * by the route and by unit tests.
 */

export type DeliveryStatus = 'delivered' | 'timeout' | 'delivery_failure';
export type FailureReason = 'injection_timeout' | 'tmux_send_failed' | 'child_died';

export interface DeliveryEvent {
  messageId: string;
  status: DeliveryStatus;
  timestamp: string;
  participantId?: string;
  agentName?: string;
  channelId?: string;
  elapsedMs?: number;
  /** Server clock when the event arrived (ms precision); `timestamp` is the reporting wrapper's clock, whole seconds. */
  receivedAt?: string;
  verifiedVia?: string;
  verifyElapsedMs?: number;
  // Fields present only on delivery_failure events
  failureReason?: FailureReason | string;
  wrapperPid?: number;
  lastOutputTimeDeltaMs?: number;
  isProcessingAtInject?: boolean;
}

export interface DeliveryStats {
  windowHours: number;
  totalFailures: number;
  failuresByAgent: Record<string, number>;
  failuresByReason: Record<string, number>;
  failuresByChannel: Record<string, number>;
}

// Sprint 51 T1 — verifier false-positives that must NOT contribute to failure
// stats. Jack 2026-04-18 audit: 22/22 jsonl_ingestion_timeout events for him
// actually delivered. These events stay in telemetry storage (so we can audit
// them) but they don't count toward alerts or per-reason rollups.
const NON_FAILURE_REASONS = new Set<string>([
  'jsonl_ingestion_timeout',
  'jsonl_verify_timeout_noreinject',
]);

export function computeDeliveryStats(
  events: DeliveryEvent[],
  opts: { windowHours?: number } = {}
): DeliveryStats {
  const windowHours = opts.windowHours ?? 24;
  const cutoff = Date.now() - windowHours * 3600 * 1000;

  const failures = events.filter(e =>
    e.status === 'delivery_failure' &&
    new Date(e.timestamp).getTime() >= cutoff &&
    !NON_FAILURE_REASONS.has(e.failureReason ?? '')
  );

  const failuresByAgent: Record<string, number> = {};
  const failuresByReason: Record<string, number> = {};
  const failuresByChannel: Record<string, number> = {};

  for (const e of failures) {
    const agent = e.agentName ?? 'unknown';
    const reason = e.failureReason ?? 'unknown';
    const channel = e.channelId ?? 'unknown';
    failuresByAgent[agent] = (failuresByAgent[agent] ?? 0) + 1;
    failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
    failuresByChannel[channel] = (failuresByChannel[channel] ?? 0) + 1;
  }

  return { windowHours, totalFailures: failures.length, failuresByAgent, failuresByReason, failuresByChannel };
}

export function getTelemetryStorePath(): string {
  const appDataDir = process.env.DEVFLOW_APP_DATA_DIR || process.env.DEVFLOW_DATA_DIR || '.AppData';
  const path = require('path');
  return appPath(appDataDir, 'delivery-status.json');
}
