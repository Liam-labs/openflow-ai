/**
 * Participant presence — the single rule behind the channel UI's online dot and
 * the cross-channel send check, so an agent is never told "online" by one and
 * "offline" by the other.
 */
import type { CollabChannel, CollabChannelsData, CollabParticipant } from '@/lib/types';
import { isSeatStuck } from '@/lib/collab-seat-health';

export const ONLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes — must exceed the 5-min lastSeen poll throttle in app/api/collab/route.ts

export type PresenceStatus = 'online' | 'offline';

/** Online/offline for one participant, from lastSeen (or roster status for pty-* agents). */
export function participantPresence(
  participant: CollabParticipant,
  channel: CollabChannel,
  now: number = Date.now()
): PresenceStatus {
  // A seat that heartbeats but leaves its durable queue unclaimed is not listening
  // (delivery monitor, lib/collab-seat-health.ts): never report it online.
  if (isSeatStuck(channel.id, participant.id, now)) return 'offline';

  const lastSeenTime = participant.lastSeen ? new Date(participant.lastSeen).getTime() : 0;
  const fresh = now - lastSeenTime <= ONLINE_THRESHOLD_MS;

  // Windows per-message agents (pty-* participants) don't heartbeat between messages,
  // so lastSeen goes stale even when the agent is fully deployed and will respond.
  // Trust the roster entry's status as ground truth for these participants.
  if (participant.id.startsWith('pty-')) {
    const sessionId = participant.id.slice(4); // strip 'pty-'
    const rosterAgent = channel.roster?.agents.find(a => a.ptySessionId === sessionId);
    if (rosterAgent?.status === 'running') return 'online';
    if (rosterAgent?.status === 'stopped' || rosterAgent?.status === 'crashed') return 'offline';
  }

  // Roster agents (participant id "roster-<first 8 of roster agent id>") are
  // started and stopped through the roster, and lastSeen outlives a stop by up
  // to the online threshold. A stopped or crashed roster entry is offline
  // regardless of how fresh lastSeen is (e.g. after a host restart where the
  // agent has autoResume off). An explicit participantId on the entry wins over
  // the id-prefix match.
  if (participant.id.startsWith('roster-')) {
    const agents = channel.roster?.agents || [];
    const prefix = participant.id.slice('roster-'.length);
    const rosterAgent = agents.find(a => a.participantId === participant.id)
      ?? (prefix ? agents.find(a => !a.participantId && a.id.startsWith(prefix)) : undefined);
    if (rosterAgent?.status === 'stopped' || rosterAgent?.status === 'crashed') return 'offline';
  }
  return fresh ? 'online' : 'offline';
}

/**
 * Whether a message addressed to this participant will reach a live agent.
 * An "away" agent is working in another channel and receives this channel's
 * messages through its forwarding queue, so it counts when it is online there.
 */
export function participantReachable(
  participant: CollabParticipant,
  channel: CollabChannel,
  data: CollabChannelsData,
  now: number = Date.now()
): boolean {
  if (isSeatStuck(channel.id, participant.id, now)) return false;
  if (participantPresence(participant, channel, now) === 'online') return true;
  if (participant.status !== 'away' || !participant.awayInChannelId) return false;
  const awayChannel = data.channels.find(ch => ch.id === participant.awayInChannelId);
  const there = awayChannel?.participants.find(p =>
    p.name === participant.name
    && (!participant.projectPath || !p.projectPath || p.projectPath === participant.projectPath)
  );
  return !!(awayChannel && there && participantPresence(there, awayChannel, now) === 'online');
}

/** Human-readable age of a timestamp, e.g. "3d ago", "25m ago", "never". */
export function lastSeenAge(lastSeen: string | undefined, now: number = Date.now()): string {
  if (!lastSeen) return 'never';
  const mins = Math.max(0, Math.round((now - new Date(lastSeen).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
