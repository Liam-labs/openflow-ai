/**
 * T2: Uptime crash counter — distinguish crash vs graceful exit.
 *
 * RED:  computeAgentUptime counts both 'crash' and 'exit' as crashes.
 * GREEN: Only 'crash' events increment crashCount; 'exit' events start
 *        downtime tracking but do NOT inflate the crash counter.
 */

import { describe, it, expect } from 'vitest';
import { computeAgentUptime } from '@/lib/uptime-helpers';

const NOW = 1700000000000;
const HOUR = 3600000;

function ev(event: string, offsetMs: number) {
  return { event, timestamp: NOW + offsetMs };
}

describe('computeAgentUptime — crash vs exit distinction', () => {
  it('counts crash events as crashes but not graceful exits', () => {
    const events = [
      ev('spawn', 0),
      ev('exit', HOUR),           // graceful exit — should NOT increment crashCount
      ev('spawn', HOUR + 1000),   // re-spawn
      ev('crash', 2 * HOUR),      // real crash — SHOULD increment
      ev('spawn', 2 * HOUR + 1000),
    ];

    const result = computeAgentUptime(events, NOW, NOW + 3 * HOUR);

    expect(result.crashCount).toBe(1);
    // downtime: exit→spawn (1s) + crash→spawn (1s) = 2s
    expect(result.downtimeMs).toBe(2000);
  });

  it('treats consecutive exits as zero crashes', () => {
    const events = [
      ev('spawn', 0),
      ev('exit', HOUR),           // graceful
      ev('spawn', HOUR + 5000),
      ev('exit', 2 * HOUR),       // graceful again
      ev('spawn', 2 * HOUR + 5000),
      ev('exit', 3 * HOUR),       // graceful third time
    ];

    const result = computeAgentUptime(events, NOW, NOW + 3 * HOUR);

    expect(result.crashCount).toBe(0);
  });

  it('treats all-crash sequence correctly', () => {
    const events = [
      ev('crash', HOUR),
      ev('spawn', HOUR + 1000),
      ev('crash', 2 * HOUR),
      ev('spawn', 2 * HOUR + 1000),
      ev('crash', 3 * HOUR),
      ev('spawn', 3 * HOUR + 1000),
    ];

    const result = computeAgentUptime(events, NOW, NOW + 4 * HOUR);

    expect(result.crashCount).toBe(3);
  });

  it('reports status down when exit ends the window without respawn', () => {
    const events = [
      ev('spawn', 0),
      ev('exit', HOUR),
      // no respawn — still down at window end
    ];

    const result = computeAgentUptime(events, NOW, NOW + 3 * HOUR);

    expect(result.crashCount).toBe(0);
    expect(result.status).toBe('down');
  });

  it('reports unknown for zero events (regression guard)', () => {
    const result = computeAgentUptime([], NOW, NOW + HOUR);
    expect(result.crashCount).toBe(0);
    expect(result.status).toBe('unknown');
    expect(result.lastSeen).toBeNull();
  });
});
