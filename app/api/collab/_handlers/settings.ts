/**
 * Channel settings handlers: update_settings, mark_read, heartbeat, rename,
 * create_subchannel, reparent, rename_participant.
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import type {
  CollabChannel,
  CollabChannelsData,
  CollabChannelActionRequest,
  CollabChannelActionResponse,
  CollabParticipant,
  CollabMessage,
} from '@/lib/types';
import { saveChannels } from '@/lib/collab-channel-store';
import { eventBus } from '@/lib/event-bus';
import { clearRosterAwayForSeat, dedupeParticipants, reconcileParticipantWithRoster } from '@/lib/collab-participants';
import { createGroup, hasChannelGroups, resolveChannelGroups } from '@/lib/collab-groups';
import { prepareNewChannelTab, resolveChannelTabs } from '@/lib/collab-sidebar-logic';
import {
  appendMessage as appendChannelMessage,
  appendMessages as appendChannelMessages,
  readChannelMessages,
} from '@/lib/collab-message-io';
import { onChannelCreated as onTeamsChannelCreated, onChannelRenamed } from '@/teams-integration/lib/teams-auto-sync';
import {
  onChannelCreated as onSlackChannelCreated,
  onChannelRenamed as onSlackChannelRenamed,
} from '@/slack-integration/lib/slack-auto-sync';
import {
  onChannelUpdated as registryOnUpdated,
} from '@/lib/channels-registry';
import {
  invalidateUnreadCache,
} from '../_collab-shared';
import {
  renameChannelProjectDirectory,
  rewriteChannelProjectPaths,
} from '@/lib/channel-project-rename';

// ---------------------------------------------------------------------------
// update_settings
// ---------------------------------------------------------------------------

export async function handleUpdateSettings(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }

  const channel = data.channels.find(c => c.id === body.channelId);
  if (!channel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  if (body.participantId && !channel.participants.some((p: CollabParticipant) => p.id === body.participantId)) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Not a member of this channel' }, { status: 403 });
  }

  if (body.settings) {
    channel.settings = { ...channel.settings, ...body.settings };
  }

  if (body.category !== undefined) {
    if (!resolveChannelGroups(data).some(g => g.id === body.category)) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Unknown group' }, { status: 400 });
    }
    channel.settings = { ...channel.settings, category: body.category };
  }

  if (body.pinned !== undefined) {
    channel.pinnedAt = body.pinned ? now : undefined;
  }

  if (body.projectPath !== undefined) {
    channel.projectPath = body.projectPath || undefined;
  }

  if (body.projectId !== undefined) {
    channel.projectId = body.projectId || undefined;
  }

  if (body.teamLeadId) {
    const newLeadParticipant = channel.participants.find(
      (p: CollabParticipant) => p.id === body.teamLeadId
    );
    if (!newLeadParticipant) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Team Lead must be a channel participant' }, { status: 400 });
    }
    // Every participant type except `user` is an agent. Restricting this to
    // `*terminal` silently excluded Codex, Grok, browser Claude, and
    // non-terminal Gemini/Claude agents even though the UI treats them as agents.
    if (newLeadParticipant.type === 'user') {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Only agents can be Team Lead, not users' }, { status: 400 });
    }
    channel.teamLeadId = body.teamLeadId;
  }

  channel.lastActivity = now;
  await saveChannels(data);

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
    channel,
  });
}

// ---------------------------------------------------------------------------
// mark_read
// ---------------------------------------------------------------------------

export async function handleMarkRead(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
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

  // A duplicate id would leave mark_read and the unread count on different records.
  dedupeParticipants(channel);
  let participant = channel.participants.find(p => p.id === body.participantId);
  // Normalize stale browser-user IDs: if requested ID isn't found but is a
  // browser-user-*, find any existing browser-user participant and adopt their
  // record (updates ID so future lookups match the current browser session).
  if (!participant && body.participantId?.startsWith('browser-user-')) {
    participant = channel.participants.find(p => p.id.startsWith('browser-user-'));
    if (participant) {
      participant.id = body.participantId;
    }
  }
  if (!participant) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Participant not found' }, { status: 404 });
  }

  if (body.messageTimestamp && typeof body.messageTimestamp === 'string') {
    const requestedTime = new Date(body.messageTimestamp).getTime();
    const currentLastRead = participant.lastRead ? new Date(participant.lastRead).getTime() : 0;
    if (requestedTime > currentLastRead) {
      participant.lastRead = body.messageTimestamp;
    }
  } else {
    const msgData = await readChannelMessages(channel.id);
    const visibleMessages = msgData.messages.filter(m => {
      if (!m.recipients) return true;
      return m.recipients.includes(participant.id);
    });
    if (visibleMessages.length > 0) {
      const lastVisibleMsg = visibleMessages[visibleMessages.length - 1];
      participant.lastRead = lastVisibleMsg.timestamp;
    } else {
      participant.lastRead = now;
    }
  }
  participant.lastSeen = now;

  await saveChannels(data);
  invalidateUnreadCache(channel.id);

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
  });
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

export async function handleHeartbeat(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
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

  const participant = channel.participants.find(p => p.id === body.participantId);
  if (!participant) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Participant not found' }, { status: 404 });
  }

  participant.lastSeen = now;
  let meaningfulChange = false;

  // The roster decides what runtime a seat is. Heal a record that lost it, so a
  // Codex seat is never left as a Claude terminal that its own queue refuses.
  if (reconcileParticipantWithRoster(channel, participant)) {
    meaningfulChange = true;
    console.warn(
      `[Collab] Repaired ${participant.name} participant record from the roster ` +
      `(type ${participant.type}, protocol ${participant.deliveryProtocol ?? 'none'})`,
    );
  }

  if (participant.status === 'away') {
    participant.status = undefined;
    participant.awayInChannelId = undefined;
    participant.awayInChannelName = undefined;
    meaningfulChange = true;
  }

  // The seat's roster entry is not away either while the seat is heartbeating here. Only this
  // seat's own entry is cleared (matched by participant id), never another seat's.
  if (clearRosterAwayForSeat(channel, participant)) {
    meaningfulChange = true;
  }

  if (body.status) {
    participant.status = body.status;
    meaningfulChange = true;
  }

  if (body.activityStatus) {
    participant.activityStatus = body.activityStatus;
    participant.activityDetail = body.activityDetail ?? null;
    participant.activityUpdatedAt = now;
    meaningfulChange = true;

    eventBus.emitEvent('collab:typing', {
      channelId: channel.id,
      participantId: participant.id,
      participantName: participant.name,
      activityStatus: body.activityStatus,
      activityDetail: participant.activityDetail,
      activityUpdatedAt: now,
    });
  }

  if (body.host && typeof body.host.hostId === 'string') {
    const h = body.host;
    const prev = participant.host;
    if (!prev || prev.hostId !== h.hostId || prev.pid !== h.pid || prev.tmuxSession !== h.tmuxSession
        || prev.cwd !== h.cwd || prev.model !== h.model || prev.wrapperPid !== h.wrapperPid) {
      participant.host = { hostId: h.hostId, pid: h.pid ?? null, wrapperPid: h.wrapperPid ?? null,
        tmuxSession: h.tmuxSession ?? null, cwd: String(h.cwd ?? ''), model: h.model ?? null };
      meaningfulChange = true;
    }
  }

  if (meaningfulChange) {
    await saveChannels(data);
  }

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
  });
}

// ---------------------------------------------------------------------------
// create_tab — add a user sidebar tab (Work/Life/Fun are built in)
//
// The sidebar is moving from tabs to groups (create_group and friends in groups.ts). Until every
// screen has moved, the old screen still calls this, so once the groups are stored a new tab is
// created as a group too and mirrored into channelTabs, and the two lists stay the same set.
// ---------------------------------------------------------------------------

export async function handleCreateTab(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (hasChannelGroups(data)) {
    const created = createGroup(data, body.tabName);
    if (!created.ok) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: created.error }, { status: created.status });
    }
    const tab = { id: created.group.id, name: created.group.name };
    data.channelTabs = [...(data.channelTabs ?? []).filter(t => t.id !== tab.id), tab];
    await saveChannels(data);
    return NextResponse.json<CollabChannelActionResponse>({
      success: true,
      tab,
      channelTabs: resolveChannelTabs(data.channelTabs),
      channelGroups: created.groups,
    });
  }
  const prepared = prepareNewChannelTab(body.tabName, resolveChannelTabs(data.channelTabs));
  if ('error' in prepared) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: prepared.error }, { status: 400 });
  }
  data.channelTabs = [...(data.channelTabs ?? []), prepared.tab];
  await saveChannels(data);
  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    tab: prepared.tab,
    channelTabs: resolveChannelTabs(data.channelTabs),
  });
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

export async function handleRename(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }

  const channel = data.channels.find((c: CollabChannel) => c.id === body.channelId);
  if (!channel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  if (body.participantId && !channel.participants.some((p: CollabParticipant) => p.id === body.participantId)) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Not a member of this channel' }, { status: 403 });
  }

  const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!requestedName && body.name !== undefined) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel name cannot be empty' }, { status: 400 });
  }
  if (requestedName.length > 255) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel name must be 255 characters or fewer' }, { status: 400 });
  }

  const oldName = channel.name;
  const nextName = requestedName || oldName;
  const nameChanged = nextName !== oldName;
  const requestedProjectPath = typeof body.projectPath === 'string' ? body.projectPath.trim() : undefined;
  const pathChangedExplicitly = Boolean(
    requestedProjectPath && requestedProjectPath !== channel.projectPath,
  );
  const dataBefore = structuredClone(data);
  let projectRename: Awaited<ReturnType<typeof renameChannelProjectDirectory>> | undefined;

  try {
    // A top-level AgentChat channel owns its linked project identity. Renaming it
    // therefore moves the directory too; sub-channel labels never move a project.
    if (!channel.parentChannelId && (nameChanged || pathChangedExplicitly) && (channel.projectPath || channel.projectId)) {
      projectRename = await renameChannelProjectDirectory({
        projectId: channel.projectId,
        currentName: oldName,
        newName: nextName,
        currentPath: channel.projectPath,
        requestedPath: requestedProjectPath,
      });
      if (projectRename.oldPath && projectRename.newPath) {
        rewriteChannelProjectPaths(
          data,
          projectRename.oldPath,
          projectRename.newPath,
          channel.projectId,
        );
      }
    }

    channel.name = nextName;
    if (body.description !== undefined) channel.description = body.description;
    channel.lastActivity = now;
    await saveChannels(data);
  } catch (error) {
    data.channels = dataBefore.channels;
    data.lastUpdated = dataBefore.lastUpdated;
    if (projectRename) await projectRename.rollback().catch(() => {});
    throw error;
  }

  if (nameChanged) {
    const renameMessage: CollabMessage = {
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
      content: `Channel renamed from "${oldName}" to "${nextName}"`,
      timestamp: now,
    };
    await appendChannelMessage(channel.id, renameMessage).catch(err =>
      console.error('[Collab] Failed to append channel rename message:', err)
    );

    onChannelRenamed(channel.id, nextName).catch(err =>
      console.error('[Collab] Teams auto-sync rename error:', err)
    );
    onSlackChannelRenamed(channel.id, nextName).catch(err =>
      console.error('[Collab] Slack auto-sync rename error:', err)
    );
  }

  registryOnUpdated(channel).catch(() => {});

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: channel.id,
    channel,
  });
}

// ---------------------------------------------------------------------------
// create_subchannel
// ---------------------------------------------------------------------------

export async function handleCreateSubchannel(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId (parent) is required' }, { status: 400 });
  }
  if (!body.participantId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'participantId (creator) is required' }, { status: 400 });
  }
  if (!body.participantIds || body.participantIds.length === 0) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'participantIds (invitees) is required and must not be empty' }, { status: 400 });
  }

  const parentChannel = data.channels.find(c => c.id === body.channelId);
  if (!parentChannel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Parent channel not found' }, { status: 404 });
  }

  if (parentChannel.parentChannelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Cannot create a sub-channel inside another sub-channel' }, { status: 400 });
  }

  const creator = parentChannel.participants.find(p => p.id === body.participantId);
  if (!creator) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Creator is not a member of the parent channel' }, { status: 403 });
  }

  const invitees: CollabParticipant[] = [];
  for (const pid of body.participantIds) {
    const p = parentChannel.participants.find(pp => pp.id === pid);
    if (!p) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: `Participant ${pid} is not a member of the parent channel` }, { status: 400 });
    }
    if (pid !== body.participantId) {
      invitees.push(p);
    }
  }

  const allMembers = [creator, ...invitees];
  const nameList = allMembers.slice(0, 3).map(p => p.name);
  const suffix = allMembers.length > 3 ? ` + ${allMembers.length - 3} more` : '';
  const subChannelName = body.name || `${parentChannel.name} → ${nameList.join(', ')}${suffix}`;

  const subChannelId = randomUUID();
  const subChannel: CollabChannel = {
    id: subChannelId,
    name: subChannelName,
    parentChannelId: body.channelId,
    createdAt: now,
    lastActivity: now,
    ownerId: body.participantId,
    participants: allMembers.map(p => ({
      ...p,
      joinedAt: now,
      lastSeen: now,
    })),
    messages: [],
    settings: {
      autoRespond: false,
    },
  };

  const memberNames = invitees.map(p => p.name).join(', ');
  const subChannelCreationMsg: CollabMessage = {
    id: randomUUID(),
    channelId: subChannelId,
    from: {
      id: 'system',
      type: 'user',
      name: 'System',
      source: 'DevFlow',
      joinedAt: now,
      lastSeen: now,
    },
    content: `Private conversation created by ${creator.name} with ${memberNames}`,
    timestamp: now,
  };

  data.channels.push(subChannel);
  await saveChannels(data);
  await appendChannelMessage(subChannelId, subChannelCreationMsg);


  onTeamsChannelCreated(subChannelId, subChannelName).catch(err =>
    console.error('[Collab] Teams auto-sync create error (sub-channel):', err)
  );
  onSlackChannelCreated(subChannelId, subChannelName).catch(err =>
    console.error('[Collab] Slack auto-sync create error (sub-channel):', err)
  );

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: subChannelId,
    channel: subChannel,
  });
}

// ---------------------------------------------------------------------------
// reparent
// ---------------------------------------------------------------------------

export async function handleReparent(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId is required' }, { status: 400 });
  }

  const targetChannel = data.channels.find(c => c.id === body.channelId);
  if (!targetChannel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  if (body.participantId && !targetChannel.participants.some((p: CollabParticipant) => p.id === body.participantId)) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Not a member of this channel' }, { status: 403 });
  }

  const newParentId = body.parentChannelId ?? null;

  if (newParentId) {
    const newParent = data.channels.find(c => c.id === newParentId);
    if (!newParent) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Parent channel not found' }, { status: 404 });
    }
    if (newParentId === body.channelId) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Cannot make a channel its own parent' }, { status: 400 });
    }
    if (newParent.parentChannelId) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Cannot nest under a sub-channel (max one level deep)' }, { status: 400 });
    }
    const hasChildren = data.channels.some(c => c.parentChannelId === body.channelId);
    if (hasChildren) {
      return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Cannot nest a channel that has sub-channels — move its children first' }, { status: 400 });
    }
    targetChannel.parentChannelId = newParentId;
  } else {
    delete targetChannel.parentChannelId;
  }

  await saveChannels(data);

  return NextResponse.json<CollabChannelActionResponse>({
    success: true,
    channelId: body.channelId,
    channel: targetChannel,
  });
}

// ---------------------------------------------------------------------------
// rename_participant
// ---------------------------------------------------------------------------

export async function handleRenameParticipant(
  data: CollabChannelsData,
  body: CollabChannelActionRequest,
  now: string
): Promise<NextResponse<CollabChannelActionResponse>> {
  if (!body.channelId || !body.participantId || !body.name) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'channelId, participantId, and name are required' }, { status: 400 });
  }

  const channel = data.channels.find((c: CollabChannel) => c.id === body.channelId);
  if (!channel) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Channel not found' }, { status: 404 });
  }

  const participant = channel.participants.find((p: CollabParticipant) => p.id === body.participantId);
  if (!participant) {
    return NextResponse.json<CollabChannelActionResponse>({ success: false, error: 'Participant not found' }, { status: 404 });
  }

  const oldName = participant.name;
  participant.name = body.name;
  channel.lastActivity = now;

  if (!channel.preferredNames) {
    channel.preferredNames = {};
  }
  channel.preferredNames[body.participantId] = body.name;

  // Propagate browser user rename across ALL channels so the name sticks when
  // the user switches channels or creates new ones. Without this, each channel
  // would see "Browser User" again because preferredNames is per-channel.
  if (body.participantId?.startsWith('browser-user-')) {
    for (const ch of data.channels) {
      if (ch.id === body.channelId) continue;
      const bp = ch.participants.find(p => p.id === body.participantId);
      if (bp) {
        bp.name = body.name;
        if (!ch.preferredNames) ch.preferredNames = {};
        ch.preferredNames[body.participantId] = body.name;
      }
    }
  }

  await appendChannelMessages(channel.id, [
    {
      id: randomUUID(),
      channelId: channel.id,
      from: { id: 'system', type: 'user', name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
      content: `${oldName} changed their name to ${body.name}`,
      timestamp: now,
    },
    {
      id: randomUUID(),
      channelId: channel.id,
      from: { id: 'system', type: 'user', name: 'System', source: 'DevFlow', joinedAt: now, lastSeen: now },
      content: `@${body.name} - Your display name has been updated. Please use "${body.name}" when identifying yourself.`,
      timestamp: new Date(Date.now() + 1).toISOString(),
      mentions: [body.name],
    },
  ]);

  await saveChannels(data);
  return NextResponse.json<CollabChannelActionResponse>({ success: true, channelId: channel.id, channel });
}
