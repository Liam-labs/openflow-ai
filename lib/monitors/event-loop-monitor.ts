/**
 * Event Loop Lag Monitor
 *
 * Detects when the Node.js event loop is blocked by synchronous operations.
 * Schedules a timer at a known interval and measures the actual delay.
 * If the delay exceeds the threshold, it logs a warning with the lag duration.
 *
 * This is an early warning system — it detects the freeze as it happens,
 * rather than after the server becomes unresponsive.
 */

import { logEvent } from '../log-writer';

// 2026-05-18: severity thresholds retuned to match operational impact.
// Previously 100ms triggered 'high', putting routine GC pauses and large I/O
// batches in the alerts panel alongside real freezes. New ladder:
//   100–499ms   → 'low'      noisy but informational
//   500–999ms   → 'medium'   user-visible delay, worth noting
//   1000–4999ms → 'high'     server problem, needs investigation
//   5000ms+     → 'critical' loop frozen, real damage in progress
const CHECK_INTERVAL_MS = 1000;
const WARN_THRESHOLD_MS = 100;
const MEDIUM_THRESHOLD_MS = 500;
const HIGH_THRESHOLD_MS = 1000;
const CRITICAL_THRESHOLD_MS = 5000;
const LOG_COOLDOWN_MS = 10_000;  // Don't spam logs — max one warning per 10s

let lastLogAt = 0;
let monitorTimer: ReturnType<typeof setInterval> | null = null;

function startEventLoopMonitor(): void {
  if (monitorTimer) return; // Already running

  let lastCheck = Date.now();

  monitorTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastCheck;
    const lag = elapsed - CHECK_INTERVAL_MS;
    lastCheck = now;

    if (lag > WARN_THRESHOLD_MS && (now - lastLogAt) > LOG_COOLDOWN_MS) {
      lastLogAt = now;

      const severity: 'critical' | 'high' | 'medium' | 'low' =
        lag > CRITICAL_THRESHOLD_MS ? 'critical' :
        lag > HIGH_THRESHOLD_MS     ? 'high'     :
        lag > MEDIUM_THRESHOLD_MS   ? 'medium'   :
                                      'low';
      const message = `Event loop blocked for ${lag}ms (expected ${CHECK_INTERVAL_MS}ms interval, actual ${elapsed}ms)`;

      console.warn(`[EventLoopMonitor] ${severity.toUpperCase()}: ${message}`);

      // Write to DevFlow unified logging
      try {
        logEvent(
          'service' as const,
          severity,
          `Event loop lag: ${lag}ms`,
          {
            lagMs: lag,
            elapsedMs: elapsed,
            expectedMs: CHECK_INTERVAL_MS,
            threshold:
              severity === 'critical' ? CRITICAL_THRESHOLD_MS :
              severity === 'high'     ? HIGH_THRESHOLD_MS :
              severity === 'medium'   ? MEDIUM_THRESHOLD_MS :
                                        WARN_THRESHOLD_MS,
          },
        );
      } catch {
        // Don't let logging errors crash the monitor
      }
    }
  }, CHECK_INTERVAL_MS);

  // Don't prevent Node.js from exiting
  monitorTimer.unref();

  console.log('[EventLoopMonitor] Started (warn: >100ms, critical: >1000ms)');
}

function stopEventLoopMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

/**
 * Start the monitor and return a cleanup function (matches DevFlow monitor pattern).
 */
export function startEventLoopLagMonitor(): () => void {
  startEventLoopMonitor();
  return stopEventLoopMonitor;
}

export { startEventLoopMonitor, stopEventLoopMonitor };
