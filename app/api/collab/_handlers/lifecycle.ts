/**
 * Channel lifecycle handlers: create, join, leave, delete, archive, restore,
 * list_archived, permanently_delete.
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type {
  CollabChannel,
  CollabChannelsData,
  CollabChannelActionRequest,
  CollabChannelActionResponse,
  CollabParticipant,
  CollabMessage,
  ArchivedChannel,
  ArchivedChannelsData,
  AgentRosterEntry,
} from '@/lib/types';
import { saveChannels } from '@/lib/collab-channel-store';
import { DataPaths, archivedChannelMessageFile, archivedChannelMessagesDir } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile } from '@/lib/data-io';
import { eventBus, emitCollabError } from '@/lib/event-bus';
import { resolveChannelGroups } from '@/lib/collab-groups';
import {
  getMessagesPaginated,
  appendMessages as appendChannelMessages,
  deleteChannelMessages,
} from '@/lib/collab-message-io';
import { onChannelCreated, onChannelDeleted } from '@/teams-integration/lib/teams-auto-sync';
import {
  onChannelCreated as onSlackChannelCreated,
  onChannelDeleted as onSlackChannelDeleted,
} from '@/slack-integration/lib/slack-auto-sync';
import {
  onChannelCreated as registryOnCreated,
  onChannelArchived as registryOnArchived,
  onChannelRestored as registryOnRestored,
  onChannelDeleted as registryOnDeleted,
} from '@/lib/channels-registry';
import {
  generateStableParticipantId,
  getNextColor,
  markAgentAwayInOtherChannels,
  generateChannelName,
  ensureBrowserUserInChannel,
} from '../_collab-shared';
import type { ResolvedWebGateIdentity } from '@/lib/webgate-identity';
import { isDurableHearingClientParticipant } from '@/lib/collab-participant-cleanup';
import { ensureChannelProject } from '@/lib/channel-project-bootstrap';
import { dedupeParticipants } from '@/lib/collab-participants';
import { getDevflowHome } from '@/lib/home-dir';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import { PRODUCT_NAME } from '@/lib/brand';

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function handleCreate(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  const channelId = randomUUID();
  const channelName = body.name || generateChannelName();
  const channelProject = await ensureChannelProject({
    channelName,
    projectId: body.projectId,
    projectPath: body.projectPath,
  });
  const newChannel: CollabChannel = {
    id: channelId,
    name: channelName,
    projectId: channelProject.projectId,
    projectPath: channelProject.projectPath,
    createdAt: now,
    lastActivity: now,
    ownerId: body.ownerId,
    participants: [],
    messages: [],
    settings: {
      autoRespond: true,
      respondingAgentName: 'Assistant',
      // New channels land in the group the user created them from.
      ...(body.category && resolveChannelGroups(data).some(g => g.id === body.category)
        ? { category: body.category }
        : {}),
    },
  };

  ensureBrowserUserInChannel(newChannel, data, now);

  data.channels.push(newChannel);
  await saveChannels(data);

  onChannelCreated(channelId, newChannel.name).catch(err =>
    console.error('[Collab] Teams auto-sync create error:', err)
  );
  onSlackChannelCreated(channelId, newChannel.name).catch(err =>
    console.error('[Collab] Slack auto-sync create error:', err)
  );
  registryOnCreated(newChannel).catch(err =>
    console.error('[ChannelsRegistry] create sync error:', err)
  );

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId,
    channel: newChannel,
  });
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

export async function handleJoin(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string,
  resolvedIdentity: ResolvedWebGateIdentity | null = null
): Promise<NextResponse> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }
  if (!body.participant) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'participant is required' }, { status: 400 });
  }

  // Sprint Q1 T4 — Reynolds, 2026-05-27. Pre-flight validation closes the
  // QA-log high (collab.join accepted garbage participants: null, string,
  // array, missing-name, 5000-char name, name with \x00, 1000-char type —
  // all persisted into channel roster).
  if (typeof body.participant !== 'object' || Array.isArray(body.participant) || body.participant === null) {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'participant must be a non-null object' },
      { status: 400 },
    );
  }
  if (!body.participant.name || typeof body.participant.name !== 'string') {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'participant.name is required and must be a string' },
      { status: 400 },
    );
  }
  if (body.participant.name.length > 200) {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'participant.name must be 200 characters or fewer' },
      { status: 400 },
    );
  }
  if (/[\x00-\x1f\x7f\x9b]/.test(body.participant.name)) {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'participant.name must not contain control characters' },
      { status: 400 },
    );
  }
  if (body.participant.type && typeof body.participant.type !== 'string') {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'participant.type must be a string when provided' },
      { status: 400 },
    );
  }
  if (typeof body.participant.type === 'string' && body.participant.type.length > 100) {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'participant.type must be 100 characters or fewer' },
      { status: 400 },
    );
  }
  if (body.participant.id !== undefined && typeof body.participant.id !== 'string') {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'participant.id must be a string when provided' },
      { status: 400 },
    );
  }

  // WebGate identity resolution: browser-user-* on a webgate-authenticated
  // request → override to canonical participant. This binds all of the owner's
  // browser sessions (home, phone, webgate) to a single stable identity.
  if (
    resolvedIdentity &&
    body.participant.type === 'user' &&
    body.participant.id?.startsWith('browser-user-')
  ) {
    body.participant.id = resolvedIdentity.canonicalParticipantId;
    body.participant.name = resolvedIdentity.canonicalName;
  }

  const channel = data.channels.find(c => c.id === body.channelId);
  if (!channel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  // Non-claude wrapper agents (codex / antigravity / grok / gemini)
  // get the same stable-id treatment as claude — otherwise every wrapper
  // respawn creates a new participant entry. Sprint Hermes-postmortem
  // Task 3 (Reynolds, 2026-05-27): Sam respawning on Hermes was creating
  // zombie participants on every join because this gate excluded her type.
  const NON_CLAUDE_AGENT_TYPES = new Set(['codex', 'antigravity', 'grok', 'gemini']);
  const isStableIdEligibleType =
    body.participant!.type?.includes('terminal')
    || body.participant!.type === 'claude'
    || (body.participant!.type ? NON_CLAUDE_AGENT_TYPES.has(body.participant!.type) : false);
  const incomingStableId = isStableIdEligibleType
    ? generateStableParticipantId(body.participant!)
    : null;

  if (channel.blockedParticipantIds?.length) {
    const nameBlock = body.participant!.name ? `name:${body.participant!.name}` : null;
    const isBlocked = (body.participant!.id && channel.blockedParticipantIds.includes(body.participant!.id))
      || (incomingStableId && channel.blockedParticipantIds.includes(incomingStableId))
      || (nameBlock && channel.blockedParticipantIds.includes(nameBlock));
    if (isBlocked) {
      if (body.force) {
        channel.blockedParticipantIds = channel.blockedParticipantIds.filter(
          id => id !== body.participant!.id && id !== incomingStableId && id !== nameBlock
        );
      } else {
        return NextResponse.json<CollabChannelActionResponse>({
          success: false,
          error: 'Participant was removed from this channel',
        }, { status: 403 });
      }
    }
  }

  const matchedParticipant = channel.participants.find(p => {
    if (body.participant!.id && p.id === body.participant!.id) return true;
    if (incomingStableId && p.id === incomingStableId) return true;
    if (body.participant!.pid && p.pid === body.participant!.pid) return true;
    // Sprint Hermes-postmortem Task 3 (2026-05-27) — also treat non-claude
    // wrapper types as agent for name-match upsert so respawns of
    // Codex / Antigravity / Grok / Gemini agents land on the existing
    // participant entry rather than spawning a duplicate.
    const isAgentType = (t?: string) =>
      t?.includes('terminal')
      || t === 'claude'
      || t === 'agent'
      || (t ? NON_CLAUDE_AGENT_TYPES.has(t) : false);
    if (body.participant!.name && isAgentType(p.type) && isAgentType(body.participant!.type)) {
      if (p.name === body.participant!.name) return true;
      const preferredName = channel.preferredNames?.[p.id];
      if (preferredName && preferredName === body.participant!.name) return true;
    }
    if (body.participant!.id?.startsWith('browser-user-') &&
        p.id.startsWith('browser-user-') &&
        body.participant!.type === 'user' &&
        p.type === 'user') return true;
    // WebGate identity merge: canonical user (e.g. user-owner) absorbs any
    // existing browser-user-* in the channel — one identity per person.
    if (resolvedIdentity &&
        body.participant!.id === resolvedIdentity.canonicalParticipantId &&
        p.id.startsWith('browser-user-') &&
        p.type === 'user') return true;
    return false;
  });

  if (matchedParticipant) {
    // WebGate identity migration: upgrade browser-user-* → canonical ID
    if (
      resolvedIdentity &&
      matchedParticipant.id.startsWith('browser-user-') &&
      matchedParticipant.id !== resolvedIdentity.canonicalParticipantId
    ) {
      matchedParticipant.id = resolvedIdentity.canonicalParticipantId;
    }

    // Sprint Hermes-postmortem Task 3 (Reynolds, 2026-05-27) — preseed-id wins.
    // When the join request supplied an explicit participant.id (roster
    // provided it via the wrapper's --participant-id flag) and we matched
    // an existing entry on stable-id or name instead, reconcile the
    // existing entry to the supplied id. Otherwise the roster's
    // participantId stays stale forever, drifting away from whatever id
    // each fresh spawn happens to land on.
    if (
      body.participant.id
      && body.participant.id !== matchedParticipant.id
      && isStableIdEligibleType
    ) {
      matchedParticipant.id = body.participant.id;
    }

    // Either id change above can land on an id another record already holds
    // (e.g. a browser-user-* upgraded to user-owner-doe while that record exists).
    // Merge into one record instead of leaving a duplicate that splits unread state.
    const mergedId = matchedParticipant.id;
    const existingParticipant = dedupeParticipants(channel) > 0
      ? channel.participants.find(p => p.id === mergedId) ?? matchedParticipant
      : matchedParticipant;

    if (channel.preferredNames && channel.preferredNames[existingParticipant.id]) {
      const preferredName = channel.preferredNames[existingParticipant.id];
      if (existingParticipant.name !== preferredName) {
        existingParticipant.name = preferredName;
      }
    } else if (body.participant.name) {
      // Preserve a real name across WebGate reconnects: if the existing
      // participant already has a non-placeholder name, don't overwrite it
      // with "Browser User" from a fresh-origin join.
      const isIncomingDefault = body.participant.name === 'Browser User';
      const isExistingDefault = existingParticipant.name === 'Browser User';
      if (!isIncomingDefault || isExistingDefault) {
        existingParticipant.name = body.participant.name;
      }
    }
    const updates = body.participant;
    if (updates.type) existingParticipant.type = updates.type;
    if (updates.source) existingParticipant.source = updates.source;
    if (updates.pid) existingParticipant.pid = updates.pid;
    if (updates.projectPath) existingParticipant.projectPath = updates.projectPath;
    if (updates.sessionId) existingParticipant.sessionId = updates.sessionId;
    if (updates.deliveryProtocol === 'ledger-v1') {
      existingParticipant.deliveryProtocol = updates.deliveryProtocol;
    }
    existingParticipant.lastSeen = now;

    if (channel.roster?.agents && existingParticipant.name) {
      const rosterAgent = channel.roster.agents.find(
        (a: { name: string; participantId?: string }) =>
          a.name === existingParticipant.name &&
          a.participantId !== existingParticipant.id
      );
      if (rosterAgent) {
        rosterAgent.participantId = existingParticipant.id;
        if (existingParticipant.deliveryProtocol === 'ledger-v1') {
          rosterAgent.deliveryProtocol = existingParticipant.deliveryProtocol;
        }
      }
      const capabilityAgent = channel.roster.agents.find(
        (agent: AgentRosterEntry) => agent.name === existingParticipant.name
      );
      if (capabilityAgent && existingParticipant.deliveryProtocol === 'ledger-v1') {
        capabilityAgent.deliveryProtocol = existingParticipant.deliveryProtocol;
      }
    }

    if (existingParticipant.status === 'away') {
      existingParticipant.status = undefined;
      existingParticipant.awayInChannelId = undefined;
      existingParticipant.awayInChannelName = undefined;
    }

    // Also clear roster agent's away status (participant clear above doesn't touch roster)
    if (channel.roster?.agents) {
      const rosterAgent = channel.roster.agents.find(
        (a: AgentRosterEntry) => a.name === existingParticipant.name && a.status === 'away'
      );
      if (rosterAgent) {
        rosterAgent.status = 'running';
        rosterAgent.awayInChannelId = undefined;
        rosterAgent.awayInChannelName = undefined;
        channel.roster.lastUpdated = new Date().toISOString();
      }
    }

    if (existingParticipant.activityStatus && existingParticipant.activityStatus !== 'idle') {
      existingParticipant.activityStatus = 'idle';
      existingParticipant.activityUpdatedAt = now;
    }

    if (existingParticipant.type !== 'user') {
      markAgentAwayInOtherChannels(data, existingParticipant.name, existingParticipant.type, channel.id, channel.name, existingParticipant.projectPath);
    }

    await saveChannels(data);

    const rejoinMsgResult = await getMessagesPaginated(channel.id, { limit: 25 });
    channel.messages = rejoinMsgResult.messages;

    return NextResponse.json({
      success: true,
      channelId: channel.id,
      participantId: existingParticipant.id,
      channel,
      hasMore: rejoinMsgResult.hasMore,
      oldestTimestamp: rejoinMsgResult.oldestTimestamp,
    });
  }

  if (body.participant.pid) {
    const duplicates = channel.participants.filter(
      p => p.pid === body.participant!.pid && p.id !== body.participant!.id
    );
    if (duplicates.length > 0) {
      channel.participants = channel.participants.filter(
        p => p.pid !== body.participant!.pid || p.id === body.participant!.id
      );
    }
  }

  // New-participant creation: use stable id for terminal and non-claude
  // wrapper agents so future spawns hit the upsert path above (matched by
  // incomingStableId on line 157). Sprint Hermes-postmortem Task 3.
  const isTerminalAgent = body.participant.type?.includes('terminal');
  const useStableId = isTerminalAgent
    || (body.participant.type ? NON_CLAUDE_AGENT_TYPES.has(body.participant.type) : false);
  const participantId = body.participant.id ||
    (useStableId ? generateStableParticipantId(body.participant) : randomUUID());

  let participantName = body.participant.name;
  if (channel.preferredNames && channel.preferredNames[participantId]) {
    const preferredName = channel.preferredNames[participantId];
    participantName = preferredName;
  }

  const newParticipant: CollabParticipant = {
    ...body.participant,
    id: participantId,
    name: participantName,
    joinedAt: now,
    lastSeen: now,
    color: body.participant.color || getNextColor(channel.participants),
  };

  channel.participants.push(newParticipant);
  channel.lastActivity = now;

  if (channel.roster?.agents && newParticipant.name) {
    const rosterAgent = channel.roster.agents.find(
      (a: { name: string; participantId?: string }) =>
        a.name === newParticipant.name &&
        (!a.participantId || a.participantId.startsWith('roster-'))
    );
    if (rosterAgent) {
      const oldPlaceholderId = rosterAgent.participantId;
      rosterAgent.participantId = newParticipant.id;
      if (newParticipant.deliveryProtocol === 'ledger-v1') {
        rosterAgent.deliveryProtocol = newParticipant.deliveryProtocol;
      }
      if (oldPlaceholderId?.startsWith('roster-')) {
        const placeholderIdx = channel.participants.findIndex(
          (p: CollabParticipant) => p.id === oldPlaceholderId
        );
        if (placeholderIdx !== -1) {
          channel.participants.splice(placeholderIdx, 1);
        }
      }
    }
  }

  const joinSystemMessages: CollabMessage[] = [];

  const currentLeadExists = channel.teamLeadId &&
    channel.participants.some((p: CollabParticipant) => p.id === channel.teamLeadId);

  if (!channel.teamLeadId || !currentLeadExists) {
    const agentParticipants = channel.participants.filter(
      (p: CollabParticipant) => p.type?.includes('terminal')
    );

    if (agentParticipants.length > 0) {
      const sortedAgents = [...agentParticipants].sort(
        (a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
      );
      const newLead = sortedAgents[0];
      channel.teamLeadId = newLead.id;

      const teamLeadMessage: CollabMessage = {
        id: randomUUID(),
        channelId: channel.id,
        from: {
          id: 'system',
          type: 'user',
          name: 'System',
          source: 'DevFlow',
          joinedAt: now,
          lastSeen: now,
        },
        content: `You are the Team Lead for this channel. Set one clear outcome and concise definition of done, name one owner per workstream, and use the sprint board only when multi-person coordination benefits from it. Write tasks as outcome contracts rather than prescribed procedures. Match review and testing to real risk, and keep detailed evidence in ${PRODUCT_NAME} records. Distil decisions and outcomes for ${HUMAN_ROUTING_NAME}. Direct mentions and broadcasts are delivered to you, but acknowledgements are unnecessary; respond only with a result, decision, meaningful milestone, or genuine blocker. If queued messages conflict, the latest stop, replacement, or decision supersedes older instructions. Full guidelines: ${getDevflowHome()}/docs/WELCOME.md`,
        timestamp: new Date(Date.now() + 1).toISOString(),
        recipients: [newLead.id],
        metadata: { deliveryMode: 'targeted' },
      };
      joinSystemMessages.push(teamLeadMessage);
    }
  }

  const joinMessage: CollabMessage = {
    id: randomUUID(),
    channelId: channel.id,
    from: {
      id: 'system',
      type: 'user',
      name: 'System',
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    },
    content: `${newParticipant.name} joined the channel`,
    timestamp: now,
  };
  // A person opening a channel is not news; the notice is only for agents joining.
  if (newParticipant.type !== 'user') joinSystemMessages.push(joinMessage);

  const isGeminiAgent = newParticipant.type === 'gemini' ||
                        newParticipant.type === 'gemini-terminal' ||
                        newParticipant.type === 'gemini-powershell' ||
                        (newParticipant.name?.toLowerCase().includes('gemini'));

  if (isGeminiAgent) {
    const geminiReminder: CollabMessage = {
      id: randomUUID(),
      channelId: channel.id,
      from: {
        id: 'system',
        type: 'user',
        name: 'System',
        source: 'DevFlow',
        joinedAt: now,
        lastSeen: now,
      },
      content: `Welcome @${newParticipant.name}. A clear request from ${HUMAN_ROUTING_NAME} or the Team Lead authorises safe, in-scope work. Work autonomously toward the assigned outcome, use the ${PRODUCT_NAME} board when a shared task exists, and choose verification proportional to real risk. Do not send an acknowledgement-only reply. If several queued messages describe one evolving state, act on the latest combined state once; a newer stop or replacement supersedes older instructions. See ${getDevflowHome()}/docs/WELCOME.md for the collaboration contract.`,
      timestamp: now,
      mentions: [newParticipant.name],
    };
    joinSystemMessages.push(geminiReminder);
  }

  if (joinSystemMessages.length > 0) {
    await appendChannelMessages(channel.id, joinSystemMessages);
  }

  if (newParticipant.type !== 'user') {
    markAgentAwayInOtherChannels(data, newParticipant.name, newParticipant.type, channel.id, channel.name, newParticipant.projectPath);
  }

  await saveChannels(data);

  // Enrich participants with JSONL-mtime for frozen-detection liveness (T2.8)
  const { enrichParticipantsJsonlMtime: enrichJoin } = await import('@/lib/frozen-detection-jsonl');
  enrichJoin(channel.participants);

  eventBus.emitEvent('collab:participant', {
    channelId: channel.id,
    action: 'joined',
    participant: newParticipant,
    participants: channel.participants,
  });

  for (const sysMsg of joinSystemMessages) {
    eventBus.emitEvent('collab:message', {
      channelId: channel.id,
      message: sysMsg,
      participants: channel.participants,
    });
  }

  const joinMsgResult = await getMessagesPaginated(channel.id, { limit: 25 });
  channel.messages = joinMsgResult.messages;

  return NextResponse.json({
    success: true,
    channelId: channel.id,
    participantId,
    channel,
    teamLeadId: channel.teamLeadId,
    hasMore: joinMsgResult.hasMore,
    oldestTimestamp: joinMsgResult.oldestTimestamp,
  });
}

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

/** How a leave request reached the server, derived server-side (never from the body). */
export type LeaveCallerKind = 'token' | 'local' | 'webgate' | 'other' | 'unknown';

/**
 * One content-free line per leave decision: bounded ids and codes only, no message
 * content, credentials or request body. The caller kind helps attribute a future
 * removal (a browser tab, an agent token...) but cannot name a specific tab.
 */
function logLeave(fields: {
  channelId?: string; participantId?: string; durable: boolean; force?: unknown;
  block?: unknown; callerKind: LeaveCallerKind; outcome: string;
}) {
  console.info('[collab] leave', {
    channel_id: String(fields.channelId ?? '').slice(0, 64),
    participant_id: String(fields.participantId ?? '').slice(0, 96),
    durable_hearing_client: fields.durable,
    force: typeof fields.force === 'boolean' ? fields.force : fields.force === undefined ? null : 'invalid',
    // Only a Boolean is logged: block arrives from the request body, so any other
    // value is reduced to a code and its contents never reach the log.
    block: typeof fields.block === 'boolean' ? fields.block : fields.block === undefined ? null : 'invalid',
    caller_kind: fields.callerKind,
    outcome: fields.outcome,
  });
}

export async function handleLeave(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string,
  callerKind: LeaveCallerKind = 'unknown',
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }
  if (!body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'participantId is required' }, { status: 400 });
  }

  const channel = data.channels.find(c => c.id === body.channelId);
  if (!channel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const participantIndex = channel.participants.findIndex(p => p.id === body.participantId);
  if (participantIndex === -1) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Participant not found' }, { status: 404 });
  }

  const leavingParticipant = channel.participants[participantIndex];

  // Explicit removal is opt-in and must be a real Boolean.
  const force: unknown = (body as { force?: unknown }).force;
  const durable = isDurableHearingClientParticipant(leavingParticipant);
  if (force !== undefined && typeof force !== 'boolean') {
    logLeave({ ...body, durable, force, callerKind, outcome: 'INVALID_FORCE' });
    return NextResponse.json(
      { success: false, error: 'force must be true or false', code: 'INVALID_FIELD' },
      { status: 400 },
    ) as NextResponse<CollabChannelActionResponse>;
  }
  // The commissioned Hearing companion never heartbeats, so any idle cleanup (including
  // a browser tab still running code from before the client exemption) would remove it
  // and break every later hearing dispatch (main CMS, 8 Oct 2026 15:18:05Z). Only an
  // explicit force removes it; ordinary leaves of every other participant are unchanged.
  if (durable && force !== true) {
    logLeave({ ...body, durable, force, callerKind, outcome: 'DURABLE_PROTECTED' });
    return NextResponse.json(
      {
        success: false,
        error: 'The commissioned Hearing companion is only removed by an explicit force',
        code: 'DURABLE_PARTICIPANT_PROTECTED',
      },
      { status: 409 },
    ) as NextResponse<CollabChannelActionResponse>;
  }

  const rosterAgentEntry = channel.roster?.agents?.find(
    a => a.participantId === leavingParticipant.id || a.name === leavingParticipant.name
  );
  const isRosterAgent = !!rosterAgentEntry;
  const isTemporaryRosterAgent = rosterAgentEntry?.temporary === true;

  if (isRosterAgent && !isTemporaryRosterAgent && body.block !== true) {
    const channelForResponse = {
      ...channel,
      participants: channel.participants.filter(p => p.id !== leavingParticipant.id),
    };
    return NextResponse.json<CollabChannelActionResponse>({
      success: true,
      channel: channelForResponse,
    });
  }

  channel.participants.splice(participantIndex, 1);
  logLeave({ ...body, durable, force, callerKind, outcome: 'REMOVED' });

  if (isTemporaryRosterAgent && rosterAgentEntry && channel.roster) {
    channel.roster.agents = channel.roster.agents.filter(a => a.id !== rosterAgentEntry.id);
    channel.roster.lastUpdated = now;
  }

  // Automatic stale cleanup passes block:false — an idle service poster (cron,
  // n8n) must be able to rejoin. Explicit kicks and default leaves still block.
  if (leavingParticipant.type !== 'user' && body.block !== false) {
    if (!channel.blockedParticipantIds) channel.blockedParticipantIds = [];
    if (!channel.blockedParticipantTimestamps) channel.blockedParticipantTimestamps = {};
    const blockTs = Date.now();
    const addBlock = (entry: string) => {
      if (!channel.blockedParticipantIds!.includes(entry)) {
        channel.blockedParticipantIds!.push(entry);
        channel.blockedParticipantTimestamps![entry] = blockTs;
      }
    };
    addBlock(leavingParticipant.id);
    const stableId = generateStableParticipantId(leavingParticipant);
    if (stableId) addBlock(stableId);
    if (leavingParticipant.name) addBlock(`name:${leavingParticipant.name}`);
  }

  const leaveMessages: CollabMessage[] = [];
  leaveMessages.push({
    id: randomUUID(),
    channelId: channel.id,
    from: {
      id: 'system',
      type: 'user',
      name: 'System',
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    },
    content: `${leavingParticipant.name} left the channel`,
    timestamp: now,
  });
  channel.lastActivity = now;

  if (channel.teamLeadId === body.participantId && channel.participants.length > 0) {
    const agentParticipants = channel.participants.filter(
      (p: CollabParticipant) => p.type?.includes('terminal')
    );

    if (agentParticipants.length > 0) {
      const sortedAgents = [...agentParticipants].sort(
        (a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
      );
      const newLead = sortedAgents[0];
      channel.teamLeadId = newLead.id;

      leaveMessages.push({
        id: randomUUID(),
        channelId: channel.id,
        from: {
          id: 'system',
          type: 'user',
          name: 'System',
          source: 'DevFlow',
          joinedAt: now,
          lastSeen: now,
        },
        content: `${newLead.name} is now the Team Lead`,
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
    } else {
      channel.teamLeadId = undefined;
    }
  } else if (channel.participants.length === 0) {
    channel.teamLeadId = undefined;
  }

  await appendChannelMessages(channel.id, leaveMessages);
  await saveChannels(data);

  // Enrich participants with JSONL-mtime for frozen-detection liveness (T2.8)
  const { enrichParticipantsJsonlMtime: enrichLeave } = await import('@/lib/frozen-detection-jsonl');
  enrichLeave(channel.participants);

  eventBus.emitEvent('collab:participant', {
    channelId: channel.id,
    action: 'left',
    participant: leavingParticipant,
    participants: channel.participants,
  });

  for (const sysMsg of leaveMessages) {
    eventBus.emitEvent('collab:message', {
      channelId: channel.id,
      message: sysMsg,
      participants: channel.participants,
    });
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
  });
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function handleDelete(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }
  if (!body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'participantId is required to delete a channel' }, { status: 400 });
  }

  const channelIndex = data.channels.findIndex(c => c.id === body.channelId);
  if (channelIndex === -1) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const channel = data.channels[channelIndex];

  if (channel.protected) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'This channel is protected and cannot be deleted' }, { status: 403 });
  }

  const requestingParticipant = channel.participants.find(p => p.id === body.participantId);
  const isBrowserUser = requestingParticipant?.type === 'user' || body.participantId?.startsWith('browser-user-');
  const isOwner = !channel.ownerId || channel.ownerId === body.participantId;

  if (!isOwner && !isBrowserUser) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Only the channel owner or the system admin can delete this channel' }, { status: 403 });
  }

  const deletedChannelName = channel.name;
  const deletedChannelId = body.channelId!;

  const subChannels = data.channels.filter(c => c.parentChannelId === deletedChannelId && c.id !== deletedChannelId);
  const deletedSubChannels = subChannels.length;

  const moveMessages = async (channelId: string) => {
    const src = DataPaths.collabMessages + `/${channelId}.json`;
    const dst = archivedChannelMessageFile(channelId);
    try { await fs.rename(src, dst); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Collab] Failed to move message file during delete:', src, error);
        emitCollabError(error, 'api/collab/route:delete-archive-move', { severity: 'high', context: { channelId } });
      }
    }
    try {
      const files = await fs.readdir(DataPaths.collabMessages);
      for (const f of files) {
        if (f.startsWith(`${channelId}-archive-`)) {
          await fs.rename(
            path.join(DataPaths.collabMessages, f),
            path.join(archivedChannelMessagesDir(), f)
          ).catch(() => {});
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Collab] Failed to read messages dir during delete archive move:', error);
        emitCollabError(error, 'api/collab/route:delete-archive-readdir', { severity: 'medium', context: { channelId } });
      }
    }
  };

  if (body.permanent !== true) {
    const archivesData = await readJsonFile<ArchivedChannelsData>(
      DataPaths.collabArchivedChannels,
      { archives: [], lastUpdated: new Date().toISOString() }
    );

    const archiveEntry: ArchivedChannel = {
      id: randomUUID(),
      channel: { ...channel },
      archivedAt: new Date().toISOString(),
      archivedBy: body.participantId,
      subChannelIds: subChannels.map(s => s.id),
    };

    for (const sub of subChannels) {
      archivesData.archives.push({
        id: randomUUID(),
        channel: { ...sub },
        archivedAt: archiveEntry.archivedAt,
        archivedBy: body.participantId,
      });
    }

    archivesData.archives.push(archiveEntry);
    archivesData.lastUpdated = new Date().toISOString();

    await fs.mkdir(archivedChannelMessagesDir(), { recursive: true });
    await moveMessages(deletedChannelId);
    for (const sub of subChannels) {
      await moveMessages(sub.id);
    }

    await writeJsonFile(DataPaths.collabArchivedChannels, archivesData);
    registryOnArchived(deletedChannelId, archiveEntry.archivedAt).catch(() => {});
    for (const sub of subChannels) {
      registryOnArchived(sub.id, archiveEntry.archivedAt).catch(() => {});
    }
  } else {
    await deleteChannelMessages(deletedChannelId);
    for (const sub of subChannels) {
      await deleteChannelMessages(sub.id);
    }
    registryOnDeleted(deletedChannelId).catch(() => {});
    for (const sub of subChannels) {
      registryOnDeleted(sub.id).catch(() => {});
    }
  }

  data.channels = data.channels.filter(c =>
    c.id !== deletedChannelId && c.parentChannelId !== deletedChannelId
  );

  if (deletedSubChannels > 0) {
  }

  await saveChannels(data);

  onChannelDeleted(deletedChannelId).catch(err =>
    console.error('[Collab] Teams auto-sync delete error:', err)
  );
  onSlackChannelDeleted(deletedChannelId).catch(err =>
    console.error('[Collab] Slack auto-sync delete error:', err)
  );

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: body.channelId,
    deletedSubChannels,
  });
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

export async function handleArchive(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId || !body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId and participantId are required' }, { status: 400 });
  }

  const channelIdx = data.channels.findIndex(c => c.id === body.channelId);
  if (channelIdx === -1) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const channelToArchive = data.channels[channelIdx];

  if (channelToArchive.protected) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'This channel is protected and cannot be archived' }, { status: 403 });
  }

  const reqParticipant = channelToArchive.participants.find(p => p.id === body.participantId);
  const isBrowserUser = reqParticipant?.type === 'user' || body.participantId?.startsWith('browser-user-');
  const isOwner = !channelToArchive.ownerId || channelToArchive.ownerId === body.participantId;

  if (!isOwner && !isBrowserUser) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Only the channel owner or system admin can archive this channel' }, { status: 403 });
  }

  const subChannelsToArchive = data.channels.filter(
    c => c.parentChannelId === body.channelId && c.id !== body.channelId
  );

  const archivesData = await readJsonFile<ArchivedChannelsData>(
    DataPaths.collabArchivedChannels,
    { archives: [], lastUpdated: new Date().toISOString() }
  );

  const archiveEntry: ArchivedChannel = {
    id: randomUUID(),
    channel: { ...channelToArchive },
    archivedAt: new Date().toISOString(),
    archivedBy: body.participantId,
    subChannelIds: subChannelsToArchive.map(s => s.id),
  };

  for (const sub of subChannelsToArchive) {
    archivesData.archives.push({
      id: randomUUID(),
      channel: { ...sub },
      archivedAt: archiveEntry.archivedAt,
      archivedBy: body.participantId,
    });
  }

  archivesData.archives.push(archiveEntry);
  archivesData.lastUpdated = new Date().toISOString();

  await fs.mkdir(archivedChannelMessagesDir(), { recursive: true });

  const moveMessages = async (channelId: string) => {
    const src = DataPaths.collabMessages + `/${channelId}.json`;
    const dst = archivedChannelMessageFile(channelId);
    try {
      await fs.rename(src, dst);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Collab] Failed to move message file during archive:', src, error);
        emitCollabError(error, 'api/collab/route:archive-move', { severity: 'high', context: { channelId } });
      }
    }
    try {
      const files = await fs.readdir(DataPaths.collabMessages);
      for (const f of files) {
        if (f.startsWith(`${channelId}-archive-`)) {
          await fs.rename(
            path.join(DataPaths.collabMessages, f),
            path.join(archivedChannelMessagesDir(), f)
          ).catch(() => {});
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Collab] Failed to read messages dir during archive move:', error);
        emitCollabError(error, 'api/collab/route:archive-readdir', { severity: 'medium', context: { channelId } });
      }
    }
  };

  await moveMessages(body.channelId!);
  for (const sub of subChannelsToArchive) {
    await moveMessages(sub.id);
  }

  data.channels = data.channels.filter(
    c => c.id !== body.channelId && c.parentChannelId !== body.channelId
  );

  await Promise.all([
    saveChannels(data),
    writeJsonFile(DataPaths.collabArchivedChannels, archivesData),
  ]);


  registryOnArchived(body.channelId!, archiveEntry.archivedAt).catch(() => {});
  for (const sub of subChannelsToArchive) {
    registryOnArchived(sub.id, archiveEntry.archivedAt).catch(() => {});
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: body.channelId,
    archiveId: archiveEntry.id,
    archivedSubChannels: subChannelsToArchive.length,
  });
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export async function handleRestore(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.archiveId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'archiveId is required' }, { status: 400 });
  }

  const archivesData = await readJsonFile<ArchivedChannelsData>(
    DataPaths.collabArchivedChannels,
    { archives: [], lastUpdated: new Date().toISOString() }
  );

  const archiveEntry = archivesData.archives.find(a => a.id === body.archiveId);
  if (!archiveEntry) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Archive entry not found' }, { status: 404 });
  }

  if (data.channels.find(c => c.id === archiveEntry.channel.id)) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'A channel with this ID already exists — cannot restore' }, { status: 409 });
  }

  const subArchiveEntries = (archiveEntry.subChannelIds || [])
    .map(id => archivesData.archives.find(a => a.channel.id === id))
    .filter((a): a is ArchivedChannel => !!a);

  const restoreMessages = async (channelId: string) => {
    const src = archivedChannelMessageFile(channelId);
    const dst = DataPaths.collabMessages + `/${channelId}.json`;
    try {
      await fs.rename(src, dst);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Collab] Failed to move message file during restore:', src, error);
        emitCollabError(error, 'api/collab/route:restore-move', { severity: 'high', context: { channelId } });
      }
    }
    try {
      const files = await fs.readdir(archivedChannelMessagesDir());
      for (const f of files) {
        if (f.startsWith(`${channelId}-archive-`)) {
          await fs.rename(
            path.join(archivedChannelMessagesDir(), f),
            path.join(DataPaths.collabMessages, f)
          ).catch(() => {});
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Collab] Failed to read archived messages dir during restore:', error);
        emitCollabError(error, 'api/collab/route:restore-readdir', { severity: 'medium', context: { channelId } });
      }
    }
  };

  await restoreMessages(archiveEntry.channel.id);
  for (const sub of subArchiveEntries) {
    await restoreMessages(sub.channel.id);
  }

  data.channels.push(archiveEntry.channel);
  for (const sub of subArchiveEntries) {
    data.channels.push(sub.channel);
  }

  const restoredIds = new Set([archiveEntry.id, ...subArchiveEntries.map(a => a.id)]);
  archivesData.archives = archivesData.archives.filter(a => !restoredIds.has(a.id));
  archivesData.lastUpdated = new Date().toISOString();

  await Promise.all([
    saveChannels(data),
    writeJsonFile(DataPaths.collabArchivedChannels, archivesData),
  ]);


  registryOnRestored(archiveEntry.channel).catch(() => {});
  for (const sub of subArchiveEntries) {
    registryOnRestored(sub.channel).catch(() => {});
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: archiveEntry.channel.id,
    restoredSubChannels: subArchiveEntries.length,
  });
}

// ---------------------------------------------------------------------------
// list_archived
// ---------------------------------------------------------------------------

export async function handleListArchived(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse> {
  const archivesData = await readJsonFile<ArchivedChannelsData>(
    DataPaths.collabArchivedChannels,
    { archives: [], lastUpdated: new Date().toISOString() }
  );

  const topLevel = archivesData.archives.filter(
    a => !a.channel.parentChannelId || body.includeSubChannels
  );

  return NextResponse.json({
    success: true,
    archives: topLevel.map(a => ({
      id: a.id,
      channelId: a.channel.id,
      name: a.channel.name,
      description: a.channel.description,
      archivedAt: a.archivedAt,
      archivedBy: a.archivedBy,
      participantCount: a.channel.participants?.length ?? 0,
      hasRoster: (a.channel.roster?.agents?.length ?? 0) > 0,
      rosterCount: a.channel.roster?.agents?.length ?? 0,
      subChannelCount: (a.subChannelIds ?? []).length,
    })),
    total: topLevel.length,
  });
}

// ---------------------------------------------------------------------------
// permanently_delete
// ---------------------------------------------------------------------------

export async function handlePermanentlyDelete(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.archiveId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'archiveId is required' }, { status: 400 });
  }

  const archivesData = await readJsonFile<ArchivedChannelsData>(
    DataPaths.collabArchivedChannels,
    { archives: [], lastUpdated: new Date().toISOString() }
  );

  const archiveEntry = archivesData.archives.find(a => a.id === body.archiveId);
  if (!archiveEntry) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Archive entry not found' }, { status: 404 });
  }

  const subArchiveIds = new Set([
    archiveEntry.id,
    ...(archiveEntry.subChannelIds || []).flatMap(subChannelId =>
      archivesData.archives
        .filter(a => a.channel.id === subChannelId)
        .map(a => a.id)
    ),
  ]);

  const channelIdsToDelete = [
    archiveEntry.channel.id,
    ...(archiveEntry.subChannelIds || []),
  ];

  for (const channelId of channelIdsToDelete) {
    const msgFile = archivedChannelMessageFile(channelId);
    await fs.unlink(msgFile).catch(() => {});
    try {
      const files = await fs.readdir(archivedChannelMessagesDir());
      for (const f of files) {
        if (f.startsWith(`${channelId}-archive-`)) {
          await fs.unlink(path.join(archivedChannelMessagesDir(), f)).catch(() => {});
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[Collab] Failed to read archived messages dir during purge:', error);
        emitCollabError(error, 'api/collab/route:purge-readdir', { severity: 'low', context: { channelId } });
      }
    }
  }

  archivesData.archives = archivesData.archives.filter(a => !subArchiveIds.has(a.id));
  archivesData.lastUpdated = new Date().toISOString();
  await writeJsonFile(DataPaths.collabArchivedChannels, archivesData);


  registryOnDeleted(archiveEntry.channel.id).catch(() => {});
  for (const subId of (archiveEntry.subChannelIds || [])) {
    registryOnDeleted(subId).catch(() => {});
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: archiveEntry.channel.id,
    archiveId: body.archiveId,
  });
}
