/**
 * Scaffolding snooze store — controls which agents are excluded from the
 * daily drift alarm. Three behaviours coexist:
 *
 *   1. Default snooze on fire — when /api/scaffolding/drift-alarm posts
 *      about an agent, it auto-snoozes that agent for DEFAULT_FIRE_SNOOZE_MS
 *      (4h). Prevents the same drift firing 24× in a single the owner-AFK day.
 *
 *   2. Per-agent override — `POST /api/scaffolding/snooze` with
 *      `{agentId, until, reason}`. Mirrors the sprint.reminderSnooze pattern.
 *      `until: null` clears the snooze (same as DELETE).
 *
 *   3. Fleet-wide snooze — `agentId: '__fleet__'` (or `agentId` omitted on
 *      the API) snoozes ALL alerts. Cron registration auto-sets this for
 *      6h so the owner has a buffer to deploy the P3.2 import fix without 89
 *      alarms landing in his lap.
 *
 * Storage: `~/DevFlow/.AppData/scaffolding-snoozes.json`
 *   {
 *     snoozes: {
 *       "Reynolds": { until: "ISO", reason: "...", setBy: "Reynolds", setAt: "ISO" },
 *       "__fleet__": { ... }
 *     },
 *     lastUpdated: "ISO"
 *   }
 *
 * Concurrency: all writes go through withFileLock so concurrent API + cron
 * invocations stay consistent.
 */

import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';

const SNOOZE_PATH = path.join(DataPaths.appData, 'scaffolding-snoozes.json');

/** Special key for fleet-wide snoozes. */
export const FLEET_SNOOZE_KEY = '__fleet__';

/** Default duration of the auto-snooze applied when the cron alerts on an
 *  agent (4 hours). Override via env if needed. */
export const DEFAULT_FIRE_SNOOZE_MS =
  parseInt(process.env.SCAFFOLDING_FIRE_SNOOZE_MS ?? `${4 * 60 * 60 * 1000}`, 10);

/** Auto-applied fleet snooze when the cron is first registered (6 hours). */
export const REGISTRATION_FLEET_SNOOZE_MS =
  parseInt(process.env.SCAFFOLDING_REGISTRATION_SNOOZE_MS ?? `${6 * 60 * 60 * 1000}`, 10);

export interface SnoozeEntry {
  /** Agent name OR FLEET_SNOOZE_KEY. */
  key: string;
  /** ISO timestamp until which the snooze is active. */
  until: string;
  /** Free-text reason — appears in the X-Ray UI tooltip. */
  reason: string;
  /** Who/what set it (caller-provided label). */
  setBy: string;
  /** ISO timestamp when this snooze was set. */
  setAt: string;
}

interface SnoozeStore {
  snoozes: Record<string, SnoozeEntry>;
  lastUpdated: string;
}

function emptyStore(): SnoozeStore {
  return { snoozes: {}, lastUpdated: new Date().toISOString() };
}

export async function loadSnoozes(): Promise<SnoozeStore> {
  return readJsonFile<SnoozeStore>(SNOOZE_PATH, emptyStore());
}

/** Returns the active snooze for an agent (or fleet) — null if absent or expired. */
export async function activeSnoozeFor(key: string): Promise<SnoozeEntry | null> {
  const store = await loadSnoozes();
  const entry = store.snoozes[key];
  if (!entry) return null;
  const until = Date.parse(entry.until);
  if (!Number.isFinite(until) || Date.now() >= until) return null;
  return entry;
}

/** Returns true iff drift alerts should be suppressed for this agent right
 *  now — either by an active per-agent snooze or an active fleet-wide snooze.
 *  Snoozes with `until` in the past are treated as expired and ignored.
 */
export async function isSnoozedNow(agentName: string): Promise<{ snoozed: boolean; reason?: string; until?: string; scope?: 'agent' | 'fleet' }> {
  // Fleet-wide takes precedence — when set, everything is quiet
  const fleet = await activeSnoozeFor(FLEET_SNOOZE_KEY);
  if (fleet) {
    return { snoozed: true, reason: fleet.reason, until: fleet.until, scope: 'fleet' };
  }
  const ag = await activeSnoozeFor(agentName);
  if (ag) {
    return { snoozed: true, reason: ag.reason, until: ag.until, scope: 'agent' };
  }
  return { snoozed: false };
}

/** Set a snooze for one agent (or fleet). Returns the entry written. */
export async function setSnooze(
  key: string,
  until: string,
  reason: string,
  setBy: string,
): Promise<SnoozeEntry> {
  const cleanKey = key.trim() || FLEET_SNOOZE_KEY;
  const entry: SnoozeEntry = {
    key: cleanKey,
    until,
    reason: reason.trim() || '(no reason given)',
    setBy: setBy.trim() || 'unknown',
    setAt: new Date().toISOString(),
  };
  await withFileLock(SNOOZE_PATH, async () => {
    const store = await loadSnoozes();
    store.snoozes[cleanKey] = entry;
    store.lastUpdated = new Date().toISOString();
    await writeJsonFile(SNOOZE_PATH, store);
  });
  return entry;
}

/** Remove a snooze. Returns true if one was present, false otherwise. */
export async function clearSnooze(key: string): Promise<boolean> {
  const cleanKey = key.trim() || FLEET_SNOOZE_KEY;
  let existed = false;
  await withFileLock(SNOOZE_PATH, async () => {
    const store = await loadSnoozes();
    if (store.snoozes[cleanKey]) {
      delete store.snoozes[cleanKey];
      store.lastUpdated = new Date().toISOString();
      await writeJsonFile(SNOOZE_PATH, store);
      existed = true;
    }
  });
  return existed;
}

/** List all currently-active (non-expired) snoozes. */
export async function listActiveSnoozes(): Promise<SnoozeEntry[]> {
  const store = await loadSnoozes();
  const out: SnoozeEntry[] = [];
  const now = Date.now();
  for (const e of Object.values(store.snoozes)) {
    const u = Date.parse(e.until);
    if (Number.isFinite(u) && u > now) out.push(e);
  }
  out.sort((a, b) => a.until.localeCompare(b.until));
  return out;
}

/** Compute the ISO timestamp `ms` milliseconds in the future. */
export function isoFromNow(ms: number): string {
  return new Date(Date.now() + Math.max(0, ms)).toISOString();
}

/** Apply the default per-agent post-fire snooze (4h). Idempotent — overrides
 *  any existing snooze for that agent. */
export async function applyFireSnooze(
  agentName: string,
  reason: string = 'auto-cooldown after drift alarm fire',
): Promise<SnoozeEntry> {
  return setSnooze(
    agentName,
    isoFromNow(DEFAULT_FIRE_SNOOZE_MS),
    reason,
    'DriftAlarm (auto)',
  );
}
