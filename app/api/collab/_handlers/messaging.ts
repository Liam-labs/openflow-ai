/**
 * Message action handlers: message, react, pin, edit, delete_message, recall.
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import path from 'path';
import type {
  CollabChannel,
  CollabChannelsData,
  CollabChannelActionRequest,
  CollabChannelActionResponse,
  CollabParticipant,
  CollabMessage,
  AgentRosterEntry,
  CrossChannelCopyResult,
} from '@/lib/types';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import type { ResolvedWebGateIdentity } from '@/lib/webgate-identity';
import { eventBus } from '@/lib/event-bus';
import {
  appendMessage as appendChannelMessage,
  appendMessageIfAbsent as appendChannelMessageIfAbsent,
  appendMessages as appendChannelMessages,
  findMessage,
  findRecentDuplicate,
  updateMessage,
  deleteMessage as deleteChannelMessage,
  archiveOldMessages,
} from '@/lib/collab-message-io';
import {
  deliverMessage,
  computeRecipients,
  readRolesData,
} from '@/lib/collab-delivery';
import {
  enqueueDurableDeliveries,
  prepareDurableDelivery,
} from '@/lib/collab-delivery-ledger';
import { handleAskOwnerMessage } from '@/lib/ask-owner/route';
import { handleDesignReferenceMessage } from '@/lib/design-references/route';
import { isDesignReferenceMetadataKind } from '@/lib/design-references/types';
import { resolveAttachmentReferences } from '@/lib/collab-attachment-references';
import { forwardToTeams } from '@/teams-integration/lib/teams-bridge';
import { isTeamsConfigured } from '@/teams-integration/lib/teams-auth';
import { forwardToSlack } from '@/slack-integration/lib/slack-bridge';
import { isSlackConfigured } from '@/slack-integration/lib/slack-auth';
import { parseAtMentions } from '@/lib/collab-utils';
import { findOfflineMentions, postOfflineMentionNotice, type OfflineMention } from '@/lib/collab-offline-mention-notice';
import { spawnCollabAgentSmart } from '@/lib/claude-session';
import {
  markAgentAwayInOtherChannels,
  invalidateUnreadCache,
  computePresenceStatus,
  withTimeout,
  saveFileToDisk,
  MAX_FILES_PER_MESSAGE,
} from '../_collab-shared';
import { processInviteSlashCommand } from '@/lib/invite-slash-handler';
import {
  VoiceTurnConflictError,
  validateVoiceReplyContext,
  voiceResponseMessageId,
} from '@/lib/voice/turn-control';
import { appPath } from '@/lib/app-paths';
import { selfOrigin } from '@/lib/self-origin';

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

export async function handleMessage(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string,
  resolvedIdentity: ResolvedWebGateIdentity | null = null,
  alsoSentTo?: CrossChannelCopyResult,
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }
  if (!body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'participantId is required' }, { status: 400 });
  }
  if (!body.content && !body.image) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'content or image is required' }, { status: 400 });
  }
  if (body.voiceResponseContext && body.silent) {
    return NextResponse.json<CollabChannelActionResponse>(
      { success: false, error: 'Voice-correlated responses cannot be silent' },
      { status: 400 },
    );
  }
  if (body.content && body.content.length > 100_000) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Message content too large (max 100KB)' }, { status: 413 });
  }

  const channel = data.channels.find(c => c.id === body.channelId);
  if (!channel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  let participant = channel.participants.find(p => p.id === body.participantId);

  if (!participant) {
    let foreignParticipant: CollabParticipant | undefined;
    let resolvedName: string | undefined;
    let resolvedColor: string | undefined;
    let resolvedSource: string | undefined;
    for (const ch of data.channels) {
      if (ch.id === channel.id) continue;
      const match = ch.participants.find(p => p.id === body.participantId);
      if (match) {
        foreignParticipant = match;
        resolvedName = match.name;
        resolvedColor = match.color;
        resolvedSource = match.source;
        break;
      }
    }
    if (resolvedName && foreignParticipant?.projectPath) {
      const isAgentType = (t?: string) => t?.includes('terminal') || t === 'claude' || t === 'agent';
      participant = channel.participants.find(p =>
        p.name === resolvedName
        && isAgentType(p.type)
        && p.projectPath === foreignParticipant!.projectPath
      );
    }

    // browser-user-{timestamp} IDs are minted client-side per origin, so a
    // WebGate session (different origin) lands with a fresh ID that won't
    // match the existing browser-user record. Rather than creating a duplicate
    // participant, find and reuse the existing one (same pattern as
    // handleMarkRead). Only mint a new participant if no browser user exists
    // in this channel at all.
    //
    // Also covers `user-*` canonical IDs from webgate JWT resolution — when a
    // canonical participant message lands in a channel where the participant
    // hasn't been added yet, mint them in line with resolvedIdentity instead
    // of 404-ing. 2026-05-18 fix for "first message in new channel from
    // canonical webgate identity drops".
    const isBrowserOrCanonicalUser =
      body.participantId.startsWith('browser-user-') ||
      (resolvedIdentity && body.participantId === resolvedIdentity.canonicalParticipantId);
    if (!participant && isBrowserOrCanonicalUser) {
      // When webgate identity is resolved, prefer the canonical participant
      // over a generic browser-user-* match. If the canonical user already
      // exists (upgraded by handleJoin), use them. If only a legacy
      // browser-user-{ts} exists, upgrade their ID to canonical.
      if (resolvedIdentity) {
        participant = channel.participants.find(
          p => p.id === resolvedIdentity.canonicalParticipantId
        );
        if (participant) {
          // Canonical exists — keep its name in sync with the override map so
          // changes to webgate-identity-map.json apply to existing participants
          // without a manual rename. 2026-05-18: previously a stale derived name
          // ("owner-doe") persisted after the override was added.
          if (participant.name !== resolvedIdentity.canonicalName) {
            participant.name = resolvedIdentity.canonicalName;
          }
        } else {
          // Canonical not yet in channel — look for legacy browser-user to upgrade
          participant = channel.participants.find(
            p => p.id.startsWith('browser-user-') && p.type === 'user'
          );
          if (participant) {
            participant.id = resolvedIdentity.canonicalParticipantId;
            participant.name = resolvedIdentity.canonicalName;
          }
        }
      } else {
        // Find any existing browser-user in this channel — same pattern as
        // handleMarkRead. Avoids creating a duplicate participant when the
        // client-side browser-user-{ts} ID changes across origins/sessions.
        participant = channel.participants.find(
          p => p.id.startsWith('browser-user-') && p.type === 'user'
        );
      }
      if (!participant) {
        participant = {
          id: resolvedIdentity?.canonicalParticipantId || body.participantId,
          type: 'user',
          name: resolvedName || resolvedIdentity?.canonicalName || 'Browser User',
          source: resolvedSource || 'DevFlow Browser',
          joinedAt: now,
          lastSeen: now,
          color: resolvedColor || '#8B5CF6',
        };
        channel.participants.push(participant);
      }
    }
  }

  if (!participant) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Participant not found in channel' }, { status: 404 });
  }

  participant.lastSeen = now;
  if (participant.status === 'away') {
    participant.status = undefined;
    participant.awayInChannelId = undefined;
    participant.awayInChannelName = undefined;
  }

  // Also clear roster agent's away status (participant clear above doesn't touch roster)
  if (channel.roster?.agents) {
    const rosterAgent = channel.roster.agents.find(
      (a: AgentRosterEntry) => a.name === participant.name && a.status === 'away'
    );
    if (rosterAgent) {
      rosterAgent.status = 'running';
      rosterAgent.awayInChannelId = undefined;
      rosterAgent.awayInChannelName = undefined;
      channel.roster.lastUpdated = new Date().toISOString();
    }
  }

  if (participant.type !== 'user') {
    markAgentAwayInOtherChannels(data, participant.name, participant.type, channel.id, channel.name, participant.projectPath);
  }

  let messageId: string;
  try {
    messageId = body.voiceResponseContext
      ? voiceResponseMessageId({
          participantId: participant.id,
          content: body.content || '',
          context: body.voiceResponseContext,
        })
      : randomUUID();
  } catch (error) {
    if (error instanceof VoiceTurnConflictError) {
      return NextResponse.json<CollabChannelActionResponse>(
        { success: false, error: error.message },
        { status: error.statusCode },
      );
    }
    throw error;
  }
  let validatedVoiceReply: Awaited<ReturnType<typeof validateVoiceReplyContext>> | undefined;
  if (body.voiceResponseContext) {
    try {
      validatedVoiceReply = await validateVoiceReplyContext({
        channelId: channel.id,
        participantId: participant.id,
        context: body.voiceResponseContext,
      });
    } catch (error) {
      if (error instanceof VoiceTurnConflictError) {
        return NextResponse.json<CollabChannelActionResponse>(
          { success: false, error: error.message },
          { status: error.statusCode },
        );
      }
      throw error;
    }
  }

  let enrichedReplyTo: CollabMessage['replyTo'] = undefined;
  const replyToMessageId = validatedVoiceReply?.replyTo || body.replyTo;
  if (replyToMessageId) {
    const originalMessage = await withTimeout(findMessage(channel.id, replyToMessageId), 5000);
    if (originalMessage) {
      enrichedReplyTo = {
        id: originalMessage.id,
        from: originalMessage.from,
        content: originalMessage.content?.slice(0, 150),
      };
    }
  }

  const roles = await readRolesData();
  const recipients = computeRecipients(body.content || '', body.participantId, channel, roles);
  const deliveryMode: 'targeted' | 'broadcast' = recipients ? 'targeted' : 'broadcast';

  const parsedMentions = parseAtMentions(body.content || '', channel.participants, channel.roster?.agents, roles);
  const mentions = parsedMentions.length > 0 ? parsedMentions : body.mentions;

  let processedImages: CollabMessage['images'] = body.images;
  let processedImage: CollabMessage['image'] = body.image;
  const imageUrls: string[] = [];
  let resolvedContent = body.content || '';

  if (body.images && body.images.length > 0) {
    const filesToProcess = body.images.slice(0, MAX_FILES_PER_MESSAGE);
    const results = await Promise.all(
      filesToProcess.map(async (img, idx) => {
        const saved = await saveFileToDisk(img.data, messageId, idx, img.name);
        if (saved) {
          return {
            processed: { data: '', name: img.name, type: img.type, size: img.size, url: saved.url },
            reference: { clientId: img.clientId, url: saved.url },
          };
        }
        return {
          processed: img,
          reference: { clientId: img.clientId },
        };
      })
    );
    processedImages = results.map(result => result.processed);
    imageUrls.push(...results.flatMap(result => result.reference.url ? [result.reference.url] : []));
    resolvedContent = resolveAttachmentReferences(
      resolvedContent,
      results.map(result => result.reference),
    );
  } else if (body.image) {
    const saved = await saveFileToDisk(body.image.data, messageId, 0, body.image.name);
    if (saved) {
      imageUrls.push(saved.url);
      processedImage = { data: '', name: body.image.name, type: body.image.type, url: saved.url };
    }
  }

  const silent = body.silent === true;

  // Offline @mentions: decided here, before computePresenceStatus() below
  // rewrites participant.status; the sender is told after delivery.
  let offlineMentions: OfflineMention[] = [];
  try {
    offlineMentions = findOfflineMentions({
      channel,
      data,
      sender: participant,
      message: { silent, metadata: body.metadata as CollabMessage['metadata'] },
      recipients,
    });
  } catch (err) {
    console.error('[Collab] Offline-mention check failed:', err);
  }

  const clientMetadata = { ...(body.metadata || {}) };
  delete clientMetadata.voice;
  // Server-owned routing records; a browser must not be able to forge them.
  delete clientMetadata.alsoSentTo;
  delete clientMetadata.crossChannel;
  let newMessage: CollabMessage = {
    id: messageId,
    channelId: channel.id,
    from: participant,
    content: resolvedContent,
    timestamp: now,
    mentions,
    recipients,
    replyTo: enrichedReplyTo,
    image: processedImage,
    images: processedImages,
    ...(silent && { silent: true }),
    metadata: {
      ...clientMetadata,
      // collab_helper --hidden uses the top-level flag, like the Agent API.
      ...(body.isHidden === true && { isHidden: true }),
      deliveryMode,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      ...(validatedVoiceReply && { voice: validatedVoiceReply.voice }),
      ...(alsoSentTo && { alsoSentTo }),
    },
  };

  // Dedup: defend against model double-invocation (agent shell-execs
  // collab_helper.py mid-reasoning AND wrapper posts stdout afterward —
  // two HTTP requests with identical content ~2s apart). Content-keyed
  // within a 10s window, same pattern as Ask-owner T1.4 dedup.
  if (resolvedContent && participant.id && !body.voiceResponseContext) {
    const duplicate = await findRecentDuplicate(channel.id, participant.id, resolvedContent);
    if (duplicate) {
      prepareDurableDelivery(body.participantId, duplicate, channel);
      try {
        await enqueueDurableDeliveries(body.participantId, duplicate, channel);
      } catch (error) {
        console.error('[Collab] Failed to recover durable delivery for duplicate message:', error);
        return NextResponse.json<CollabChannelActionResponse>(
          { success: false, error: 'Message stored but durable delivery is temporarily unavailable' },
          { status: 503 },
        );
      }
      return NextResponse.json<CollabChannelActionResponse>({
        success: true,
        deduplicated: true,
        message: { id: duplicate.id },
      });
    }
  }

  // Ask-owner (T1.3): record structured questions / route the owner's answers off
  // metadata.client. Runs before append + deliver so the answer reshape
  // (recipients/content/isHidden) reaches both storage and the existing delivery
  // flow. Guarded — an ask-owner failure must never break normal messaging.
  try {
    await handleAskOwnerMessage(newMessage, {
      humanRecipientIds: channel.participants
        .filter(candidate => candidate.type === 'user')
        .map(candidate => candidate.id),
    });
  } catch (err) {
    console.error('[AskOwner] routing error:', err);
  }

  // Visual reference boards use their own additive metadata.client contract:
  // boards target human viewers; validated selections route back to the agent
  // that created the board. Invalid structured payloads fail before persistence.
  try {
    const result = await handleDesignReferenceMessage(newMessage, {
      humanRecipientIds: channel.participants
        .filter(candidate => candidate.type === 'user')
        .map(candidate => candidate.id),
    });
    if (result.kind === 'invalid') {
      return NextResponse.json<CollabChannelActionResponse>(
        { success: false, error: `Invalid design reference payload: ${result.error}` },
        { status: 400 },
      );
    }
    if (result.kind === 'selection' && result.deduplicated) {
      return NextResponse.json<CollabChannelActionResponse>({
        success: true,
        deduplicated: true,
        message: { id: newMessage.id },
      });
    }
  } catch (err) {
    console.error('[DesignReferences] routing error:', err);
    if (isDesignReferenceMetadataKind(newMessage.metadata?.client)) {
      return NextResponse.json<CollabChannelActionResponse>(
        { success: false, error: 'Design reference routing is temporarily unavailable' },
        { status: 503 },
      );
    }
  }

  // Reserve the single correlated response immediately before persistence.
  // This is the authoritative cancel-vs-reply fence: whichever ledger
  // mutation wins makes the other return 409 without appending a stale reply.
  if (body.voiceResponseContext) {
    try {
      await validateVoiceReplyContext({
        channelId: channel.id,
        participantId: participant.id,
        context: body.voiceResponseContext,
        responseMessageId: messageId,
      });
    } catch (error) {
      if (error instanceof VoiceTurnConflictError) {
        return NextResponse.json<CollabChannelActionResponse>(
          { success: false, error: error.message },
          { status: error.statusCode },
        );
      }
      throw error;
    }
  }

  // Tag before canonical append so SSE and catch-up polling know they are
  // wake-up paths only. The durable record itself is persisted before SSE.
  if (!silent) {
    prepareDurableDelivery(body.participantId, newMessage, channel);
  }

  let correlatedVoiceAppended = true;
  if (silent) {
    const { appendSilentMessage } = await import('@/lib/collab-message-io');
    await appendSilentMessage(channel.id, newMessage);
  } else if (body.voiceResponseContext) {
    const persisted = await appendChannelMessageIfAbsent(channel.id, newMessage);
    const existingVoice = persisted.message.metadata?.voice;
    const candidateVoice = newMessage.metadata?.voice;
    const exactRetry = persisted.message.id === newMessage.id
      && persisted.message.channelId === newMessage.channelId
      && persisted.message.from.id === newMessage.from.id
      && persisted.message.content === newMessage.content
      && persisted.message.replyTo?.id === newMessage.replyTo?.id
      && existingVoice?.kind === 'riley.voice.response'
      && candidateVoice?.kind === 'riley.voice.response'
      && existingVoice.conversationSessionId === candidateVoice.conversationSessionId
      && existingVoice.audioTurnId === candidateVoice.audioTurnId
      && existingVoice.revision === candidateVoice.revision
      && existingVoice.inReplyToMessageId === candidateVoice.inReplyToMessageId;
    if (!exactRetry) {
      return NextResponse.json<CollabChannelActionResponse>(
        { success: false, error: 'Correlated response identity is bound to a different message' },
        { status: 409 },
      );
    }
    correlatedVoiceAppended = persisted.appended;
    newMessage = persisted.message;
    if (persisted.appended) {
      await archiveOldMessages(channel.id);
    }
  } else {
    await appendChannelMessage(channel.id, newMessage);
    await archiveOldMessages(channel.id);
  }
  if (!silent && (!body.voiceResponseContext || correlatedVoiceAppended)) {
    invalidateUnreadCache(channel.id);
  }

  if (!silent) {
    try {
      await enqueueDurableDeliveries(body.participantId, newMessage, channel);
    } catch (error) {
      // The canonical message is already stored. Returning 503 makes a client
      // retry safe: the content dedup branch above idempotently recreates any
      // missing ledger record before reporting success.
      console.error('[Collab] Durable delivery ledger write failed:', error);
      return NextResponse.json<CollabChannelActionResponse>(
        { success: false, error: 'Message stored but durable delivery is temporarily unavailable' },
        { status: 503 },
      );
    }
  }

  // A stable-ID retry may be repairing append -> enqueue failure. Only report
  // success after the persisted message has idempotently recreated delivery;
  // never re-emit or bridge an already visible response.
  if (body.voiceResponseContext && !correlatedVoiceAppended) {
    return NextResponse.json<CollabChannelActionResponse>({
      success: true,
      channelId: channel.id,
      messageId: newMessage.id,
      deduplicated: true,
      message: { id: newMessage.id },
    });
  }

  channel.lastActivity = now;
  computePresenceStatus(channel);

  // Enrich participants with JSONL-mtime for frozen-detection liveness (T2.8)
  const { enrichParticipantsJsonlMtime } = await import('@/lib/frozen-detection-jsonl');
  enrichParticipantsJsonlMtime(channel.participants);

  eventBus.emitEvent('collab:message', {
    channelId: channel.id,
    message: newMessage,
    participants: channel.participants,
  });

  // Awaited inside the lock on purpose: a write started here and left running would land after
  // the lock is released and could overwrite a newer writer's change.
  await saveChannels(data);

  if (!silent && resolvedContent) {
    processInviteSlashCommand(resolvedContent, participant.name, channel).catch(
      err => console.error('[Collab] Invite slash command error:', err)
    );
  }

  if (!silent) {
    deliverMessage(body.participantId as string, newMessage, channel);

    if (offlineMentions.length > 0) {
      await postOfflineMentionNotice({
        channel,
        sender: participant,
        offline: offlineMentions,
        hidden: newMessage.metadata?.isHidden === true,
      });
    }

    const senderInfo: { color?: string; type?: string; roleName?: string } = {
      color: participant.color,
      type: participant.type,
    };
    if (channel.roster?.agents) {
      const rosterEntry = channel.roster.agents.find(
        (a) => a.participantId === participant!.id
      );
      if (rosterEntry?.roleId) {
        try {
          const rolesPath = appPath('data', 'roles', 'roles.json');
          const rolesRaw = await withTimeout(fs.readFile(rolesPath, 'utf-8'), 5000);
          if (rolesRaw) {
            const rolesData = JSON.parse(rolesRaw) as { roles: Array<{ id: string; name: string }> };
            const role = rolesData.roles?.find((r) => r.id === rosterEntry.roleId);
            if (role) senderInfo.roleName = role.name;
          }
        } catch { /* roles lookup is best-effort */ }
      }
    }

    if (isTeamsConfigured()) {
      forwardToTeams(
        channel.id,
        participant.name,
        resolvedContent,
        messageId,
        newMessage.metadata,
        senderInfo
      ).catch(err => console.error('[Collab] Teams bridge forwarding error:', err));
    }

    if (isSlackConfigured()) {
      forwardToSlack(
        channel.id,
        participant.name,
        resolvedContent,
        messageId,
        newMessage.metadata,
        senderInfo,
        newMessage.images as Array<{ data: string; name: string; type: string }> | undefined
      ).catch(err => console.error('[Collab] Slack bridge forwarding error:', err));
    }
  }

  // Auto-respond DISABLED
  const autoRespondEnabled = false;
  if (
    autoRespondEnabled &&
    channel.settings.autoRespond &&
    (participant.type === 'claude-terminal' || participant.type === 'user')
  ) {
    const { emitter, agentName, agentColor } = spawnCollabAgentSmart({
      channelName: channel.name,
      triggerMessage: body.content,
      conversationHistory: [],
      participants: channel.participants,
      agentName: channel.settings.respondingAgentName,
    });

    let responseContent = '';
    emitter.on('data', (chunk: string) => { responseContent += chunk; });
    emitter.on('end', async () => {
      if (responseContent.trim()) {
        await mutateChannels('collab-api:auto-respond', async freshData => {
          const freshChannel = freshData.channels.find(c => c.id === body.channelId);
          if (freshChannel) {
            const agentParticipantId = `browser-agent-${agentName.toLowerCase().replace(/\s+/g, '-')}`;
            const responseMessage: CollabMessage = {
              id: randomUUID(),
              channelId: freshChannel.id,
              from: {
                id: agentParticipantId,
                type: 'claude-browser',
                name: agentName,
                source: 'DevFlow Browser',
                joinedAt: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                color: agentColor,
              },
              content: responseContent.trim(),
              timestamp: new Date().toISOString(),
              metadata: {
                triggeredBy: messageId,
                isAutoResponse: true,
                agentContext: `Auto-spawned to respond to message from ${participant!.name}`,
              },
            };
            await appendChannelMessages(freshChannel.id, [responseMessage]);
            freshChannel.lastActivity = new Date().toISOString();
            await saveChannels(freshData);
          }
        });
      }
    });
    emitter.on('error', (err: Error) => {
      console.error(`Auto-response agent (${agentName}) error:`, err.message);
    });
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
    messageId,
  });
}

// ---------------------------------------------------------------------------
// react
// ---------------------------------------------------------------------------

export async function handleReact(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId || !body.messageId || !body.participantId || !body.emoji) {
    return NextResponse.json<CollabChannelActionResponse>({
      success: false,
      error: 'channelId, messageId, participantId, and emoji are required',
    }, { status: 400 });
  }

  const channelIndex = data.channels.findIndex((c: CollabChannel) => c.id === body.channelId);
  if (channelIndex === -1) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const channel = data.channels[channelIndex];
  const emoji = body.emoji;
  const participantIdForReact = body.participantId;

  const reactUpdated = await updateMessage(channel.id, body.messageId as string, (message) => {
    if (!message.reactions) message.reactions = {};
    if (!message.reactions[emoji as string]) message.reactions[emoji as string] = [];

    const reactionIndex = message.reactions[emoji as string].indexOf(participantIdForReact as string);
    if (reactionIndex === -1) {
      message.reactions[emoji as string].push(participantIdForReact as string);
    } else {
      message.reactions[emoji as string].splice(reactionIndex, 1);
      if (message.reactions[emoji as string].length === 0) {
        delete message.reactions[emoji as string];
      }
    }
  });

  if (!reactUpdated) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Message not found' }, { status: 404 });
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
    messageId: body.messageId,
  });
}

// ---------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------

export async function handlePin(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId || !body.messageId || !body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({
      success: false,
      error: 'channelId, messageId, and participantId are required',
    }, { status: 400 });
  }

  const channelIndex = data.channels.findIndex((c: CollabChannel) => c.id === body.channelId);
  if (channelIndex === -1) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const channel = data.channels[channelIndex];

  const pinUpdated = await updateMessage(channel.id, body.messageId as string, (message) => {
    if (message.pinnedAt) {
      delete message.pinnedAt;
      delete message.pinnedBy;
    } else {
      message.pinnedAt = new Date().toISOString();
      message.pinnedBy = body.participantId;
    }
  });

  if (!pinUpdated) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Message not found' }, { status: 404 });
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
    messageId: body.messageId,
  });
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export async function handleEdit(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId || !body.messageId || !body.participantId || !body.content) {
    return NextResponse.json<CollabChannelActionResponse>({
      success: false,
      error: 'channelId, messageId, participantId, and content are required',
    }, { status: 400 });
  }

  const channelIndex = data.channels.findIndex((c: CollabChannel) => c.id === body.channelId);
  if (channelIndex === -1) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const channel = data.channels[channelIndex];

  const editMsg = await findMessage(channel.id, body.messageId as string);
  if (!editMsg) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Message not found' }, { status: 404 });
  }

  if (editMsg.from.id !== body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Can only edit your own messages' }, { status: 403 });
  }

  await updateMessage(channel.id, body.messageId as string, (msg) => {
    msg.content = body.content as string;
    msg.editedAt = new Date().toISOString();
  });

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
    messageId: body.messageId,
  });
}

// ---------------------------------------------------------------------------
// delete_message
// ---------------------------------------------------------------------------

export async function handleDeleteMessage(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId || !body.messageId || !body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({
      success: false,
      error: 'channelId, messageId, and participantId are required',
    }, { status: 400 });
  }

  const channelIndex = data.channels.findIndex((c: CollabChannel) => c.id === body.channelId);
  if (channelIndex === -1) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const channel = data.channels[channelIndex];

  const delMsg = await findMessage(channel.id, body.messageId as string);
  if (!delMsg) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Message not found' }, { status: 404 });
  }

  if (delMsg.from.id !== body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Can only delete your own messages' }, { status: 403 });
  }

  await deleteChannelMessage(channel.id, body.messageId as string);

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
    messageId: body.messageId,
  });
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export async function handleRecall(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }
  if (!body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'participantId is required (the agent to recall)' }, { status: 400 });
  }

  const homeChannel = data.channels.find(c => c.id === body.channelId);
  if (!homeChannel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Home channel not found' }, { status: 404 });
  }

  const awayParticipant = homeChannel.participants.find(p => p.id === body.participantId);
  if (!awayParticipant) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Participant not found in home channel' }, { status: 404 });
  }

  if (awayParticipant.status !== 'away' || !awayParticipant.awayInChannelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Participant is not away in another channel' }, { status: 400 });
  }

  const foreignChannelId = awayParticipant.awayInChannelId;
  const foreignChannel = data.channels.find(c => c.id === foreignChannelId);

  if (foreignChannel) {
    const foreignIdx = foreignChannel.participants.findIndex(
      (p: CollabParticipant) => p.name === awayParticipant.name
    );
    if (foreignIdx !== -1) {
      foreignChannel.participants.splice(foreignIdx, 1);
    }
  }

  awayParticipant.status = undefined;
  awayParticipant.awayInChannelId = undefined;
  awayParticipant.awayInChannelName = undefined;
  awayParticipant.lastSeen = now;
  awayParticipant.activityStatus = 'idle';
  awayParticipant.activityUpdatedAt = now;

  const rosterAgent = homeChannel.roster?.agents?.find(
    (a: AgentRosterEntry) => a.participantId === awayParticipant.id || a.name === awayParticipant.name
  );

  if (rosterAgent) {
    if (rosterAgent.tmuxSessionName) {
      try {
        await execFileAsync('tmux', ['kill-session', '-t', rosterAgent.tmuxSessionName]);
      } catch {
        // Session may already be dead
      }
    }

    rosterAgent.status = 'stopped';
    rosterAgent.pid = undefined;
    rosterAgent.tmuxSessionName = undefined;
    rosterAgent.awayInChannelId = undefined;
    rosterAgent.awayInChannelName = undefined;
  }

  await saveChannels(data);

  if (rosterAgent) {
    fetch(`${selfOrigin()}/api/collab/pty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'roster_respawn',
        channelId: homeChannel.id,
        agentId: rosterAgent.id,
      }),
    }).catch(err => {
      console.error(`[Collab] Recall respawn failed for ${awayParticipant.name}:`, err.message);
    });
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: homeChannel.id,
    channel: homeChannel,
  });
}
