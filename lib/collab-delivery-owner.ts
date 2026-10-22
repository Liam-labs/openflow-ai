import type { CollabChannelsData } from '@/lib/types';

/**
 * Resolve the only wrapper identity currently authorised for a durable recipient.
 *
 * The roster entry decides what runtime a seat is. A participant record can
 * drift from it (Jack, 15-17 Oct 2026: the record read `claude-terminal` with
 * no protocol while a Codex wrapper ran, so every claim was refused for 37
 * hours), and the seat still runs the same wrapper. So when a
 * roster entry exists, its runtime and protocol are the authority and the
 * participant record only has to exist. Participants with no roster entry must
 * identify themselves.
 */
export function resolveCurrentDeliveryOwnerId(
  data: CollabChannelsData,
  channelId: string,
  participantId: string,
): string | null {
  const channel = data.channels.find(candidate => candidate.id === channelId);
  const participant = channel?.participants.find(candidate => candidate.id === participantId);
  if (!participant) return null;
  const rosterAgent = channel?.roster?.agents.find(candidate => candidate.participantId === participantId);
  if (rosterAgent) {
    if (rosterAgent.agentType !== 'codex' || rosterAgent.deliveryProtocol !== 'ledger-v1') return null;
    if (!['running', 'starting', 'restarting', 'away'].includes(rosterAgent.status)) return null;
    // Remote-host agents have no server-visible roster pid; the wrapper reports its own pid on heartbeat.
    const pid = Number.isInteger(rosterAgent.pid) && Number(rosterAgent.pid) > 0
      ? rosterAgent.pid
      : (participant.host?.wrapperPid ?? participant.pid);
    if (!Number.isInteger(pid) || Number(pid) <= 0) return null;
    return `codex:${participantId}:${pid}`;
  }
  if (participant.type !== 'codex' || participant.deliveryProtocol !== 'ledger-v1') return null;
  if (!Number.isInteger(participant.pid) || Number(participant.pid) <= 0) return null;
  return `codex:${participantId}:${participant.pid}`;
}
