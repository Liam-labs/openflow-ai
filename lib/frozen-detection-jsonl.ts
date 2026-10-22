/**
 * JSONL transcript mtime liveness helpers — SERVER-ONLY.
 *
 * Do NOT import this file from client components (it uses `node:fs` / `node:path`).
 * Client code should use `lib/frozen-detection.ts` which reads the pre-computed
 * `jsonlMtimeMs` field on `FrozenParticipantLike`.
 *
 * Consumers:
 *   - Server-side channel data preparation (populate `jsonlMtimeMs` on
 *     CollabParticipant before pushing to SSE clients)
 *   - T1.4 restart-grace C-c gate (`app/api/collab/pty/_handlers/message-inject.ts`)
 *     via the exported `isJsonlTranscriptFresh()` function
 *   - `detectFrozenParticipantIds()` callers that want to pre-compute the value
 *
 * Sprint 43 P2-T2.8 — Reynolds' durable fix for the respawned-Claude
 * activityStatus=None gap (T3.1 live finding, 2026-06-05).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CollabParticipant } from '@/lib/types';
import { getHomeDir } from '@/lib/home-dir';
import { remoteTranscriptMtime } from '@/lib/remote-usage';

export const JSONL_LIVENESS_THRESHOLD_MS = 90_000;

function encodeProjectKey(projectPath: string): string {
  // Must match Claude Code's cwd → project-dir encoding, which replaces EVERY
  // non-alphanumeric character with '-' (not just '/' and space). A previous
  // `/[\/ ]/` left '.' untouched, so any agent in a dotted/hidden path (e.g.
  // `.probe-latency`) resolved to a non-existent dir → tier-3 returned null →
  // JSONL liveness silently failed → busy agent false-FROZEN (T2.8, 2026-06-05).
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function readScratchFileSync(agentDir: string, filename: string): string | null {
  try {
    const raw = readFileSync(join(agentDir, '.session-scratch', filename), 'utf-8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function newestJsonlMtimeMs(projectsDir: string): number | null {
  if (!existsSync(projectsDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  const jsonlNames = entries.filter((n) => n.endsWith('.jsonl'));
  if (jsonlNames.length === 0) return null;

  let latest: number | null = null;
  for (const name of jsonlNames) {
    try {
      const st = statSync(join(projectsDir, name));
      if (latest === null || st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {
      // Skip unreadable
    }
  }
  return latest;
}

/**
 * Resolve the mtime (ms since epoch) of the active JSONL transcript for a
 * given agent working directory, or `null` if no transcript can be found.
 *
 * Three-tier resolution (same order as `lib/agent-jsonl-resolver.ts`):
 *   1. `.session-scratch/transcript-path` — absolute path (cleanest)
 *   2. `.session-scratch/session-id` + project-key join
 *   3. Newest `.jsonl` in the project-key directory (fallback)
 *
 * Synchronous — suits the frozen-detection compute-on-read pattern. Agents on the agent host are answered from the host's
 * last refresh (lib/remote-usage.ts).
 */
export function resolveJsonlMtimeMs(projectPath: string, sessionId?: string): number | null {
  const local = resolveLocalJsonlMtimeMs(projectPath, sessionId);
  // An agent whose transcript is written on the agent host has nothing on this disk. Take the host's answer too (known from its
  // last refresh; the first call for a folder starts that refresh) and use the freshest evidence of life.
  const remote = remoteTranscriptMtime(projectPath, sessionId);
  if (typeof remote === 'number') return local === null ? remote : Math.max(local, remote);
  return local;
}

function resolveLocalJsonlMtimeMs(projectPath: string, sessionId?: string): number | null {
  const home = getHomeDir();
  const projectKey = encodeProjectKey(projectPath);
  const projectsDir = join(home, '.claude', 'projects', projectKey);

  // Tier 1 — absolute transcript-path from SessionStart hook
  const transcriptPath = readScratchFileSync(projectPath, 'transcript-path');
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      return statSync(transcriptPath).mtimeMs;
    } catch {
      // Fall through
    }
  }

  // Tier 2 — session-id + project-key join
  const sid = sessionId ?? readScratchFileSync(projectPath, 'session-id');
  if (sid) {
    const candidate = join(projectsDir, `${sid}.jsonl`);
    if (existsSync(candidate)) {
      try {
        return statSync(candidate).mtimeMs;
      } catch {
        // Fall through
      }
    }
  }

  // Tier 3 — newest .jsonl by mtime (fallback)
  return newestJsonlMtimeMs(projectsDir);
}

/**
 * Check whether a Claude agent's JSONL transcript mtime indicates recent
 * activity (the agent is alive and working).
 *
 * Usable by both frozen-detection server plumbing AND the T1.4 restart-grace
 * C-c gate — a freshly-respawned Claude agent whose activityStatus hasn't
 * reached the roster store will still read as alive if its transcript is
 * advancing.
 */
export function isJsonlTranscriptFresh(
  projectPath: string,
  sessionId?: string,
  thresholdMs: number = JSONL_LIVENESS_THRESHOLD_MS,
  now: number = Date.now(),
): boolean {
  const mtime = resolveJsonlMtimeMs(projectPath, sessionId);
  if (mtime === null) return false;
  return (now - mtime) < thresholdMs;
}

/**
 * Enrich CollabParticipant[] with `jsonlMtimeMs` for every participant that
 * has a `projectPath` (Claude terminal agents). Best-effort, non-blocking —
 * individual lookup failures are silent and leave `jsonlMtimeMs` undefined.
 *
 * Call before emitting `collab:message` SSE events so the client-side
 * frozen-detection has the durable liveness signal available.
 */
export function enrichParticipantsJsonlMtime(participants: CollabParticipant[]): void {
  for (const p of participants) {
    if (!p.projectPath) continue;
    try {
      (p as unknown as Record<string, unknown>).jsonlMtimeMs = resolveJsonlMtimeMs(p.projectPath, p.sessionId);
    } catch {
      // Best-effort — leave undefined
    }
  }
}
