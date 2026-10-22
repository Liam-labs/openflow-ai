/**
 * Scaffolding manifest helpers — composes the X-Ray data shape for
 * /api/scaffolding/manifest + /api/scaffolding/health.
 *
 * Sources:
 *   - Agent identity: roster entries aggregated from .AppData/collab-channels.json
 *     (lightweight participant records) + per-channel roster.list responses
 *     when richer fields are needed.
 *   - Scaffolding identity: data/scaffolding/.AppData/scaffolding/agents.json
 *     (the same file sync.py reads — guarantees the verifier sees the same
 *     agent record we describe).
 *   - File status: shells out to `python3 data/scaffolding/sync.py
 *     --verify-only --json --agent <name>`. The verifier's per-file row
 *     schema matches the X-Ray spec exactly.
 *   - Hook config: target agent's <workingDirectory>/.claude/settings.json.
 *   - Hook fire history: .AppData/hook-events.jsonl (written by the P3.4
 *     telemetry helpers). Filtered to lines where `agent === agentName`.
 *   - Sync log: not yet captured centrally. v1 returns [] with a structured
 *     note. Future: wrap sync.py with a logging shim.
 *
 * Status semantics (docs/spec-scaffolding-xray.md):
 *   synced / drift / missing / unsupported / stale-hook
 *   Plus the verifier-internal values that pass through:
 *   skipped / master-missing / master-unreadable / target-unresolvable.
 *
 * Stale-hook threshold: a configured hook that hasn't fired in
 * STALE_HOOK_DAYS days despite session activity. Default 7d.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { getDevflowHome } from '@/lib/home-dir';

const execFileP = promisify(execFile);

// ============================================================================
// Config
// ============================================================================

const SYNC_PY = path.join(
  getDevflowHome(),
  'data',
  'scaffolding',
  'sync.py',
);
const HOOK_EVENTS = path.join(DataPaths.appData, 'hook-events.jsonl');
const SYNC_EVENTS = path.join(DataPaths.appData, 'scaffolding-sync-events.jsonl');
const STALE_HOOK_DAYS = parseInt(process.env.STALE_HOOK_DAYS ?? '7', 10);
const VERIFY_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

export type FileStatus =
  | 'synced'
  | 'drift'
  | 'missing'
  | 'skipped'
  | 'agent-owned'      // seed-only entry that's diverged — expected, not drift
  | 'unsupported'
  | 'master-missing'
  | 'master-unreadable'
  | 'target-unresolvable';

export interface FileRow {
  entryId?: string;
  source?: string;
  masterPath?: string;
  target?: string;
  path?: string;
  status: FileStatus;
  drift: boolean;
  localSha256?: string | null;
  masterSha256?: string | null;
  mtime?: string | null;
  reason?: string;
}

export interface HookRow {
  name: string;
  event: string;
  configured: boolean;
  lastFiredAt: string | null;
  firedLast24h: number;
  neverFired?: boolean;
  staleHook?: boolean;
  command?: string;
}

export interface SyncLogRow {
  timestamp: string;
  command: string;
  exitCode: number;
  filesAffected?: number;
}

export interface ManifestSummary {
  filesTotal: number;
  filesSynced: number;
  filesDrift: number;
  filesMissing: number;
  /** Seed-only entries (overwrite:false) that have diverged on disk.
   *  Expected — the agent owns these (Expertise.md, handoff.md, .mcp.json).
   *  Does NOT count toward drift alarms. */
  filesAgentOwned: number;
  hooksActive: number;
  hooksStale: number;
  lastSyncAt: string | null;
}

export interface AgentIdentity {
  id: string;
  name: string;
  model?: string;
  roleId?: string;
  workingDirectory: string;
  channelId?: string;
  status?: string;
  type?: string;
}

export interface AgentManifest {
  agent: AgentIdentity;
  files: FileRow[];
  hooks: HookRow[];
  syncLog: SyncLogRow[];
  syncLogNote?: string;
  summary: ManifestSummary;
  verifiedAt: string;
}

// ============================================================================
// Agent identity lookup
// ============================================================================

interface ChannelsFile {
  channels?: Array<{
    id?: string;
    name?: string;
    /** Lightweight participant records (no model/roleId/workingDirectory). */
    participants?: Array<Record<string, unknown>>;
    /** Rich roster records — what roster.list returns. Source of UUIDs. */
    roster?: {
      agents?: Array<Record<string, unknown>>;
    };
  }>;
}

interface RosterEntry {
  /** Full UUID — the canonical agentId callers should pass. */
  id?: string;
  /** Short collab-channel handle, e.g. 'roster-c751bee3'. */
  participantId?: string;
  name?: string;
  model?: string;
  roleId?: string;
  workingDirectory?: string;
  effectiveWorkingDirectory?: string;
  channelId?: string;
  status?: string;
  /** Runtime classification (claude/codex/antigravity/grok/gemini/...).
   *  Populated by roster-ops.ts on provision. Used by the X-Ray UI + the
   *  Models tab to colour-code adapter family. Sprint Q2 T4 surfaces this
   *  on AgentIdentity.type instead of the hardcoded 'roster' placeholder. */
  agentType?: string;
}

/** Pull all unique roster agents across every channel — single file read.
 *
 * Reads `channel.roster.agents[]` (the rich roster — same source roster.list
 * returns). Falls back to `channel.participants[]` for any agent that only
 * appears in the lightweight participant list (e.g. browser users).
 */
export async function loadAllRoster(): Promise<AgentIdentity[]> {
  const data = await readJsonFile<ChannelsFile>(DataPaths.collabChannels, { channels: [] });
  // Keyed by id-OR-participantId — that lets us correlate the lightweight
  // participant entry with its rich roster counterpart (same participantId).
  const seen = new Map<string, AgentIdentity>();

  // Pass 1: rich roster.agents — these have the UUIDs we need
  for (const channel of data.channels ?? []) {
    for (const a of channel.roster?.agents ?? []) {
      const r = a as RosterEntry;
      const id = r.id;
      if (!id) continue;
      const candidate: AgentIdentity = {
        id,
        name: r.name ?? 'unknown',
        model: r.model,
        roleId: r.roleId,
        workingDirectory:
          r.effectiveWorkingDirectory ?? r.workingDirectory ?? '',
        channelId: r.channelId ?? channel.id,
        status: r.status,
        // Sprint Q2 T4 (Reynolds, 2026-05-27) — expose real agentType
        // instead of hardcoded 'roster'. Pre-fix every non-Claude agent
        // looked identical to the X-Ray + Models tab (per QA log med).
        // Legacy roster entries without the field fall back to 'roster'.
        type: r.agentType ?? 'roster',
      };
      // Index by both id and participantId so lookups by either form hit.
      const existing = seen.get(id);
      if (!existing || scoreIdentity(candidate) > scoreIdentity(existing)) {
        seen.set(id, candidate);
        if (r.participantId) seen.set(r.participantId, candidate);
      }
    }
  }

  // Pass 2: lightweight participants — only add agents not already seen.
  // These are usually browser users + system, but we keep them so the
  // X-Ray can show "this id exists but has no roster row".
  for (const channel of data.channels ?? []) {
    for (const p of channel.participants ?? []) {
      const id = (p.id ?? p.participantId) as string | undefined;
      if (!id || seen.has(id)) continue;
      seen.set(id, {
        id,
        name: (p.name as string) ?? 'unknown',
        workingDirectory: (p.projectPath as string) ?? '',
        channelId: channel.id,
        status: (p.status as string),
        type: (p.type as string) ?? 'participant',
      });
    }
  }

  // De-duplicate (we double-indexed roster agents by id + participantId).
  const unique = new Map<string, AgentIdentity>();
  for (const v of seen.values()) unique.set(v.id, v);
  return [...unique.values()];
}

function scoreIdentity(a: AgentIdentity): number {
  let s = 0;
  if (a.workingDirectory) s += 4;
  if (a.model) s += 2;
  if (a.roleId) s += 1;
  if (a.channelId) s += 1;
  // Sprint Q2 T4 (Reynolds, 2026-05-27) — favour roster entries that
  // declare a real agentType ('claude'/'codex'/etc) over ties whose
  // agentType is missing. Pre-fix Carter ranked by first-iterated entry
  // (her Life/Work channel, agentType=None) instead of her Commander
  // entry (agentType=antigravity), so the manifest API surfaced 'roster'
  // even though we knew her real runtime in another channel.
  if (a.type && a.type !== 'roster' && a.type !== 'participant') s += 1;
  return s;
}

/** Find an agent by id (UUID, short prefix, `roster-` participantId form, or exact name). */
export async function resolveAgent(
  query: string,
): Promise<AgentIdentity | null> {
  if (!query) return null;
  const roster = await loadAllRoster();

  // 1. Exact UUID match
  const byId = roster.find((a) => a.id === query);
  if (byId) return byId;

  // 2. Match by `roster-<short>` participantId form — strip prefix + compare
  //    against the leading segment of each UUID. The participant_id in
  //    collab-channels has form `roster-<first8>` for UUID-typed agents.
  if (query.startsWith('roster-')) {
    const stem = query.slice('roster-'.length);
    const byStem = roster.filter((a) => a.id.startsWith(stem));
    if (byStem.length === 1) return byStem[0];
    if (byStem.length > 1) return null; // ambiguous
  }

  // 3. UUID prefix match
  const byPrefix = roster.filter((a) => a.id.startsWith(query));
  if (byPrefix.length === 1) return byPrefix[0];

  // 4. Case-insensitive exact name match
  const byName = roster.filter(
    (a) => a.name.toLowerCase() === query.toLowerCase(),
  );
  if (byName.length === 1) return byName[0];

  // Ambiguous → null; caller surfaces 409
  if (byPrefix.length > 1 || byName.length > 1) return null;

  return null;
}

// ============================================================================
// Verifier subprocess
// ============================================================================

interface VerifyJson {
  verifiedAt: string;
  agents: Array<{
    agent: string;
    agentDir?: string;
    teamDir?: string;
    models?: string[];
    summary: {
      total: number;
      synced: number;
      drift: number;
      missing: number;
      skipped: number;
      errors: number;
    };
    files: FileRow[];
  }>;
  totalDriftOrMissing: number;
}

export async function runVerifierFor(agentName: string): Promise<VerifyJson> {
  return runVerifier(['--agent', agentName]);
}

/** Run the verifier for the entire fleet — one subprocess, all 90+ agents.
 * Returns the same VerifyJson shape but with multiple `agents[]` entries. */
export async function runVerifierAll(): Promise<VerifyJson> {
  return runVerifier([]);
}

async function runVerifier(extraArgs: string[]): Promise<VerifyJson> {
  // sync.py exits non-zero when there's drift, but stdout still carries the
  // JSON payload. We accept any exit code and parse stdout. Fleet payloads
  // can hit a few MB; bump maxBuffer well above the observed ~2 MB ceiling.
  try {
    const { stdout } = await execFileP(
      'python3',
      [SYNC_PY, '--verify-only', '--json', ...extraArgs],
      { timeout: VERIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as VerifyJson;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    if (e?.stdout) {
      try {
        return JSON.parse(e.stdout) as VerifyJson;
      } catch {
        /* fall through to throw */
      }
    }
    throw new Error(`sync.py --verify-only failed: ${e.message ?? String(err)}`);
  }
}

// ============================================================================
// Hook config + fire history
// ============================================================================

interface SettingsHookEntry {
  type?: string;
  command?: string;
  prompt?: string;
}

interface SettingsHooksFile {
  hooks?: Record<
    string,
    Array<{
      hooks?: SettingsHookEntry[];
    }>
  >;
}

/** Parse the configured hooks for an agent — returns one row per script. */
export async function loadConfiguredHooks(
  workingDir: string,
): Promise<Array<{ name: string; event: string; command: string }>> {
  const settingsPath = path.join(workingDir, '.claude', 'settings.json');
  let settings: SettingsHooksFile;
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    settings = JSON.parse(raw) as SettingsHooksFile;
  } catch {
    return [];
  }

  const rows: Array<{ name: string; event: string; command: string }> = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const h of entry.hooks ?? []) {
        if (h.type !== 'command' || !h.command) continue;
        const script = extractScript(h.command);
        if (!script) continue;
        rows.push({ name: script, event, command: h.command });
      }
    }
  }
  return rows;
}

function extractScript(command: string): string | null {
  // Pull the first token ending in .py or .sh (allowing arbitrary path prefix).
  const m = command.match(/(\S+\.(?:py|sh))/);
  if (!m) return null;
  const full = m[1];
  return full.split('/').pop() ?? full;
}

interface HookEvent {
  ts?: string;
  agent?: string;
  hook?: string;
  event?: string;
  exit?: number;
  ms?: number;
}

/** Stream the hook-events.jsonl and aggregate fire stats per hook for one agent. */
export async function loadHookFireStats(
  agentName: string,
): Promise<Map<string, { lastFiredAt: string; firedLast24h: number; totalFires: number }>> {
  const stats = new Map<
    string,
    { lastFiredAt: string; firedLast24h: number; totalFires: number }
  >();

  let raw: string;
  try {
    raw = await fs.readFile(HOOK_EVENTS, 'utf8');
  } catch {
    return stats;
  }

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: HookEvent;
    try {
      evt = JSON.parse(line) as HookEvent;
    } catch {
      continue;
    }
    if (evt.agent !== agentName || !evt.hook || !evt.ts) continue;

    const ts = Date.parse(evt.ts);
    if (!Number.isFinite(ts)) continue;

    // Match by hook name (basename) — settings.json command resolved to
    // the same basename above, so they line up.
    const key = matchHookKey(evt.hook);
    const existing = stats.get(key);
    if (!existing) {
      stats.set(key, {
        lastFiredAt: evt.ts,
        firedLast24h: ts >= cutoff24h ? 1 : 0,
        totalFires: 1,
      });
    } else {
      if (evt.ts > existing.lastFiredAt) existing.lastFiredAt = evt.ts;
      if (ts >= cutoff24h) existing.firedLast24h += 1;
      existing.totalFires += 1;
    }
  }

  return stats;
}

/** Normalise a hook name from the telemetry (no ext) to settings.json basename (with ext). */
function matchHookKey(rawName: string): string {
  // Telemetry writes either bare names ('context-inject') or basenames
  // ('flush-journal.sh'). Try both forms when joining with settings hooks.
  return rawName;
}

/** Compose the public HookRow list by joining configured hooks with fire stats. */
export function joinHooks(
  configured: Array<{ name: string; event: string; command: string }>,
  fireStats: Map<string, { lastFiredAt: string; firedLast24h: number; totalFires: number }>,
): HookRow[] {
  const result: HookRow[] = [];
  for (const c of configured) {
    // Try direct basename match first, then strip extension as fallback
    const stem = c.name.replace(/\.(py|sh)$/, '');
    const stats =
      fireStats.get(c.name) ??
      fireStats.get(stem) ??
      null;

    const row: HookRow = {
      name: c.name,
      event: c.event,
      configured: true,
      lastFiredAt: stats?.lastFiredAt ?? null,
      firedLast24h: stats?.firedLast24h ?? 0,
      command: c.command,
    };
    if (!stats) {
      row.neverFired = true;
    } else {
      const lastMs = Date.parse(stats.lastFiredAt);
      if (
        Number.isFinite(lastMs) &&
        Date.now() - lastMs > STALE_HOOK_DAYS * 24 * 60 * 60 * 1000
      ) {
        row.staleHook = true;
      }
    }
    result.push(row);
  }

  // Also surface hooks that have fired but aren't currently in settings.json
  // (orphaned telemetry — useful for catching mis-configured agents)
  const knownNames = new Set(configured.map((c) => c.name));
  const knownStems = new Set(configured.map((c) => c.name.replace(/\.(py|sh)$/, '')));
  for (const [name, stats] of fireStats.entries()) {
    if (knownNames.has(name)) continue;
    if (knownStems.has(name)) continue;
    result.push({
      name,
      event: '?',
      configured: false,
      lastFiredAt: stats.lastFiredAt,
      firedLast24h: stats.firedLast24h,
      command: '(not in settings.json — fired but not configured here)',
    });
  }
  return result;
}

/** Fleet-wide variant: stream hook-events.jsonl ONCE and group by agent.
 *  Used by /api/scaffolding/health so we don't re-read the file N times.  */
export async function loadFleetHookFireStats(): Promise<
  Map<string, Map<string, { lastFiredAt: string; firedLast24h: number; totalFires: number }>>
> {
  const byAgent = new Map<
    string,
    Map<string, { lastFiredAt: string; firedLast24h: number; totalFires: number }>
  >();

  let raw: string;
  try {
    raw = await fs.readFile(HOOK_EVENTS, 'utf8');
  } catch {
    return byAgent;
  }

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: HookEvent;
    try {
      evt = JSON.parse(line) as HookEvent;
    } catch {
      continue;
    }
    if (!evt.agent || !evt.hook || !evt.ts) continue;
    const ts = Date.parse(evt.ts);
    if (!Number.isFinite(ts)) continue;

    let perAgent = byAgent.get(evt.agent);
    if (!perAgent) {
      perAgent = new Map();
      byAgent.set(evt.agent, perAgent);
    }
    const existing = perAgent.get(evt.hook);
    if (!existing) {
      perAgent.set(evt.hook, {
        lastFiredAt: evt.ts,
        firedLast24h: ts >= cutoff24h ? 1 : 0,
        totalFires: 1,
      });
    } else {
      if (evt.ts > existing.lastFiredAt) existing.lastFiredAt = evt.ts;
      if (ts >= cutoff24h) existing.firedLast24h += 1;
      existing.totalFires += 1;
    }
  }

  return byAgent;
}

// ============================================================================
// Sync log tail — populated by `_record_sync_event()` in sync.py
// ============================================================================

interface RawSyncEvent {
  ts?: string;
  mode?: string;
  agent_filter?: string | null;
  file_filter?: string | null;
  files_affected?: number;
  exit_code?: number;
  duration_ms?: number;
  command?: string;
}

/** Tail-read the central sync-events log + filter to events that touched
 *  the named agent. An event applies to the agent when:
 *    - agent_filter matches the name (case-insensitive), OR
 *    - agent_filter is null (fleet-wide invocation)
 *  Returns up to `limit` most-recent events, newest first.
 *
 *  Diagnostic-only modes (adapters, manifest) are excluded — they don't
 *  represent an actual sync action. Keeps the UI tail focused on signal.
 */
export async function loadSyncLogTail(
  agentName: string,
  limit: number = 10,
): Promise<SyncLogRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(SYNC_EVENTS, 'utf8');
  } catch {
    return [];
  }

  const events: SyncLogRow[] = [];
  const wanted = agentName.toLowerCase();
  const skipModes = new Set(['adapters', 'manifest']);

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: RawSyncEvent;
    try {
      evt = JSON.parse(line) as RawSyncEvent;
    } catch {
      continue;
    }
    if (!evt.ts) continue;
    if (evt.mode && skipModes.has(evt.mode)) continue;
    // Filter by agent: include fleet-wide (null filter) OR explicit match
    const af = evt.agent_filter;
    if (af && af.toLowerCase() !== wanted) continue;
    events.push({
      timestamp: evt.ts,
      command: evt.command ?? '?',
      exitCode: evt.exit_code ?? 0,
      filesAffected: evt.files_affected ?? undefined,
    });
  }

  // Newest first, capped
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events.slice(0, limit);
}

export const SYNC_LOG_NOTE =
  'No sync events recorded for this agent yet. Run `python3 data/scaffolding/sync.py --verify-only --agent <name>` ' +
  'to populate. Events stream to ~/DevFlow/.AppData/scaffolding-sync-events.jsonl.';

// ============================================================================
// Compose the public manifest
// ============================================================================

/** One fleet entry — matches docs/spec-scaffolding-xray.md `agents[]` row. */
export interface FleetAgentSummary {
  id: string;
  name: string;
  model?: string;
  roleId?: string;
  workingDirectory: string;
  channelId?: string;
  status?: string;
  /** ManifestSummary subset — same shape as composeAgentManifest().summary */
  summary: ManifestSummary;
  /** True if the verifier knew about this agent (matched a scaffolding entry) */
  scaffolded: boolean;
}

export interface FleetHealth {
  agentsTotal: number;
  agentsHealthy: number;
  agentsDrift: number;
  agentsMissing: number;
  agentsUnscaffolded: number;
  agents: FleetAgentSummary[];
  /** Most-recent mtime across every synced file in the fleet — proxy for
   *  "when did the most recent sync last touch anything". */
  lastFleetSyncAt: string | null;
  verifiedAt: string;
}

/** Compose the fleet-wide health view in one shot.
 *  One sync.py subprocess + one hook-events.jsonl read + N small settings.json
 *  reads. Much cheaper than calling composeAgentManifest() per agent.
 */
export async function composeFleetHealth(): Promise<FleetHealth> {
  const [verify, fleetFireStats, roster] = await Promise.all([
    runVerifierAll(),
    loadFleetHookFireStats(),
    loadAllRoster(),
  ]);

  // Index roster by name (case-insensitive) — agents.json keys on name, not UUID
  const rosterByName = new Map<string, AgentIdentity>();
  for (const r of roster) {
    if (!r.name) continue;
    const key = r.name.toLowerCase();
    const existing = rosterByName.get(key);
    if (!existing || scoreIdentity(r) > scoreIdentity(existing)) {
      rosterByName.set(key, r);
    }
  }

  const agents: FleetAgentSummary[] = [];
  let fleetLastSync: string | null = null;

  for (const a of verify.agents) {
    const identity = rosterByName.get(a.agent.toLowerCase());
    const fireStats = fleetFireStats.get(a.agent) ?? new Map();

    // Hooks summary requires reading settings.json for the agent's workingDir.
    // If no roster identity (scaffolding-only agent with no live presence),
    // skip the hooks part — show 0 active / 0 stale rather than guessing.
    let hooksActive = 0;
    let hooksStale = 0;
    if (identity?.workingDirectory) {
      try {
        const configured = await loadConfiguredHooks(identity.workingDirectory);
        const hooks = joinHooks(configured, fireStats);
        hooksActive = hooks.filter(
          (h) => h.configured && !h.neverFired && !h.staleHook,
        ).length;
        hooksStale = hooks.filter(
          (h) => h.configured && (h.neverFired || h.staleHook),
        ).length;
      } catch {
        // best-effort — leave at 0
      }
    }

    const files = a.files ?? [];
    const lastSyncAt = files.reduce<string | null>((latest, f) => {
      if (!f.mtime) return latest;
      if (!latest) return f.mtime;
      return f.mtime > latest ? f.mtime : latest;
    }, null);

    if (lastSyncAt && (!fleetLastSync || lastSyncAt > fleetLastSync)) {
      fleetLastSync = lastSyncAt;
    }

    const summary: ManifestSummary = {
      filesTotal: files.length,
      filesSynced: files.filter((f) => f.status === 'synced').length,
      filesDrift: files.filter((f) => f.status === 'drift').length,
      filesMissing: files.filter((f) => f.status === 'missing').length,
      filesAgentOwned: files.filter((f) => f.status === 'agent-owned').length,
      hooksActive,
      hooksStale,
      lastSyncAt,
    };

    agents.push({
      id: identity?.id ?? `scaffolding:${a.agent}`,
      name: a.agent,
      model: identity?.model,
      roleId: identity?.roleId,
      workingDirectory: identity?.workingDirectory ?? a.agentDir ?? '',
      channelId: identity?.channelId,
      status: identity?.status,
      summary,
      scaffolded: true,
    });
  }

  // Roster agents NOT in the verifier's scaffolding list — surface as
  // unscaffolded so the fleet view doesn't hide unmanaged agents.
  const verifiedNames = new Set(verify.agents.map((a) => a.agent.toLowerCase()));
  for (const r of roster) {
    if (!r.workingDirectory) continue;
    if (verifiedNames.has(r.name.toLowerCase())) continue;
    if (r.type === 'participant') continue; // skip browser users / system
    agents.push({
      id: r.id,
      name: r.name,
      model: r.model,
      roleId: r.roleId,
      workingDirectory: r.workingDirectory,
      channelId: r.channelId,
      status: r.status,
      summary: {
        filesTotal: 0,
        filesSynced: 0,
        filesDrift: 0,
        filesMissing: 0,
        filesAgentOwned: 0,
        hooksActive: 0,
        hooksStale: 0,
        lastSyncAt: null,
      },
      scaffolded: false,
    });
  }

  // Aggregate fleet stats — "healthy" = scaffolded && drift==0 && missing==0
  let agentsHealthy = 0;
  let agentsDrift = 0;
  let agentsMissing = 0;
  let agentsUnscaffolded = 0;
  for (const a of agents) {
    if (!a.scaffolded) {
      agentsUnscaffolded += 1;
      continue;
    }
    if (a.summary.filesMissing > 0) agentsMissing += 1;
    if (a.summary.filesDrift > 0) agentsDrift += 1;
    if (a.summary.filesDrift === 0 && a.summary.filesMissing === 0) {
      agentsHealthy += 1;
    }
  }

  // Sort: unhealthy first (drift/missing) so the UI surfaces problems
  agents.sort((a, b) => {
    const aBad = a.summary.filesDrift + a.summary.filesMissing;
    const bBad = b.summary.filesDrift + b.summary.filesMissing;
    if (aBad !== bBad) return bBad - aBad;
    return a.name.localeCompare(b.name);
  });

  return {
    agentsTotal: agents.length,
    agentsHealthy,
    agentsDrift,
    agentsMissing,
    agentsUnscaffolded,
    agents,
    lastFleetSyncAt: fleetLastSync,
    verifiedAt: verify.verifiedAt,
  };
}

export async function composeAgentManifest(
  agent: AgentIdentity,
): Promise<AgentManifest> {
  const verify = await runVerifierFor(agent.name);
  const agentBlock = verify.agents.find((a) => a.agent === agent.name);
  const files = agentBlock?.files ?? [];

  const configured = await loadConfiguredHooks(agent.workingDirectory);
  const fireStats = await loadHookFireStats(agent.name);
  const hooks = joinHooks(configured, fireStats);

  const syncLog = await loadSyncLogTail(agent.name);

  const summary: ManifestSummary = {
    filesTotal: files.length,
    filesSynced: files.filter((f) => f.status === 'synced').length,
    filesDrift: files.filter((f) => f.status === 'drift').length,
    filesMissing: files.filter((f) => f.status === 'missing').length,
    filesAgentOwned: files.filter((f) => f.status === 'agent-owned').length,
    hooksActive: hooks.filter((h) => h.configured && !h.neverFired && !h.staleHook)
      .length,
    hooksStale: hooks.filter((h) => h.configured && (h.neverFired || h.staleHook))
      .length,
    lastSyncAt:
      files.reduce<string | null>((latest, f) => {
        if (!f.mtime) return latest;
        if (!latest) return f.mtime;
        return f.mtime > latest ? f.mtime : latest;
      }, null),
  };

  return {
    agent,
    files,
    hooks,
    syncLog,
    syncLogNote: syncLog.length === 0 ? SYNC_LOG_NOTE : undefined,
    summary,
    verifiedAt: verify.verifiedAt,
  };
}
