/**
 * Frozen-agent detection: identify online agents who have unread @mentions
 * past the stale threshold and are not currently doing work.
 *
 * Sprint 43 P1-T1 tightened this from a 5-minute threshold to 10 minutes,
 * capped lookback at 30 minutes, and added an exemption for any agent
 * currently broadcasting `working` status or a non-empty `activityDetail`.
 *
 * Sprint 43 P2-T2.8 replaced the single-signal activityStatus proxy with
 * multi-signal liveness: JSONL transcript mtime (Claude agents — durable,
 * filesystem ground-truth, survives respawn gap where activityStatus is
 * None) + activityStatus heartbeat (all wrapper types) + recent-channel-post
 * (any agent).
 *
 * The JSONL-mtime liveness helpers live in `lib/frozen-detection-jsonl.ts`
 * (server-only — imports `node:fs`/`node:path`). This file is safe to import
 * from client components. Callers should populate `jsonlMtimeMs` on the
 * participant before passing it to `detectFrozenParticipantIds()`.
 *
 * The `isJsonlTranscriptFresh()` export from the server-only module is also
 * consumable by the T1.4 restart-grace C-c gate in `message-inject.ts`.
 */

export const FROZEN_STALE_THRESHOLD_MS = 10 * 60 * 1000;   // 10 min — minimum age before a missed @mention flags
export const FROZEN_MENTION_LOOKBACK_MS = 30 * 60 * 1000;  // 30 min — anything older is ignored
export const FROZEN_ONLINE_WINDOW_MS = 120 * 1000;         // 2 min — lastSeen window for "online"

/**
 * JSONL transcript mtime freshness threshold.
 *
 * Reynolds' finding (T3.1, 2026-06-05): freshly-respawned Claude agents show
 * activityStatus=None even while provably busy. The durable signal is the
 * JSONL transcript file's mtime — if the transcript's mtime advanced within
 * the last 90 seconds, the Claude agent is alive regardless of what
 * activityStatus says. 90 s is longer than a typical long tool turn
 * (WebSearch/WebFetch ~60 s) to avoid false-negatives during deep work.
 */
export const JSONL_LIVENESS_THRESHOLD_MS = 90_000;

export interface FrozenParticipantLike {
  id: string;
  name: string;
  type: string;
  lastSeen: string;
  lastRead?: string | null;
  activityStatus?: 'idle' | 'typing' | 'working';
  activityUpdatedAt?: string;
  /** Working directory for terminal agents — enables JSONL-mtime resolution. */
  projectPath?: string;
  /** Claude Code session ID — preferred transcript lookup key. */
  sessionId?: string;
  /**
   * Pre-computed JSONL transcript mtime (ms since epoch), populated by
   * server-side code before passing participants to this function.
   * `null` = lookup was attempted but no transcript found.
   * `undefined` = lookup was not attempted (non-Claude agent or not yet plumbed).
   */
  jsonlMtimeMs?: number | null;
}

export interface FrozenMessageLike {
  from: { id: string };
  timestamp: string;
  content: unknown;
  /** Participant ids the server resolved from the message's @mentions. Preferred over searching the text. */
  mentions?: string[];
  /** Participant ids the message was delivered to (undefined = broadcast). */
  recipients?: string[];
}

/**
 * Whether a message asked this participant for a reply. The server resolves @mentions and recipients when it stores a message, so use that
 * rather than searching the text for "@Name": a forwarded or quoted message can contain "@Name" without being addressed to anyone called Name
 * (a cross-channel envelope from another agent of the same name carried the reply instructions "mention @an agent", which flagged an agent as
 * frozen for a message she was never sent). Falls back to the text only when the message carries no routing fields at all.
 */
function addressesParticipant(m: FrozenMessageLike, p: { id: string; name: string }): boolean {
  if (Array.isArray(m.mentions)) return m.mentions.includes(p.id);
  if (Array.isArray(m.recipients) && m.recipients.length > 0) return m.recipients.includes(p.id) && typeof m.content === 'string' && m.content.includes(`@${p.name}`);
  return typeof m.content === 'string' && m.content.includes(`@${p.name}`);
}

export interface FrozenTypingLike {
  participantId: string;
  activity?: 'typing' | 'working';
  activityDetail?: string | null;
}

export interface FrozenDetectionInput {
  participants: FrozenParticipantLike[];
  messages: FrozenMessageLike[];
  activeTyping?: FrozenTypingLike[];
  now: number;
}

export function detectFrozenParticipantIds(input: FrozenDetectionInput): Set<string> {
  const { participants, messages, activeTyping = [], now } = input;
  const frozen = new Set<string>();

  const exempt = new Set<string>();
  for (const t of activeTyping) {
    const hasDetail = typeof t.activityDetail === 'string' && t.activityDetail.length > 0;
    if (t.activity === 'working' || hasDetail) {
      exempt.add(t.participantId);
    }
  }

  for (const p of participants) {
    if (p.type === 'user') continue;
    if (exempt.has(p.id)) continue;

    const lastSeenAge = now - new Date(p.lastSeen).getTime();
    if (lastSeenAge > FROZEN_ONLINE_WINDOW_MS) continue;

    const lastReadTime = p.lastRead ? new Date(p.lastRead).getTime() : 0;

    const hasUnreadMention = messages.some(m => {
      const msgTime = new Date(m.timestamp).getTime();
      if (msgTime <= lastReadTime) return false;
      const age = now - msgTime;
      if (age < FROZEN_STALE_THRESHOLD_MS) return false;
      if (age > FROZEN_MENTION_LOOKBACK_MS) return false;
      return addressesParticipant(m, p);
    });

    if (!hasUnreadMention) continue;

    // A recent channel post is direct evidence that the agent is responsive,
    // even when its activity heartbeat or transcript metadata is temporarily
    // stale during a respawn. Keep this bounded to the same ten-minute window
    // used by the frozen threshold so an old reply cannot mask a later miss.
    const hasRecentPost = messages.some(m => {
      if (m.from.id !== p.id) return false;
      const msgTime = new Date(m.timestamp).getTime();
      return Number.isFinite(msgTime)
        && msgTime <= now
        && (now - msgTime) < FROZEN_STALE_THRESHOLD_MS;
    });
    if (hasRecentPost) continue;

    // Multi-signal liveness check:
    // 1. activityStatus heartbeat (works for stable Claude + non-Claude
    //    wrappers that emit heartbeats).
    // 2. JSONL transcript mtime — pre-computed by server-side code
    //    (lib/frozen-detection-jsonl.ts). Covers the freshly-respawned
    //    Claude gap where activityStatus reads None while the agent is busy.
    const isActivelyWorking =
      p.activityStatus === 'working' ||
      p.activityStatus === 'typing';

    let isJsonlFresh = false;
    if (!isActivelyWorking && p.jsonlMtimeMs !== undefined && p.jsonlMtimeMs !== null) {
      isJsonlFresh = (now - p.jsonlMtimeMs) < JSONL_LIVENESS_THRESHOLD_MS;
    }

    if (!isActivelyWorking && !isJsonlFresh) frozen.add(p.id);
  }

  return frozen;
}
