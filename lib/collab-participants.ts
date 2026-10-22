/**
 * Participant identity hygiene for collab channels.
 *
 * A channel must hold exactly one record per participant id. Several code paths
 * key on `participant.id` (unread counts, mark_read, presence), so a second record
 * with the same id makes the two disagree: mark_read updates the first record while
 * the unread count is taken from the last one, and the badge reappears.
 *
 * A seat's runtime and delivery protocol come from its roster entry, not from
 * whatever a participant record last said (see reconcileParticipantWithRoster).
 */
import type { AgentRosterEntry, CollabChannel, CollabParticipant } from '@/lib/types';

function laterIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

function earlierIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(b).getTime() < new Date(a).getTime() ? b : a;
}

/**
 * Merge `other` into `target` (same id). The record seen most recently supplies
 * the scalar fields; fields it lacks are filled from the other. Read/seen markers
 * keep the latest value and joinedAt keeps the earliest.
 */
export function mergeParticipantRecords(
  target: CollabParticipant,
  other: CollabParticipant,
): CollabParticipant {
  const targetLive = new Date(target.lastSeen || 0).getTime();
  const otherLive = new Date(other.lastSeen || 0).getTime();
  const [primary, secondary] = otherLive > targetLive ? [other, target] : [target, other];

  const merged: CollabParticipant = { ...secondary, ...primary };
  for (const key of Object.keys(secondary) as Array<keyof CollabParticipant>) {
    if (merged[key] === undefined || merged[key] === null) {
      (merged as unknown as Record<string, unknown>)[key] = secondary[key];
    }
  }
  merged.joinedAt = earlierIso(target.joinedAt, other.joinedAt) as string;
  merged.lastSeen = laterIso(target.lastSeen, other.lastSeen) as string;
  const lastRead = laterIso(target.lastRead, other.lastRead);
  if (lastRead) merged.lastRead = lastRead;
  // 'away' is the only persisted status; never let a stale duplicate drop it.
  if (!merged.status && secondary.status === 'away') merged.status = 'away';
  return merged;
}

/**
 * Collapse duplicate participant ids in place, keeping the first record's position.
 * Returns the number of duplicate records removed (0 leaves the array untouched).
 */
export function dedupeParticipants(channel: { participants: CollabParticipant[] }): number {
  const participants = channel.participants;
  if (!Array.isArray(participants) || participants.length < 2) return 0;

  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const p of participants) {
    if (!p?.id) continue;
    if (seen.has(p.id)) { hasDuplicate = true; break; }
    seen.add(p.id);
  }
  if (!hasDuplicate) return 0;

  const byId = new Map<string, number>();
  const result: CollabParticipant[] = [];
  let removed = 0;
  for (const p of participants) {
    if (!p?.id) { result.push(p); continue; }
    const at = byId.get(p.id);
    if (at === undefined) {
      byId.set(p.id, result.length);
      result.push(p);
    } else {
      // Keep the first record's object identity so callers holding it stay valid.
      Object.assign(result[at], mergeParticipantRecords(result[at], p));
      removed++;
    }
  }
  channel.participants = result;
  return removed;
}

/** Dedupe every channel in a collab data file. Returns total duplicates removed. */
export function dedupeAllChannelParticipants(data: { channels: Array<{ participants: CollabParticipant[] }> }): number {
  let removed = 0;
  for (const channel of data.channels || []) removed += dedupeParticipants(channel);
  return removed;
}

const CODEX_WRAPPER_SOURCE = 'collab-codex wrapper';
/** Labels a spawn gives a record before the wrapper's own join has described it. */
const PLACEHOLDER_SOURCES = new Set(['Collab Wrapper', 'DevFlow PTY']);

function seatWorkingDirectory(agent: AgentRosterEntry): string | undefined {
  return agent.effectiveWorkingDirectory || agent.workingDirectory || undefined;
}

/**
 * The participant record a spawn creates for a roster agent that has none.
 * The roster's runtime decides its type and delivery protocol: a Codex seat
 * created as a Claude terminal is refused every durable claim.
 */
export function buildSeatParticipant(agent: AgentRosterEntry, now: string): CollabParticipant {
  const base = {
    id: agent.participantId,
    name: agent.name,
    joinedAt: now,
    lastSeen: now,
    color: agent.color,
  };
  if (agent.agentType === 'codex') {
    const projectPath = seatWorkingDirectory(agent);
    return {
      ...base,
      type: 'codex',
      source: CODEX_WRAPPER_SOURCE,
      ...(agent.deliveryProtocol === 'ledger-v1' ? { deliveryProtocol: 'ledger-v1' as const } : {}),
      ...(projectPath ? { projectPath } : {}),
    };
  }
  return { ...base, type: 'claude-terminal', source: agent.useCollabWrapper ? 'Collab Wrapper' : 'DevFlow PTY' };
}

/**
 * Make a Codex seat's participant record agree with its roster entry, in place.
 * Returns true when it changed anything.
 *
 * A record can lose its runtime fields: a spawn creates a placeholder, and a
 * write built from an older copy of the channel can leave that placeholder in
 * place after the wrapper's join (Jack, 15 Oct 2026: the join was accepted, yet
 * the record kept only the placeholder's fields; the server keeps no write log,
 * so the writer is not recorded). Only fields the wrapper's join owns are
 * restored; a value that is already right, a user, a Claude seat or a
 * participant with no roster entry is left alone.
 */
export function reconcileParticipantWithRoster(
  channel: Pick<CollabChannel, 'roster'>,
  participant: CollabParticipant,
): boolean {
  if (participant.type === 'user') return false;
  const agent = channel.roster?.agents.find(candidate => candidate.participantId === participant.id);
  if (!agent || agent.agentType !== 'codex') return false;

  let changed = false;
  if (participant.type !== 'codex') {
    participant.type = 'codex';
    changed = true;
  }
  if (agent.deliveryProtocol === 'ledger-v1' && participant.deliveryProtocol !== 'ledger-v1') {
    participant.deliveryProtocol = 'ledger-v1';
    changed = true;
  }
  if (!participant.projectPath) {
    const projectPath = seatWorkingDirectory(agent);
    if (projectPath) {
      participant.projectPath = projectPath;
      changed = true;
    }
  }
  if (!participant.source || PLACEHOLDER_SOURCES.has(participant.source)) {
    participant.source = CODEX_WRAPPER_SOURCE;
    changed = true;
  }
  return changed;
}

/**
 * A heartbeat proves a seat is alive in this channel, so its roster entry is not away.
 * Clears the `away` status and any leftover away-channel fields on the roster entry of
 * that same seat, matched by participant id (an entry with no participant id falls back to
 * the seat's name). Another seat's entry is never touched. Nothing lets a person set
 * `away`: it is only set when the same agent joins another channel, so a heartbeat from
 * the seat itself is what ends it. Returns true when it changed anything.
 */
export function clearRosterAwayForSeat(
  channel: Pick<CollabChannel, 'roster'>,
  participant: Pick<CollabParticipant, 'id' | 'name'>,
): boolean {
  const agents = channel.roster?.agents ?? [];
  const agent = agents.find(candidate => candidate.participantId === participant.id)
    ?? agents.find(candidate => !candidate.participantId && candidate.name === participant.name);
  if (!agent) return false;

  let changed = false;
  if (agent.status === 'away') {
    agent.status = 'running';
    changed = true;
  }
  if (agent.awayInChannelId || agent.awayInChannelName) {
    agent.awayInChannelId = undefined;
    agent.awayInChannelName = undefined;
    changed = true;
  }
  if (changed && channel.roster) channel.roster.lastUpdated = new Date().toISOString();
  return changed;
}
