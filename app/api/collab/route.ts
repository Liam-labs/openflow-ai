/**
 * GET /api/collab  — List channels, poll messages, cursor pagination
 * POST /api/collab — Channel actions (dispatched to handler modules)
 *
 * Handlers live in ./_handlers/ to reduce per-file TypeScript compilation size.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCloudflaredRequest, isLocalRequest, requireAuthOrLocal, validateApiToken } from '@/lib/api-auth';
import path from 'path';
import { trackResponse } from '@/lib/error-rate-tracker';
import { withTiming } from '@/lib/api-tracking';
import { emitCollabError } from '@/lib/event-bus';
import type {
  CollabChannel,
  CollabChannelResponse,
  CollabChannelActionRequest,
  CollabChannelActionResponse,
  CrossChannelCopyResult,
  CollabPollResponse,
  CollabParticipant,
  CollabMessage,
  AgentRosterEntry,
  CollabPtySessionsData,
} from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { isWindowsPerMessageAgent } from '@/lib/roster-spawn-mode';
import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import {
  readChannelMessages,
  getMessagesPaginated,
} from '@/lib/collab-message-io';
import {
  readData,
  cleanupStaleParticipants,
  migrateMessagesToSeparateFiles,
  getCachedUnreadCounts,
  getCachedLastMessageAt,
  getCachedLastMessagePreview,
  setCachedUnreadCounts,
  computeUnreadCounts,
  computePresenceStatus,
  toSlimMessages,
} from './_collab-shared';
import { getLatestVisibleMessagePreview, getLatestVisibleMessageTimestamp, resolveChannelTabs } from '@/lib/collab-sidebar-logic';
import { resolveChannelGroups } from '@/lib/collab-groups';
import { ensureChannelGroups } from '@/lib/collab-groups-migration';
import { formatCrossChannelMessageForHumans } from '@/lib/hidden-messages';
import { sendCrossChannelCopy } from './_handlers/cross-channel-copy';

// Import action handlers
import { handleCreate, handleJoin, handleLeave, handleDelete, handleArchive, handleRestore, handleListArchived, handlePermanentlyDelete, type LeaveCallerKind } from './_handlers/lifecycle';
import { handleMessage, handleReact, handlePin, handleEdit, handleDeleteMessage, handleRecall } from './_handlers/messaging';
import { handleCreateGroup, handleRenameGroup, handleReorderGroups, handleDeleteGroup, handleMoveChannelToGroup } from './_handlers/groups';

/**
 * Detect client-disconnect / aborted-request errors that surface as exceptions
 * but aren't server faults. Node 20+'s `node:_http_server` throws `Error: aborted`
 * when the client closes the socket mid-request; ECONNRESET / ECONNABORTED / EPIPE
 * round out the family. Without this check, every flaky network blip on a slow
 * client produced a 'critical' entry in the alert panel — observed 2026-05-18
 * 17:27:46 from an aborted POST during the /api/collab queue-drain.
 */
function isClientDisconnectError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; code?: string; name?: string };
  const msg = (e.message || '').toLowerCase();
  const code = e.code || '';
  if (msg === 'aborted' || msg.includes('socket hang up') || msg.includes('aborted in middle')) return true;
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE') return true;
  return false;
}
import { handleUpdateSettings, handleMarkRead, handleHeartbeat, handleRename, handleCreateSubchannel, handleReparent, handleRenameParticipant, handleCreateTab } from './_handlers/settings';
import { resolveWebGateIdentity } from '@/lib/webgate-identity';
import type { ResolvedWebGateIdentity } from '@/lib/webgate-identity';
import { appPath } from '@/lib/app-paths';

// Stale threshold is referenced in GET handler (outside shared module)
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Enrich roster agents with live PTY session status (response-only — never persisted).
 *
 * PowerShell-mode (per-message) agents have no persistent PID or tmux session, so the
 * pty session's status field ('responding' during a turn, 'ready' between turns —
 * persisted to collab-pty-sessions.json by lib/collab-pty.ts) is the only live signal
 * the UI can surface for them. Returns copies: readData() results are shared via the
 * jsonCache TTL cache, so the cached channel/roster objects must NOT be mutated —
 * a leaked ptySessionStatus would otherwise be written back to collab-channels.json.
 */
async function enrichRosterWithSessionStatus(
  roster: CollabChannel['roster']
): Promise<CollabChannel['roster']> {
  if (!roster?.agents?.some(a => isWindowsPerMessageAgent(a) && a.ptySessionId)) return roster;
  try {
    // readJsonFile is TTL-cached (5s), so polling clients share one disk read per window
    const ptyData = await readJsonFile<CollabPtySessionsData>(
      DataPaths.collabPtySessions,
      { sessions: [], lastUpdated: '' }
    );
    const statusById = new Map(ptyData.sessions.map(s => [s.id, s.status]));
    return {
      ...roster,
      agents: roster.agents.map(a => {
        if (!isWindowsPerMessageAgent(a) || !a.ptySessionId) return a;
        const sessionStatus = statusById.get(a.ptySessionId);
        return sessionStatus ? { ...a, ptySessionStatus: sessionStatus } : a;
      }),
    };
  } catch {
    return roster; // Non-fatal — roster ships without live session status
  }
}

// Stale cleanup runs on a timer, not per-request (prevents lock contention)
let lastCleanupTime = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Agent pollers need the full routing envelope. Browser users need the compact
 * From -> To record. Do this at the API boundary so stale frontend bundles and
 * every chat surface receive safe display content consistently.
 */
function messagesForRequester(
  messages: CollabMessage[],
  channel: CollabChannel,
  participantId: string | null,
): CollabMessage[] {
  const requester = participantId
    ? channel.participants.find(participant => participant.id === participantId)
    : undefined;
  if (requester && requester.type !== 'user') return messages;
  return messages.map(formatCrossChannelMessageForHumans);
}

/**
 * GET /api/collab
 * - No params: List all channels
 * - ?channelId=X: Get specific channel with last 50 messages
 * - ?channelId=X&since=ISO: Poll for messages since timestamp (for terminal agents)
 * - ?channelId=X&since=ISO&participantId=Y: Poll with recipient filtering (targeted delivery)
 * - ?channelId=X&before=ISO&limit=N: Cursor pagination for older messages
 */
async function handleGet(request: NextRequest) {
  try {
    await migrateMessagesToSeparateFiles();

    const { searchParams } = request.nextUrl;
    const channelId = searchParams.get('channelId');
    const since = searchParams.get('since');
    const before = searchParams.get('before');
    const participantId = searchParams.get('participantId');
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200) : 50;
    const oldestFirst = searchParams.get('oldestFirst') === '1';
    const slim = searchParams.get('slim') === '1';

    // Agent details lookup — lightweight read, early return before cleanup logic
    if (searchParams.get('action') === 'agent_details') {
      if (!channelId || !participantId) {
        return NextResponse.json({ error: 'channelId and participantId are required' }, { status: 400 });
      }
      const detailsData = await readData();
      const channel = detailsData.channels.find(c => c.id === channelId);
      if (!channel) return NextResponse.json({ error: 'Channel not found' }, { status: 404 });

      const participant = channel.participants.find(p => p.id === participantId);
      if (!participant) return NextResponse.json({ error: 'Participant not found' }, { status: 404 });

      const roster = channel.roster as { agents?: AgentRosterEntry[] } | undefined;
      const rosterAgent = roster?.agents?.find((a: AgentRosterEntry) => a.participantId === participantId);

      const ptyData = await readJsonFile<{ sessions: Array<{ id: string; participantId: string; channelId: string; status: string; createdAt: string; lastActivity: string; pid?: number; model?: string }> }>(DataPaths.collabPtySessions, { sessions: [] });
      const ptySessions = ptyData.sessions.filter(s => s.participantId === participantId && s.channelId === channelId);
      const latestPty = ptySessions.length > 0 ? ptySessions[ptySessions.length - 1] : null;

      let roleName: string | null = null;
      const roleId = rosterAgent?.roleId ?? null;
      if (roleId) {
        try {
          const rolesRaw = await readJsonFile<{ roles?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>>(
            appPath('data', 'roles', 'roles.json'),
            { roles: [] }
          );
          const rolesArr = Array.isArray(rolesRaw) ? rolesRaw : (rolesRaw as { roles?: Array<{ id: string; name: string }> }).roles ?? [];
          roleName = rolesArr.find(r => r.id === roleId)?.name ?? null;
        } catch {
          // roles.json unreadable — leave roleName null
        }
      }

      return NextResponse.json({
        name: participant.name,
        model: latestPty?.model ?? rosterAgent?.model ?? null,
        pid: latestPty?.pid ?? participant.pid ?? null,
        channelId: channel.id,
        channelName: channel.name,
        participantId: participant.id,
        workingDirectory: rosterAgent?.effectiveWorkingDirectory ?? rosterAgent?.workingDirectory ?? (participant as CollabParticipant & { projectPath?: string }).projectPath ?? null,
        role: roleName,
        roleId,
        status: participant.status ?? null,
        activityStatus: participant.activityStatus ?? null,
        type: participant.type,
        sessionStartedAt: latestPty?.createdAt ?? null,
        joinedAt: participant.joinedAt ?? null,
        lastSeen: participant.lastSeen ?? null,
        source: participant.source ?? null,
        tmuxSession: rosterAgent?.tmuxSessionName ?? null,
        ptySessionId: latestPty?.id ?? rosterAgent?.ptySessionId ?? null,
      });
    }

    // Stale cleanup on timer (every 5min) instead of per-request — prevents lock contention
    const now_ms = Date.now();
    if (now_ms - lastCleanupTime > CLEANUP_INTERVAL_MS) {
      lastCleanupTime = now_ms;
      // Fire-and-forget — don't block the response
      mutateChannels('collab-api:stale-cleanup', async freshData => {
        const removedCount = await cleanupStaleParticipants(freshData);
        if (removedCount > 0) {
          await saveChannels(freshData);
        }
      }).catch(() => {}); // Non-fatal
    }

    const data = await readData();

    // Poll for new messages (since param)
    if (channelId && since) {
      const channel = data.channels.find(c => c.id === channelId);
      if (!channel) {
        return NextResponse.json<CollabPollResponse>({
          messages: [],
          participants: [],
          timestamp: new Date().toISOString(),
          error: 'Channel not found',
        }, { status: 404 });
      }

      const result = await getMessagesPaginated(channelId, {
        since,
        limit,
        participantId: participantId || undefined,
        oldestFirst,
      });

      if (participantId) {
        const pollingParticipant = channel.participants.find(p => p.id === participantId);
        if (pollingParticipant) {
          const lastSeenAge = pollingParticipant.lastSeen
            ? Date.now() - new Date(pollingParticipant.lastSeen).getTime()
            : Infinity;
          if (lastSeenAge > 300000) { // 5 minutes — reduces lock contention from 8 agents polling simultaneously
            await mutateChannels('collab-api:poll-last-seen', async freshData => {
              const freshChannel = freshData.channels.find(c => c.id === channelId);
              const freshParticipant = freshChannel?.participants.find(p => p.id === participantId);
              if (freshParticipant) {
                freshParticipant.lastSeen = new Date().toISOString();
                await saveChannels(freshData);
              }
            });
          }
        }
      }

      const allMsgData = await readChannelMessages(channelId);
      computeUnreadCounts(channel, allMsgData.messages);
      computePresenceStatus(channel);
      const responseMessages = messagesForRequester(result.messages, channel, participantId);

      return NextResponse.json<CollabPollResponse>({
        messages: slim ? toSlimMessages(responseMessages, channel.participants) as unknown as CollabMessage[] : responseMessages,
        participants: channel.participants,
        timestamp: new Date().toISOString(),
        hasMore: result.hasMore,
        oldestTimestamp: result.oldestTimestamp,
        roster: (await enrichRosterWithSessionStatus(channel.roster)) ?? undefined,
      });
    }

    // Cursor pagination for older messages (before param)
    if (channelId && before) {
      const channel = data.channels.find(c => c.id === channelId);
      if (!channel) {
        return NextResponse.json<CollabPollResponse>({
          messages: [],
          participants: [],
          timestamp: new Date().toISOString(),
          error: 'Channel not found',
        }, { status: 404 });
      }

      const result = await getMessagesPaginated(channelId, {
        before,
        limit,
        participantId: participantId || undefined,
      });
      const responseMessages = messagesForRequester(result.messages, channel, participantId);

      return NextResponse.json<CollabPollResponse>({
        messages: slim ? toSlimMessages(responseMessages, channel.participants) as unknown as CollabMessage[] : responseMessages,
        participants: channel.participants,
        timestamp: new Date().toISOString(),
        hasMore: result.hasMore,
        oldestTimestamp: result.oldestTimestamp,
      });
    }

    // Get specific channel with initial messages
    if (channelId) {
      const channel = data.channels.find(c => c.id === channelId);
      if (!channel) {
        return NextResponse.json<CollabChannelResponse>({
          channels: [],
          timestamp: new Date().toISOString(),
          error: 'Channel not found',
        }, { status: 404 });
      }

      const result = await getMessagesPaginated(channelId, { limit, participantId: participantId || undefined });
      const responseMessages = messagesForRequester(result.messages, channel, participantId);

      channel.messages = slim
        ? toSlimMessages(responseMessages, channel.participants) as unknown as CollabMessage[]
        : responseMessages;

      const allMsgData = await readChannelMessages(channelId);
      computeUnreadCounts(channel, allMsgData.messages);
      computePresenceStatus(channel);

      return NextResponse.json({
        channels: [channel],
        timestamp: new Date().toISOString(),
        hasMore: result.hasMore,
        oldestTimestamp: result.oldestTimestamp,
      });
    }

    // List all channels. Browser-local IDs are origin-scoped; when WebGate has
    // authenticated the request, return the canonical identity so the client
    // reads the correct participant's unread counts.
    let sidebarParticipantId = participantId;
    if (participantId?.startsWith('browser-user-')) {
      const resolvedIdentity = await resolveWebGateIdentity(request);
      if (resolvedIdentity) {
        sidebarParticipantId = resolvedIdentity.canonicalParticipantId;
      }
    }

    let visibleChannels = data.channels;
    if (sidebarParticipantId) {
      const isUserParticipant = participantId?.startsWith('browser-user-') ||
        data.channels.some(channel =>
          channel.participants.some(p => p.id === sidebarParticipantId && p.type === 'user')
        );
      visibleChannels = data.channels.filter(channel => {
        if (!channel.parentChannelId) return true;
        if (isUserParticipant) return true;
        return channel.participants.some(p => p.id === sidebarParticipantId);
      });
    }

    for (const channel of visibleChannels) {
      const cached = getCachedUnreadCounts(channel.id);
      if (cached) {
        for (const participant of channel.participants) {
          participant.unreadCount = cached.get(participant.id) ?? 0;
        }
        channel.lastMessageAt = getCachedLastMessageAt(channel.id);
        channel.lastMessagePreview = getCachedLastMessagePreview(channel.id);
      } else {
        const msgData = await readChannelMessages(channel.id);
        computeUnreadCounts(channel, msgData.messages);
        channel.lastMessageAt = getLatestVisibleMessageTimestamp(msgData.messages);
        channel.lastMessagePreview = getLatestVisibleMessagePreview(msgData.messages);
        const counts = new Map<string, number>();
        for (const participant of channel.participants) {
          counts.set(participant.id, participant.unreadCount ?? 0);
        }
        setCachedUnreadCounts(channel.id, counts, channel.lastMessageAt, channel.lastMessagePreview);
      }
      computePresenceStatus(channel);
      channel.messages = [];
    }

    // Attach live PTY session status to per-message agents — copies only, the
    // cached channel objects stay untouched (see enrichRosterWithSessionStatus)
    const responseChannels: CollabChannel[] = await Promise.all(
      visibleChannels.map(async (channel) =>
        channel.roster
          ? { ...channel, roster: await enrichRosterWithSessionStatus(channel.roster) }
          : channel
      )
    );

    // The sidebar groups replace the tabs. The first list read moves the tabs into groups (once, with a
    // copy of the file); a failure here must not fail the list, which can still derive them from the tabs.
    await ensureChannelGroups().catch(err => console.error('[Groups] migration failed:', err));
    const groupsData = await readData();

    return NextResponse.json<CollabChannelResponse>({
      channels: responseChannels,
      channelTabs: resolveChannelTabs(data.channelTabs),
      channelGroups: resolveChannelGroups(groupsData),
      participantId: sidebarParticipantId || undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number })?.statusCode;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600
      ? statusCode
      : 500;
    const is4xx = status >= 400 && status < 500;
    const isDisconnect = isClientDisconnectError(error);
    if (!isDisconnect) {
      console.error('[Collab] GET /api/collab error:', error instanceof Error ? { message: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' ') } : error);
    }
    emitCollabError(error, 'api/collab', {
      severity: isDisconnect ? 'low' : is4xx ? 'low' : 'high',
      context: { method: 'GET', clientDisconnect: isDisconnect || undefined },
    });
    return NextResponse.json<CollabChannelResponse>({
      channels: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status });
  }
}

/**
 * POST /api/collab
 * Thin dispatcher — delegates to handler modules.
 */
/** Server-derived caller kind for leave logging; never read from the request body. */
async function leaveCallerKind(request: NextRequest): Promise<LeaveCallerKind> {
  try {
    if ((await validateApiToken(request)).valid) return 'token';
    if (isCloudflaredRequest(request)) return 'webgate';
    if (isLocalRequest(request)) return 'local';
    return 'other';
  } catch {
    return 'unknown';
  }
}

async function handlePost(request: NextRequest) {
  try {
    const body: CollabChannelActionRequest = await request.json();

    // Resolve webgate identity for browser-user participants BEFORE the file lock.
    // Browser-user-* IDs are device-local; webgate-authenticated requests carry
    // a Cf-Access-Jwt-Assertion header with the real email — resolve to a stable
    // canonical participant so cross-device sessions share one identity.
    let resolvedIdentity: ResolvedWebGateIdentity | null = null;
    const isBrowserUser =
      body.participantId?.startsWith('browser-user-') ||
      body.participant?.id?.startsWith('browser-user-');
    if (isBrowserUser) {
      resolvedIdentity = await resolveWebGateIdentity(request);
    }

    // A human's "also send to" copy for a cross-channel agent goes out first,
    // outside the lock: the cross-channel action takes the same channels lock.
    let alsoSentTo: CrossChannelCopyResult | undefined;
    if (body.action === 'message' && body.crossChannelTarget) {
      const copy = await sendCrossChannelCopy(body, await readData());
      if ('invalid' in copy) {
        return NextResponse.json<CollabChannelActionResponse>({ success: false, error: copy.invalid }, { status: 400 });
      }
      alsoSentTo = copy;
    }

    const leaveCaller: LeaveCallerKind = body.action === 'leave' ? await leaveCallerKind(request) : 'unknown';

    return await mutateChannels(`collab-api:${String(body.action)}`, async data => {
      const now = new Date().toISOString();

      switch (body.action) {
        case 'create':           return handleCreate(data, body, now);
        case 'join':             return handleJoin(data, body, now, resolvedIdentity);
        case 'message':          return handleMessage(data, body, now, resolvedIdentity, alsoSentTo);
        case 'react':            return handleReact(data, body, now);
        case 'pin':              return handlePin(data, body, now);
        case 'edit':             return handleEdit(data, body, now);
        case 'delete_message':   return handleDeleteMessage(data, body, now);
        case 'leave':            return handleLeave(data, body, now, leaveCaller);
        case 'delete':           return handleDelete(data, body, now);
        case 'archive':          return handleArchive(data, body, now);
        case 'restore':          return handleRestore(data, body, now);
        case 'list_archived':    return handleListArchived(data, body, now);
        case 'permanently_delete': return handlePermanentlyDelete(data, body, now);
        case 'update_settings':  return handleUpdateSettings(data, body, now);
        case 'mark_read':        return handleMarkRead(data, body, now);
        case 'heartbeat':        return handleHeartbeat(data, body, now);
        case 'rename':           return handleRename(data, body, now);
        case 'create_tab':       return handleCreateTab(data, body);
        case 'create_group':     return handleCreateGroup(data, body);
        case 'rename_group':     return handleRenameGroup(data, body);
        case 'reorder_groups':   return handleReorderGroups(data, body);
        case 'delete_group':     return handleDeleteGroup(data, body);
        case 'move_channel_to_group': return handleMoveChannelToGroup(data, body);
        case 'create_subchannel': return handleCreateSubchannel(data, body, now);
        case 'reparent':         return handleReparent(data, body, now);
        case 'rename_participant': return handleRenameParticipant(data, body, now);
        case 'recall':           return handleRecall(data, body, now);

        default:
          return NextResponse.json<CollabChannelActionResponse>({
            success: false,
            error: `Unknown action: ${body.action}`,
          }, { status: 400 });
      }
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number })?.statusCode;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600
      ? statusCode
      : 500;
    const is4xx = status >= 400 && status < 500;
    const isDisconnect = isClientDisconnectError(error);
    if (!isDisconnect) {
      console.error('[Collab] POST /api/collab error:', error instanceof Error ? { message: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' ') } : error);
    }
    emitCollabError(error, 'api/collab', {
      severity: isDisconnect ? 'low' : is4xx ? 'low' : 'critical',
      context: { method: 'POST', clientDisconnect: isDisconnect || undefined },
    });
    return NextResponse.json<CollabChannelActionResponse>({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status });
  }
}

// Exported wrappers — track response status for error rate aggregation + timing
const _getHandler = async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  const response = await handleGet(request);
  trackResponse('/api/collab', response.status);
  return response;
};
export const GET = withTiming('/api/collab', _getHandler);

const _postHandler = async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  const response = await handlePost(request);
  trackResponse('/api/collab', response.status);
  return response;
};
export const POST = withTiming('/api/collab', _postHandler);
