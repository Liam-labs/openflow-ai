/**
 * Offline-mention notice.
 *
 * When a participant posts a channel message that @mentions an agent who is
 * offline, nobody acts on it: the mentioned agent only sees it when it comes
 * back. This module sends the SENDER an automatic system message saying so, and
 * suggests doing the task without that agent or bringing it online.
 *
 * Single shared implementation for both write paths:
 *   - UI / collab_helper route   (app/api/collab/_handlers/messaging.ts)
 *   - Agent API collab.message   (app/api/agent/actions/collab.ts)
 *
 * Presence comes from lib/collab-presence.ts (participantReachable), the same
 * rule behind the channel UI's online dot and the cross-channel send check.
 *
 * Loop safety (the notice can never trigger another notice):
 *   - the notice is appended directly, never through either write path;
 *   - messages from 'system', silent messages and structured/automated
 *     messages (metadata.client.kind: ask-owner, outlook, design, notice...)
 *     are never inspected;
 *   - the notice is targeted at the sender only, so no offline agent is woken
 *     and no other agent gets a turn;
 *   - at most one notice per (channel, sender, offline target) per 10 minutes.
 */

import { randomUUID } from 'crypto';
import type { CollabChannel, CollabChannelsData, CollabMessage, CollabParticipant } from '@/lib/types';
import { lastSeenAge, participantReachable } from '@/lib/collab-presence';
import { appendMessage } from '@/lib/collab-message-io';
import { eventBus } from '@/lib/event-bus';
import { deliverMessage } from '@/lib/collab-delivery';
import { enqueueDurableDeliveries, prepareDurableDelivery } from '@/lib/collab-delivery-ledger';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';

export const OFFLINE_NOTICE_KIND = 'devflow.offline-mention-notice';
export const OFFLINE_NOTICE_WINDOW_MS = 10 * 60 * 1000;

export interface OfflineMention {
  /** Agent display name. */
  name: string;
  /** Roster agent ID, the `agentId` that roster.spawn needs. Absent when not on the roster. */
  agentId?: string;
  lastSeen?: string;
}

// In-memory rate limit: key -> time of last notice. No persistence needed.
const lastNoticeAt = new Map<string, number>();
const MAX_TRACKED_KEYS = 1000;

export function resetOfflineMentionRateLimit(): void {
  lastNoticeAt.clear();
}

function rateKey(channelId: string, sender: CollabParticipant, targetName: string): string {
  // Keyed by name, not ID: one agent can hold two participant IDs in a channel.
  return `${channelId}|${sender.name.toLowerCase()}|${targetName.toLowerCase()}`;
}

/**
 * Which @mentioned agents are offline? Pure: no I/O, no state.
 *
 * `recipients` is the final recipient list the message was stored with (parsed
 * @mentions plus any explicit targets). Humans, the sender, and anything sent by
 * the system or an automated/structured source are ignored.
 */
export function findOfflineMentions(args: {
  channel: CollabChannel;
  data: CollabChannelsData;
  sender: CollabParticipant;
  message: Pick<CollabMessage, 'silent' | 'metadata'>;
  recipients: string[] | undefined;
  now?: number;
}): OfflineMention[] {
  const { channel, data, sender, message, recipients } = args;
  const now = args.now ?? Date.now();

  if (!recipients || recipients.length === 0) return [];
  if (message.silent) return [];
  if (sender.id === 'system') return [];
  // Any structured/automated message (ask-owner card, outlook alert, design
  // board, an earlier notice...) declares itself via metadata.client.kind.
  if (message.metadata?.client?.kind) return [];

  const byAgent = new Map<string, OfflineMention & { reachable: boolean }>();
  for (const id of recipients) {
    if (id === sender.id) continue;
    const p = channel.participants.find(cp => cp.id === id);
    if (p?.type === 'user') continue;
    const rosterEntry = channel.roster?.agents.find(a => a.participantId === id);
    const name = p?.name ?? rosterEntry?.name;
    if (!name) continue;
    if (name.toLowerCase() === sender.name.toLowerCase()) continue;

    const key = name.toLowerCase();
    const entry = byAgent.get(key) ?? { name, reachable: false };
    if (p && participantReachable(p, channel, data, now)) entry.reachable = true;
    if (p?.lastSeen && (!entry.lastSeen || p.lastSeen > entry.lastSeen)) entry.lastSeen = p.lastSeen;
    byAgent.set(key, entry);
  }

  const offline: OfflineMention[] = [];
  for (const [key, entry] of byAgent) {
    if (entry.reachable) continue;
    const roster = channel.roster?.agents.find(a => a.name?.toLowerCase() === key);
    offline.push({
      name: entry.name,
      ...(roster?.id && { agentId: roster.id }),
      ...(entry.lastSeen && { lastSeen: entry.lastSeen }),
    });
  }
  return offline;
}

function mentionOf(name: string): string {
  return /\s/.test(name) ? `@"${name}"` : `@${name}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The notice text. Offline names carry no '@', so the notice itself mentions only the sender. */
export function buildOfflineMentionNotice(args: {
  sender: CollabParticipant;
  offline: OfflineMention[];
  channelId: string;
}): string {
  const { sender, offline, channelId } = args;
  const names = joinNames(offline.map(o => o.name));
  const plural = offline.length > 1;
  const head = `${mentionOf(sender.name)} ${names} ${plural ? 'are' : 'is'} offline, so they `
    + `won't see your message until back online.`;

  if (sender.type === 'user') {
    return `${head} You can start them from the channel's agent roster, or ask an online agent to help.`;
  }

  const withId = offline.filter(o => o.agentId);
  const withoutId = offline.filter(o => !o.agentId);
  const bringOnline: string[] = [];
  if (withId.length > 0) {
    bringOnline.push(
      `To bring an agent online, call the Agent API action roster.spawn with channelId "${channelId}" and agentId `
      + `(${withId.map(o => `${o.name}: ${o.agentId}`).join('; ')}).`,
    );
  }
  if (withoutId.length > 0) {
    bringOnline.push(`${joinNames(withoutId.map(o => o.name))} ${withoutId.length > 1 ? 'are' : 'is'} not on this channel's roster, so ask ${HUMAN_ROUTING_NAME} to add them.`);
  }
  return `${head} Can you do the task without them, or should you bring them online yourself? ${bringOnline.join(' ')}`;
}

/** Take the targets not noticed in the last window and mark them noticed. */
function reserveTargets(channelId: string, sender: CollabParticipant, offline: OfflineMention[], now: number): OfflineMention[] {
  if (lastNoticeAt.size > MAX_TRACKED_KEYS) {
    for (const [key, at] of lastNoticeAt) {
      if (now - at >= OFFLINE_NOTICE_WINDOW_MS) lastNoticeAt.delete(key);
    }
  }
  const fresh: OfflineMention[] = [];
  for (const target of offline) {
    const key = rateKey(channelId, sender, target.name);
    const last = lastNoticeAt.get(key);
    if (last !== undefined && now - last < OFFLINE_NOTICE_WINDOW_MS) continue;
    lastNoticeAt.set(key, now);
    fresh.push(target);
  }
  return fresh;
}

function releaseTargets(channelId: string, sender: CollabParticipant, targets: OfflineMention[]): void {
  for (const target of targets) lastNoticeAt.delete(rateKey(channelId, sender, target.name));
}

/**
 * Post the notice to the sender. Never throws: a failure here must not affect
 * the sender's own message. Returns the notice message ID, or null when nothing
 * was posted (nothing offline, or all targets already noticed within 10 minutes).
 */
export async function postOfflineMentionNotice(args: {
  channel: CollabChannel;
  sender: CollabParticipant;
  offline: OfflineMention[];
  /** Mirror the original message's hidden flag so a hidden chase stays hidden. */
  hidden?: boolean;
  now?: number;
}): Promise<string | null> {
  const { channel, sender, offline } = args;
  if (offline.length === 0) return null;
  const nowMs = args.now ?? Date.now();
  const targets = reserveTargets(channel.id, sender, offline, nowMs);
  if (targets.length === 0) return null;

  try {
    const iso = new Date(nowMs).toISOString();
    const message: CollabMessage = {
      id: `offline-mention-${randomUUID()}`,
      channelId: channel.id,
      from: { id: 'system', type: 'user', name: 'System', source: 'DevFlow', joinedAt: iso, lastSeen: iso },
      content: buildOfflineMentionNotice({ sender, offline: targets, channelId: channel.id }),
      timestamp: iso,
      mentions: [sender.id],
      recipients: [sender.id], // only the sender; offline agents are never woken
      metadata: {
        deliveryMode: 'targeted',
        ...(args.hidden && { isHidden: true }),
        client: {
          kind: OFFLINE_NOTICE_KIND,
          offlineAgents: targets.map(t => ({ name: t.name, lastSeen: lastSeenAge(t.lastSeen, nowMs) })),
        },
      },
    };
    prepareDurableDelivery('system', message, channel);
    await appendMessage(channel.id, message);
    await enqueueDurableDeliveries('system', message, channel);
    eventBus.emitEvent('collab:message', { channelId: channel.id, message });
    deliverMessage('system', message, channel);
    return message.id;
  } catch (error) {
    releaseTargets(channel.id, sender, targets);
    console.error('[Collab] Offline-mention notice failed:', error);
    return null;
  }
}
