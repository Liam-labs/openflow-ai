import { participantPresence } from '@/lib/collab-presence';
import type { AgentRosterEntry, CollabChannel, CollabParticipant } from '@/lib/types';

export const CODEX_NATIVE_PARTICIPANT_SOURCE = 'Codex Desktop Bridge';

type CleanupRosterEntry = Pick<AgentRosterEntry, 'participantId' | 'name' | 'status'>;

interface StaleParticipantCleanupInput {
  participants: readonly CollabParticipant[];
  /** The channel's declared parent, when it is a sub-channel (see isInheritedLiveMember). */
  parentChannel?: CollabChannel | null;
  rosterAgents?: readonly CleanupRosterEntry[];
  protectedParticipantIds?: readonly string[];
  nowMs: number;
  staleAfterMs: number;
}

export function isDurableCodexNativeParticipant(participant: CollabParticipant): boolean {
  return participant.source === CODEX_NATIVE_PARTICIPANT_SOURCE;
}

/**
 * A sub-channel member that is the same live agent working in the declared parent channel: same
 * participant ID, same exact non-empty project path, not a user, online there. Such rows have no local
 * roster entry or heartbeat, so idle cleanups would otherwise remove a live agent's membership. Used by
 * both the server cleanup and the browser's 10-minute cleanup. Nothing is matched by name.
 */
export function isInheritedLiveMember(
  participant: CollabParticipant,
  parentChannel: CollabChannel | null | undefined,
  nowMs: number,
): boolean {
  if (!parentChannel || participant.type === 'user' || !participant.projectPath) return false;
  const live = parentChannel.participants.find(p => p.id === participant.id
    && p.type !== 'user' && p.projectPath === participant.projectPath);
  return !!live && participantPresence(live, parentChannel, nowMs) === 'online';
}

/**
 * The commissioned hearing client: a channel binding that only posts when a hearing dispatches, so it
 * never heartbeats. The browser's 10-minute cleanup removed it when the owner opened the rehearsal channel
 * (8 Oct 2026, probe04), and every later dispatch then failed its sender check. Same exact identity the
 * hearing runtime requires of its sender.
 */
export function isDurableHearingClientParticipant(participant: CollabParticipant): boolean {
  return participant.type === 'user' && participant.id.startsWith('hearing-client-')
    && participant.name === 'Hearing companion' && participant.source === 'Hearing companion';
}

/**
 * the owner's canonical WebGate identity (`user-<mailbox>`, lib/webgate-identity.ts). Riley Voice posts his
 * spoken turns as exactly this participant, so removing it while his DevFlow tabs were idle made every
 * voice request fail with VOICE_TURN_TARGET_UNAVAILABLE (9 Oct 2026). A person stays a member while
 * away; only throwaway `browser-user-*` rows age out.
 */
export function isCanonicalUserParticipant(participant: CollabParticipant): boolean {
  return participant.type === 'user' && /^user-[a-z0-9_-]+$/.test(participant.id);
}

export function selectStaleParticipantsForCleanup({
  participants,
  parentChannel,
  rosterAgents = [],
  protectedParticipantIds = [],
  nowMs,
  staleAfterMs,
}: StaleParticipantCleanupInput): CollabParticipant[] {
  const protectedIds = new Set(protectedParticipantIds);

  return participants.filter((participant) => {
    if (protectedIds.has(participant.id)) return false;
    if (isDurableCodexNativeParticipant(participant)) return false;
    if (isDurableHearingClientParticipant(participant)) return false;
    if (isCanonicalUserParticipant(participant)) return false;
    if (isInheritedLiveMember(participant, parentChannel, nowMs)) return false;

    const lastSeenAge = nowMs - new Date(participant.lastSeen).getTime();
    if (lastSeenAge < staleAfterMs) return false;

    const rosterAgent = rosterAgents.find(
      (agent) => agent.participantId === participant.id || agent.name === participant.name,
    );
    return rosterAgent?.status !== 'running' && rosterAgent?.status !== 'starting';
  });
}
