/**
 * Sprint 'Realtime Context Bar' T1 — pure merge helpers.
 *
 * The agent context-usage bar was stale because it only read the roster's
 * lastContextHealth, refreshed via the heavyweight 30s channel fullRefresh.
 * The UI now polls the purpose-built GET /api/agent/context-health endpoint on
 * a short cadence and merges the fresh per-agent value over the roster value.
 * These helpers are pure (no React, no I/O) so they're unit-testable.
 */

export interface ContextHealth {
  percent: number;
  turnCount: number;
  model: string;
  reportedAt: string;
  /** Context tokens and the window they were measured against, when the reporter knows them (the transcript sampler does). */
  tokens?: number;
  window?: number;
  source?: string;
}

/**
 * How old a reading may be and still be shown. The transcript sampler re-posts every reading at least every four minutes
 * (scripts/context_sampler.py HEARTBEAT_S), so a reading older than this means the sampler is not reporting for that agent
 * (agent stopped, session replaced, sampler down). A bar showing an old number as if it were current is worse than no bar:
 * until 18 Oct 2026 the bars showed values saved months earlier, by sessions on other models.
 */
export const CONTEXT_HEALTH_MAX_AGE_MS = 15 * 60 * 1000;

export function isFreshContextHealth(
  health: { reportedAt?: string } | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = CONTEXT_HEALTH_MAX_AGE_MS,
): boolean {
  if (!health?.reportedAt) return false;
  const reported = Date.parse(health.reportedAt);
  if (Number.isNaN(reported)) return false;
  return now - reported <= maxAgeMs;
}

/** Build an agentId → lastContextHealth map from the endpoint's agents array. */
export function buildContextHealthMap(
  agents:
    | Array<{ agentId?: string; lastContextHealth?: ContextHealth | null }>
    | undefined,
): Record<string, ContextHealth> {
  const map: Record<string, ContextHealth> = {};
  if (!Array.isArray(agents)) return map;
  for (const a of agents) {
    if (a && typeof a.agentId === 'string' && a.agentId && a.lastContextHealth) {
      map[a.agentId] = a.lastContextHealth;
    }
  }
  return map;
}

/**
 * Pick the value to render for the bar: the fresher of the polled (live) value
 * and the roster value. Falls back to whichever is present, and tolerates
 * unparseable timestamps (NaN) without throwing. A reading too old to be
 * trusted (see CONTEXT_HEALTH_MAX_AGE_MS) is not returned at all, so the bar
 * disappears instead of showing a stale number.
 */
export function selectLiveHealth(
  live: ContextHealth | null | undefined,
  roster: ContextHealth | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = CONTEXT_HEALTH_MAX_AGE_MS,
): ContextHealth | undefined {
  const chosen = newerOf(live, roster);
  return chosen && isFreshContextHealth(chosen, now, maxAgeMs) ? chosen : undefined;
}

function newerOf(
  live: ContextHealth | null | undefined,
  roster: ContextHealth | null | undefined,
): ContextHealth | undefined {
  if (!live) return roster ?? undefined;
  if (!roster) return live;
  const lt = Date.parse(live.reportedAt);
  const rt = Date.parse(roster.reportedAt);
  if (Number.isNaN(lt)) return roster;
  if (Number.isNaN(rt)) return live;
  return lt >= rt ? live : roster;
}
