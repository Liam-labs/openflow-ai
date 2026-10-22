/**
 * Uptime computation helpers shared between /api/logs/uptime and /api/stability-digest.
 */

interface AgentEvent {
  event: string;
  timestamp: number;
}

/**
 * Compute uptime for a single agent given sorted lifecycle events within the window.
 *
 * Algorithm:
 * - Walk events in chronological order.
 * - When a crash/exit is seen, record downtime start.
 * - When the next spawn is seen, record downtime end.
 * - If still down at window end, downtime extends to `to`.
 * - Only 'crash' events increment crashCount — graceful 'exit' events do not.
 */
export function computeAgentUptime(
  events: AgentEvent[],
  windowStart: number,
  windowEnd: number
): { downtimeMs: number; crashCount: number; lastSeen: number | null; status: 'up' | 'down' | 'unknown' } {
  let downtimeMs = 0;
  let crashCount = 0;
  let downSince: number | null = null;
  let lastSeen: number | null = null;

  for (const ev of events) {
    const ts = ev.timestamp;
    if (lastSeen === null || ts > lastSeen) lastSeen = ts;

    if (ev.event === 'crash') {
      crashCount++;
    }
    if (ev.event === 'crash' || ev.event === 'exit') {
      if (downSince === null) {
        downSince = ts;
      }
    } else if (ev.event === 'spawn' || ev.event === 'respawn' || ev.event === 'ready') {
      if (downSince !== null) {
        downtimeMs += ts - downSince;
        downSince = null;
      }
    }
  }

  // If still down at end of window, count remaining time as downtime
  if (downSince !== null) {
    downtimeMs += windowEnd - downSince;
  }

  const status: 'up' | 'down' | 'unknown' =
    events.length === 0 ? 'unknown' :
    downSince !== null ? 'down' : 'up';

  return { downtimeMs, crashCount, lastSeen, status };
}
