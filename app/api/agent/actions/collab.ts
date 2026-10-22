/**
 * Collaboration Channel Actions
 *
 * Actions for managing collaboration channels and messaging.
 */

import { promises as fsPromises } from 'fs';
import path from 'path';
import { validateAndCanonicalize } from '@/lib/path-linker-validate';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import {
  readChannelMessages,
  appendMessage as appendChannelMessage,
  getMessagesPaginated,
  archiveOldMessages,
  findMessage,
  findRecentDuplicate,
  updateMessage,
  deleteChannelMessages,
} from '@/lib/collab-message-io';
import { parseAtMentions } from '@/lib/collab-utils';
import { eventBus } from '@/lib/event-bus';
import { emitApiEvent } from '@/lib/log-emitter';
import { ensureChannelProject } from '@/lib/channel-project-bootstrap';
import { computeRecipients, readRolesData, deliverMessage } from '@/lib/collab-delivery';
import { enqueueDurableDeliveries, prepareDurableDelivery } from '@/lib/collab-delivery-ledger';
import { invalidField } from '@/lib/api-validation';
import { buildCrossChannelPrompt } from '@/lib/cross-channel-message';
import { lastSeenAge, participantPresence, participantReachable } from '@/lib/collab-presence';
import { isSeatStuck } from '@/lib/collab-seat-health';
import { findOfflineMentions, postOfflineMentionNotice, type OfflineMention } from '@/lib/collab-offline-mention-notice';
import type {
  AgentApiRequest,
  AgentAuthContext,
  CollabChannel,
  CollabChannelsData,
  CollabMessage,
  CollabParticipant,
} from '@/lib/types';
import { appPath } from '@/lib/app-paths';
import { saveFileToDisk, MAX_FILES_PER_MESSAGE } from '@/app/api/collab/_collab-shared';
import { PRODUCT_NAME } from '@/lib/brand';
import { selfOrigin } from '@/lib/self-origin';

const CHANNELS_PATH = DataPaths.collabChannels;
const COLLAB_IMAGES_DIR = appPath('.AppData', 'collab-images');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  html: 'text/html', css: 'text/css', js: 'text/javascript',
  ts: 'text/plain', json: 'application/json', xml: 'application/xml',
  md: 'text/plain', sh: 'text/plain', py: 'text/plain',
  zip: 'application/zip', gz: 'application/gzip',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Read a file from an absolute path and save it to the collab images dir.
 * Returns the serving URL and file metadata, or null on failure.
 */
async function saveFilePathToDisk(
  absolutePath: string,
  messageId: string,
  index: number
): Promise<{ url: string; name: string; type: string; size: number } | null> {
  try {
    // Path validation via path-linker allowlist — rejects traversal, symlinks escapes,
    // and sensitive directories (.ssh, .secrets, etc.) defined in path-linker-allowlist.json
    const validation = await validateAndCanonicalize(absolutePath);
    if (!validation.allowed || validation.isDirectory) return null;
    const resolved = validation.canonicalPath!;

    const stat = await fsPromises.stat(resolved);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_SIZE) {
      return null;
    }

    const ext = path.extname(resolved).toLowerCase().replace('.', '');
    const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';
    const name = path.basename(resolved);
    const filename = `${messageId}-${index}.${ext || 'bin'}`;
    const destPath = path.join(COLLAB_IMAGES_DIR, filename);

    await fsPromises.mkdir(COLLAB_IMAGES_DIR, { recursive: true });
    await fsPromises.copyFile(resolved, destPath);

    return {
      url: `/api/collab/images/${filename}`,
      name,
      type: mimeType,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

async function loadChannelsData(): Promise<CollabChannelsData> {
  return readJsonFile<CollabChannelsData>(CHANNELS_PATH, DEFAULT_CHANNELS_DATA);
}

/**
 * Find the browser user from existing channels and add to a new channel.
 * Ensures the human is always a participant in every channel.
 */
function ensureBrowserUserInChannel(channel: CollabChannel, data: CollabChannelsData, now: string): void {
  if (channel.participants.some(p => p.id.startsWith('browser-user-') && p.type === 'user')) return;

  for (const ch of data.channels) {
    if (ch.id === channel.id) continue;
    const browserUser = ch.participants.find(
      (p: CollabParticipant) => p.id.startsWith('browser-user-') && p.type === 'user'
    );
    if (browserUser) {
      channel.participants.push({
        id: browserUser.id,
        type: 'user',
        name: browserUser.name,
        source: browserUser.source || 'DevFlow Browser',
        joinedAt: now,
        lastSeen: now,
        color: browserUser.color || '#8B5CF6',
      });
      return;
    }
  }
}

/**
 * collab.channels.list - List all collaboration channels
 */
export async function listChannels(
  _body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  channels: Array<{
    id: string;
    name: string;
    participantCount: number;
    messageCount: number;
    lastActivity: string;
  }>;
  count: number;
}> {
  const data = await loadChannelsData();

  const channelSummaries = await Promise.all(data.channels.map(async ch => {
    const msgData = await readChannelMessages(ch.id);
    return {
      id: ch.id,
      name: ch.name,
      participantCount: ch.participants.length,
      messageCount: msgData.messages.length,
      lastActivity: ch.lastActivity,
    };
  }));

  return {
    channels: channelSummaries,
    count: channelSummaries.length,
  };
}

/**
 * collab.channels.get - Get details of a specific channel
 */
export async function getChannel(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ channel: CollabChannel | null; found: boolean }> {
  const channelId = body.channelId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  const data = await loadChannelsData();
  const channel = data.channels.find(ch => ch.id === channelId);

  if (channel) {
    // Populate messages from per-channel file, filtered by participantId if provided
    const participantId = typeof body.participantId === 'string' ? body.participantId : undefined;
    const msgResult = await getMessagesPaginated(channel.id, { limit: 50, participantId });
    channel.messages = msgResult.messages;
  }

  return {
    channel: channel || null,
    found: !!channel,
  };
}

/**
 * collab.presence - Who is online in a channel (for addressing cross-channel messages)
 */
export async function presence(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  channel: { id: string; name: string };
  participants: Array<{ id: string; name: string; type: string; status: 'online' | 'away' | 'offline'; lastSeen?: string; awayInChannelName?: string }>;
  online: string[];
}> {
  const channelId = body.channelId;
  if (!channelId || typeof channelId !== 'string') {
    throw invalidField('channelId is required');
  }
  const data = await loadChannelsData();
  const channel = data.channels.find(ch => ch.id === channelId);
  if (!channel) {
    const err: Error & { statusCode?: number } = new Error(`Channel not found: ${channelId}`);
    err.statusCode = 404;
    throw err;
  }
  const nowMs = Date.now();
  const participants = channel.participants.map(p => {
    const reachable = participantReachable(p, channel, data, nowMs);
    const status: 'online' | 'away' | 'offline' = !reachable
      ? 'offline'
      : (p.status === 'away' && p.awayInChannelId && participantPresence(p, channel, nowMs) === 'offline') ? 'away' : 'online';
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      status,
      lastSeen: p.lastSeen,
      ...(status === 'away' && { awayInChannelName: p.awayInChannelName }),
    };
  });
  return {
    channel: { id: channel.id, name: channel.name },
    participants,
    online: participants.filter(p => p.status !== 'offline' && p.type !== 'user').map(p => p.name),
  };
}

/**
 * collab.channels.create - Create a new collaboration channel
 */
export async function createChannel(
  body: AgentApiRequest,
  auth: AgentAuthContext
): Promise<{ channel: CollabChannel }> {
  const name = body.name;
  const description = body.description;

  // Validate channel name
  const channelName = typeof name === 'string' ? name.trim() : '';
  if (channelName.length === 0) {
    throw Object.assign(new Error('Channel name is required and cannot be empty'), { statusCode: 400 });
  }
  if (channelName.length > 255) {
    throw Object.assign(new Error('Channel name must be 255 characters or fewer'), { statusCode: 400 });
  }

  const channelProject = await ensureChannelProject({
    channelName,
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    projectPath: typeof body.projectPath === 'string' ? body.projectPath : undefined,
  });

  return mutateChannels('agent-api:createChannel', async data => {

    const now = new Date().toISOString();
    const channelId = crypto.randomUUID();

    const newChannel: CollabChannel = {
      id: channelId,
      name: channelName || `Channel ${data.channels.length + 1}`,
      description: typeof description === 'string' ? description : undefined,
      projectId: channelProject.projectId,
      projectPath: channelProject.projectPath,
      createdAt: now,
      lastActivity: now,
      ownerId: auth.tokenId,
      participants: [],
      messages: [],
      settings: {
        autoRespond: false,
      },
    };

    // Auto-add browser user so the human is always a participant
    ensureBrowserUserInChannel(newChannel, data, now);

    data.channels.push(newChannel);
    await saveChannels(data);

    emitApiEvent({
      action: 'collab.channels.create',
      status: 200,
      durationMs: 0,
      requestId: auth.requestId,
      severity: 'info',
      channelId,
      summary: `Channel created: ${channelName}`,
    });

    return { channel: newChannel };
  });
}

/**
 * collab.channels.delete - Delete a collaboration channel (admin only)
 */
export async function deleteChannel(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deleted: boolean; channelId: string }> {
  const channelId = body.channelId;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  return mutateChannels('agent-api:deleteChannel', async data => {
    const channelIndex = data.channels.findIndex(ch => ch.id === channelId);

    if (channelIndex === -1) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const channel = data.channels[channelIndex];

    // Ownership check — match the REST route: allow if no ownerId (legacy), caller is owner, or caller is browser user
    if (body.participantId && typeof body.participantId === 'string') {
      const requestingParticipant = channel.participants.find(p => p.id === body.participantId);
      const isBrowserUser = requestingParticipant?.type === 'user' || (body.participantId as string).startsWith('browser-user-');
      const isOwner = !channel.ownerId || channel.ownerId === body.participantId;
      if (!isOwner && !isBrowserUser) {
        throw new Error('Only the channel owner or a browser user can delete this channel');
      }
    }

    const channelName = channel.name;
    data.channels.splice(channelIndex, 1);
    await saveChannels(data);

    // Clean up per-channel message files
    await deleteChannelMessages(channelId as string);

    emitApiEvent({
      action: 'collab.channels.delete',
      status: 200,
      durationMs: 0,
      requestId: _auth.requestId,
      severity: 'medium',
      channelId: channelId as string,
      summary: `Channel deleted: ${channelName}`,
    });

    return { deleted: true, channelId };
  });
}

/**
 * collab.join - Join a collaboration channel
 */
export async function join(
  body: AgentApiRequest,
  auth: AgentAuthContext
): Promise<{ participantId: string; joined: boolean }> {
  const channelId = body.channelId;
  const participant = body.participant as Partial<CollabParticipant> | undefined;

  if (!channelId || typeof channelId !== 'string') {
    throw invalidField('channelId is required');
  }

  // Sprint Q1 hotfix (Reynolds, 2026-05-27) — close the /api/agent
  // action-dispatcher gap CJack found in T4 spot-check. The /api/collab
  // route-handler path (handleJoin in _handlers/lifecycle.ts) was migrated
  // but this parallel path accepted participant=null + new participantId
  // created from auth.tokenName. Same validation shape as handleJoin.
  if (participant !== undefined) {
    if (typeof participant !== 'object' || Array.isArray(participant) || participant === null) {
      throw invalidField('participant must be a non-null object when provided');
    }
    if (participant.name !== undefined) {
      if (typeof participant.name !== 'string') {
        throw invalidField('participant.name must be a string when provided');
      }
      if (participant.name.length > 200) {
        throw invalidField('participant.name must be 200 characters or fewer');
      }
      if (/[\x00-\x1f\x7f\x9b]/.test(participant.name)) {
        throw invalidField('participant.name must not contain control characters');
      }
    }
    if (participant.type !== undefined) {
      if (typeof participant.type !== 'string') {
        throw invalidField('participant.type must be a string when provided');
      }
      if (participant.type.length > 100) {
        throw invalidField('participant.type must be 100 characters or fewer');
      }
    }
    if (participant.id !== undefined && typeof participant.id !== 'string') {
      throw invalidField('participant.id must be a string when provided');
    }
  }

  return mutateChannels('agent-api:join', async data => {
    const channel = data.channels.find(ch => ch.id === channelId);

    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const now = new Date().toISOString();
    const incomingName = participant?.name || auth.tokenName;
    const isAgentType = (t?: string) => t?.includes('terminal') || t === 'claude' || t === 'agent';

    // Check for existing participant by name+type (prevents duplicates on rejoin)
    const existing = channel.participants.find(p => {
      if (participant?.id && p.id === participant.id) return true;
      if (incomingName && isAgentType(p.type) && isAgentType(participant?.type)) {
        return p.name === incomingName;
      }
      return false;
    });

    if (existing) {
      // Update existing participant fields
      if (participant?.type) existing.type = participant.type as CollabParticipant['type'];
      if (participant?.source) existing.source = participant.source as string;
      if (typeof participant?.pid === 'number') existing.pid = participant.pid;
      if (typeof participant?.projectPath === 'string') existing.projectPath = participant.projectPath;
      existing.lastSeen = now;

      // Clear "away" status — agent is actively joining this channel
      if (existing.status === 'away') {
        existing.status = undefined;
        existing.awayInChannelId = undefined;
        existing.awayInChannelName = undefined;
      }

      // Mark as "away" in other channels (additive multi-channel support)
      if (isAgentType(existing.type)) {
        markAwayInOtherChannels(data, existing.name, existing.type, channelId, channel.name, existing.projectPath);
      }

      channel.lastActivity = now;
      await saveChannels(data);
      return { participantId: existing.id, joined: true };
    }

    // New participant — create entry
    const participantId = crypto.randomUUID();

    const newParticipant: CollabParticipant = {
      id: participantId,
      type: (participant?.type as CollabParticipant['type']) || 'claude-browser',
      name: incomingName,
      source: (participant?.source as string) || 'Agent API',
      joinedAt: now,
      lastSeen: now,
      pid: typeof participant?.pid === 'number' ? participant.pid : undefined,
      projectPath: typeof participant?.projectPath === 'string' ? participant.projectPath : undefined,
    };

    channel.participants.push(newParticipant);
    channel.lastActivity = now;

    // Mark as "away" in other channels (additive multi-channel support)
    if (isAgentType(newParticipant.type)) {
      markAwayInOtherChannels(data, newParticipant.name, newParticipant.type, channelId, channel.name, newParticipant.projectPath);
    }

    await saveChannels(data);

    emitApiEvent({
      action: 'collab.join',
      status: 200,
      durationMs: 0,
      requestId: auth.requestId,
      severity: 'info',
      actor: participantId,
      channelId: channelId as string,
      summary: `${newParticipant.name} joined ${channel.name}`,
    });

    // Broadcast join announcement for agents (skip browser users to avoid noise)
    if (newParticipant.type !== 'user') {
      const joinMessage: CollabMessage = {
        id: crypto.randomUUID(),
        channelId: channelId as string,
        from: {
          id: 'system',
          type: 'user',
          name: 'System',
          source: 'DevFlow',
          joinedAt: now,
          lastSeen: now,
        },
        content: `${newParticipant.name} has joined the channel.`,
        timestamp: now,
      };
      await appendChannelMessage(channelId as string, joinMessage);
      eventBus.emitEvent('collab:message', { channelId, message: joinMessage });
    }

    return { participantId, joined: true };
  });
}

/**
 * Mark an agent as "away" in all other channels where they appear.
 * Supports multi-channel operation — the agent stays as a participant
 * but the stale cleanup won't remove them.
 */
function markAwayInOtherChannels(
  data: CollabChannelsData,
  agentName: string,
  agentType: string | undefined,
  joinedChannelId: string,
  joinedChannelName: string,
  joiningProjectPath?: string
): void {
  const isAgentType = (t?: string) => t?.includes('terminal') || t === 'claude' || t === 'agent';
  if (!isAgentType(agentType)) return;

  for (const otherChannel of data.channels) {
    if (otherChannel.id === joinedChannelId) continue;
    const match = otherChannel.participants.find(p => {
      if (p.name !== agentName || !isAgentType(p.type)) return false;
      // Different projectPaths = different agents, not the same agent moving channels
      if (joiningProjectPath && p.projectPath && p.projectPath !== joiningProjectPath) return false;
      return true;
    });
    if (match) {
      match.status = 'away';
      match.awayInChannelId = joinedChannelId;
      match.awayInChannelName = joinedChannelName;
    }
  }
}

/**
 * collab.leave - Leave a collaboration channel
 */
export async function leave(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ left: boolean }> {
  const channelId = body.channelId;
  const participantId = body.participantId;

  if (!channelId || typeof channelId !== 'string') {
    throw invalidField('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw invalidField('participantId is required');
  }

  return mutateChannels('agent-api:leave', async data => {
    const channel = data.channels.find(ch => ch.id === channelId);

    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const participantIndex = channel.participants.findIndex(p => p.id === participantId);

    if (participantIndex === -1) {
      throw new Error(`Participant not found: ${participantId}`);
    }

    channel.participants.splice(participantIndex, 1);
    channel.lastActivity = new Date().toISOString();
    await saveChannels(data);

    return { left: true };
  });
}

/**
 * Attachments on an Agent API message. Two sources, both optional:
 *  - `images`: uploaded content `[{data: <base64 data URL>, name, type, size}]`,
 *    the same shape and saver (`saveFileToDisk`, 25 MB, max 10) as `/api/collab`.
 *    This is the route for files that only exist on the sender's machine.
 *  - `filePaths`: absolute paths read from the SERVER's own disk.
 * Every attachment that was requested but not saved is reported in `failed`,
 * so a caller never has to guess why a message arrived without its files.
 */
export interface AttachmentReport {
  requested: number;
  saved: number;
  failed: Array<{ name: string; reason: string }>;
}

async function saveMessageAttachments(
  body: AgentApiRequest,
  messageId: string
): Promise<{
  images: CollabMessage['images'] | undefined;
  imageUrls: string[];
  report: AttachmentReport | undefined;
}> {
  const saved: Array<{ url: string; name: string; type: string; size: number }> = [];
  const failed: AttachmentReport['failed'] = [];
  let requested = 0;
  let index = 0;

  const rawImages = Array.isArray(body.images) ? body.images : [];
  const rawFilePaths = Array.isArray(body.filePaths) ? body.filePaths : [];

  for (const img of rawImages) {
    requested++;
    const name = img && typeof img.name === 'string' && img.name ? img.name : `attachment-${requested}`;
    if (requested > MAX_FILES_PER_MESSAGE) {
      failed.push({ name, reason: `more than ${MAX_FILES_PER_MESSAGE} attachments in one message` });
      continue;
    }
    if (!img || typeof img.data !== 'string') {
      failed.push({ name, reason: 'missing base64 data URL' });
      continue;
    }
    const result = await saveFileToDisk(img.data, messageId, index, img.name);
    if (!result) {
      failed.push({ name, reason: 'invalid data URL or larger than 25 MB' });
      continue;
    }
    const size = typeof img.size === 'number' ? img.size : Math.floor(img.data.length * 3 / 4);
    saved.push({ url: result.url, name, type: typeof img.type === 'string' ? img.type : 'application/octet-stream', size });
    index++;
  }

  for (const fp of rawFilePaths) {
    requested++;
    const label = typeof fp === 'string' ? fp : String(fp);
    if (requested > MAX_FILES_PER_MESSAGE) {
      failed.push({ name: label, reason: `more than ${MAX_FILES_PER_MESSAGE} attachments in one message` });
      continue;
    }
    const result = typeof fp === 'string' ? await saveFilePathToDisk(fp, messageId, index) : null;
    if (!result) {
      failed.push({
        name: label,
        reason: `not readable on the ${PRODUCT_NAME} server (filePaths are server-local; send the file content in \`images\` instead)`,
      });
      continue;
    }
    saved.push(result);
    index++;
  }

  return {
    images: saved.length > 0 ? saved.map(r => ({ name: r.name, type: r.type, size: r.size, url: r.url })) : undefined,
    imageUrls: saved.map(r => `http://localhost:3000${r.url}`),
    report: requested > 0 ? { requested, saved: saved.length, failed } : undefined,
  };
}

/**
 * collab.message - Send a message to a channel
 */
export async function message(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ messageId: string; sent: boolean; offlineRecipients?: string[]; offlineMentions?: string[]; attachments?: AttachmentReport }> {
  const isCrossChannel = body.action === 'collab.cross_channel_message';
  const channelId = isCrossChannel ? body.targetChannelId : body.channelId;
  const participantId = isCrossChannel ? body.sourceParticipantId : body.participantId;
  const sourceChannelId = isCrossChannel ? body.sourceChannelId : undefined;
  const targetParticipantId = isCrossChannel ? body.targetParticipantId : undefined;
  const content = body.content;
  const mentions = body.mentions;
  const replyTo = body.replyTo;
  const silent = body.silent === true;
  const isHidden = body.isHidden === true;

  // Sprint Q1 T4 — Reynolds, 2026-05-27. invalidField() attaches statusCode=400
  // + code='INVALID_FIELD' so the /api/agent dispatcher routes these to 400
  // instead of the 500 fallback path (the content-cap throw was the QA-log
  // high: dispatcher returned 500 INTERNAL_ERROR with the original throw).
  if (!channelId || typeof channelId !== 'string') {
    throw invalidField(`${isCrossChannel ? 'targetChannelId' : 'channelId'} is required`);
  }
  if (!participantId || typeof participantId !== 'string') {
    throw invalidField(`${isCrossChannel ? 'sourceParticipantId' : 'participantId'} is required`);
  }
  if (isCrossChannel && (!sourceChannelId || typeof sourceChannelId !== 'string')) {
    throw invalidField('sourceChannelId is required');
  }
  if (isCrossChannel && sourceChannelId === channelId) {
    throw invalidField('sourceChannelId and targetChannelId must be different; use collab.message for local-channel messages');
  }
  if (isCrossChannel && targetParticipantId !== undefined && typeof targetParticipantId !== 'string') {
    throw invalidField('targetParticipantId must be a string when provided');
  }
  if (!content || typeof content !== 'string') {
    throw invalidField('content is required');
  }
  if (content.length > 100_000) {
    throw invalidField('Message content must not exceed 100,000 characters');
  }

  return mutateChannels('agent-api:message', async data => {
    const channel = data.channels.find(ch => ch.id === channelId);

    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const sourceChannel = isCrossChannel
      ? data.channels.find(ch => ch.id === sourceChannelId)
      : undefined;
    if (isCrossChannel && !sourceChannel) {
      throw new Error(`Source channel not found: ${sourceChannelId}`);
    }

    let participant = isCrossChannel
      ? sourceChannel!.participants.find(p => p.id === participantId)
      : channel.participants.find(p => p.id === participantId);

    // Legacy away-agent fallback: resolve by name only when the participant in
    // the destination is demonstrably the same project identity. Name alone is
    // unsafe: two projects commonly have a "Jack", and the old fallback let a
    // foreign --channel post impersonate the destination Jack and self-target.
    if (!participant && !isCrossChannel) {
      let foreignParticipant: CollabParticipant | undefined;
      for (const ch of data.channels) {
        if (ch.id === channelId) continue;
        const match = ch.participants.find(p => p.id === participantId);
        if (match) { foreignParticipant = match; break; }
      }
      if (foreignParticipant?.projectPath) {
        const isAgentType = (t?: string) => t?.includes('terminal') || t === 'claude' || t === 'agent';
        participant = channel.participants.find(p =>
          p.name === foreignParticipant!.name
          && isAgentType(p.type)
          && p.projectPath === foreignParticipant!.projectPath
        );
      }
    }

    if (!participant) {
      throw new Error(`${isCrossChannel ? 'Source participant' : 'Participant'} not found: ${participantId}`);
    }

    if (!silent && !isCrossChannel) {
      const duplicate = await findRecentDuplicate(channel.id, participant.id, content);
      if (duplicate) {
        prepareDurableDelivery(participant.id, duplicate, channel);
        await enqueueDurableDeliveries(participant.id, duplicate, channel);
        return { messageId: duplicate.id, sent: true };
      }
    }

    const now = new Date().toISOString();

    // Clear "away" status when agent actively posts to this channel
    if (!isCrossChannel && participant.status === 'away') {
      participant.status = undefined;
      participant.awayInChannelId = undefined;
      participant.awayInChannelName = undefined;
    }

    // Mark as "away" in other channels — protects from stale cleanup
    const isAgentType = (t?: string) => t?.includes('terminal') || t === 'claude' || t === 'agent';
    if (!isCrossChannel && isAgentType(participant.type)) {
      markAwayInOtherChannels(data, participant.name, participant.type, channelId as string, channel.name, participant.projectPath);
    }

    const messageId = crypto.randomUUID();

    // Enrich replyTo if message ID provided
    let enrichedReplyTo: CollabMessage['replyTo'] = undefined;
    if (typeof replyTo === 'string') {
      let originalMessage = await findMessage(channelId as string, replyTo);
      // A cross-channel reply normally references the incoming message stored
      // in the sender's current/source channel, not the destination channel.
      // Search both so the reverse-route action preserves threading either way.
      if (!originalMessage && isCrossChannel) {
        originalMessage = await findMessage(sourceChannel!.id, replyTo);
      }
      if (originalMessage) {
        enrichedReplyTo = {
          id: originalMessage.id,
          from: originalMessage.from,
          content: originalMessage.content?.slice(0, 150), // Truncate for context
        };
      }
    }

    // Compute recipients and mentions based on @mentions
    const roles = await readRolesData();
    let recipients = computeRecipients(content, participantId as string, channel, roles);
    // Services that know an addressee's participant ID but not their display
    // name (e.g. an email watch alerting the agent that owns it) target it
    // explicitly instead of broadcasting to every agent in the channel.
    if (!isCrossChannel && Array.isArray(body.targetParticipantIds)) {
      const explicit = (body.targetParticipantIds as unknown[]).filter(
        (id): id is string => typeof id === 'string' && channel.participants.some(p => p.id === id),
      );
      if (explicit.length > 0) recipients = [...new Set([...(recipients ?? []), ...explicit])];
    }
    if (isCrossChannel && typeof targetParticipantId === 'string') {
      const explicitTarget = channel.participants.find(p => p.id === targetParticipantId);
      if (!explicitTarget) {
        throw new Error(`Target participant not found: ${targetParticipantId}`);
      }
      recipients = [explicitTarget.id];
      const browserUser = channel.participants.find(p => p.type === 'user' && p.id.startsWith('browser-user-'));
      if (browserUser && !recipients.includes(browserUser.id)) recipients.push(browserUser.id);
    }
    if (isCrossChannel && !recipients) {
      throw invalidField('Cross-channel messages must target a participant using targetParticipantId or an @mention');
    }

    // A cross-channel sender cannot see the destination's presence, so check it
    // here: refuse when every addressed agent is offline (the message would sit
    // unread), and report the offline subset when only some are.
    let offlineRecipients: string[] | undefined;
    if (isCrossChannel && recipients) {
      const nowMs = Date.now();
      // One agent can hold two IDs here (pre-registered roster ID + join-acquired
      // ID), or only a roster entry while stopped. Judge each agent once, by name.
      const byAgent = new Map<string, { name: string; reachable: boolean; lastSeen?: string; stuck?: boolean }>();
      for (const id of recipients) {
        const p = channel.participants.find(cp => cp.id === id);
        if (p?.type === 'user') continue;
        const name = p?.name ?? channel.roster?.agents.find(a => a.participantId === id)?.name ?? id;
        const entry = byAgent.get(name) ?? { name, reachable: false };
        if (p && participantReachable(p, channel, data, nowMs)) entry.reachable = true;
        if (p && isSeatStuck(channel.id, p.id, nowMs)) entry.stuck = true;
        if (p?.lastSeen && (!entry.lastSeen || p.lastSeen > entry.lastSeen)) entry.lastSeen = p.lastSeen;
        byAgent.set(name, entry);
      }
      const addressedAgents = [...byAgent.values()];
      const offline = addressedAgents.filter(a => !a.reachable);
      if (offline.length > 0 && body.allowOffline !== true) {
        if (offline.length === addressedAgents.length) {
          const onlineNow = channel.participants
            .filter(p => p.type !== 'user' && p.id !== participant.id && participantReachable(p, channel, data, nowMs))
            .map(p => p.name);
          const err: Error & { statusCode?: number; code?: string } = new Error(
            `Not sent: no addressed agent is online in "${channel.name}". `
            + `Offline: ${offline.map(a => `${a.name} (${a.stuck ? 'online but not picking up messages' : `last seen ${lastSeenAge(a.lastSeen, nowMs)}`})`).join(', ')}. `
            + `Online now: ${onlineNow.length > 0 ? onlineNow.join(', ') : 'no agents'}. `
            + 'Address an online agent instead, or resend with allowOffline (helper: --allow-offline) '
            + 'if the message should wait for their return.'
          );
          err.statusCode = 409;
          err.code = 'RECIPIENTS_OFFLINE';
          throw err;
        }
        offlineRecipients = offline.map(a => a.name);
      }
    }
    const deliveryMode: 'targeted' | 'broadcast' = recipients ? 'targeted' : 'broadcast';

    // Extract mentions server-side from message content
    const parsedMentions = parseAtMentions(content, channel.participants, channel.roster?.agents, roles);
    const resolvedMentions = parsedMentions.length > 0 ? parsedMentions : (Array.isArray(mentions) ? mentions : undefined);

    const agentRecipientIds = recipients?.filter(id => channel.participants.some(
      p => p.id === id && p.type !== 'user'
    ));
    const recipientId = agentRecipientIds?.length === 1 ? agentRecipientIds[0] : undefined;
    const deliveredContent = isCrossChannel
      ? buildCrossChannelPrompt({
          content,
          sourceChannel: { id: sourceChannel!.id, name: sourceChannel!.name },
          deliveryChannel: { id: channel.id, name: channel.name },
          sender: participant,
          recipientId,
        })
      : content;

    // Retry-safe cross-channel delivery. Re-enqueue the existing durable
    // message instead of storing another envelope when a wrapper double-sends
    // or retries before seeing the first result.
    if (!silent && isCrossChannel) {
      const duplicate = await findRecentDuplicate(
        channel.id,
        participant.id,
        deliveredContent,
        60_000
      );
      if (duplicate) {
        prepareDurableDelivery(participant.id, duplicate, channel);
        await enqueueDurableDeliveries(participant.id, duplicate, channel);
        return { messageId: duplicate.id, sent: true };
      }
    }

    // Attachments are saved only after the retry-duplicate check above so a
    // retried send does not leave orphaned files behind.
    const attachments = await saveMessageAttachments(body, messageId);
    const processedImages = attachments.images;
    const imageUrls = attachments.imageUrls;
    const attachmentReport = attachments.report;

    // T16 (Sprint 1, Outlook Suite): accept ONLY a namespaced `metadata.client`
    // subkey from the request body. Server keeps exclusive ownership of every
    // other top-level metadata field (deliveryMode, imageUrls, isHidden) —
    // clients cannot pollute or overwrite them.
    let clientMetadata: Record<string, unknown> | undefined;
    const rawMetadata = body.metadata;
    if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
      const rawClient = (rawMetadata as Record<string, unknown>).client;
      if (rawClient && typeof rawClient === 'object' && !Array.isArray(rawClient)) {
        clientMetadata = rawClient as Record<string, unknown>;
      }
    }

    const newMessage: CollabMessage = {
      id: messageId,
      channelId,
      from: participant,
      content: deliveredContent,
      timestamp: now,
      mentions: resolvedMentions,
      recipients,  // undefined = broadcast, array = targeted delivery
      replyTo: enrichedReplyTo,
      images: processedImages,
      metadata: {
        deliveryMode,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        ...(isHidden && { isHidden: true }),
        ...(isCrossChannel && {
          crossChannel: {
            sourceChannelId: sourceChannel!.id,
            sourceChannelName: sourceChannel!.name,
            deliveryChannelId: channel.id,
            deliveryChannelName: channel.name,
            senderId: participant.id,
            senderName: participant.name,
            senderType: participant.type,
            senderSource: participant.source,
            senderPid: participant.pid,
            senderProjectPath: participant.projectPath,
            targetParticipantId: recipientId,
            targetParticipantName: recipientId
              ? channel.participants.find(p => p.id === recipientId)?.name
              : undefined,
            replyTargetParticipantId: participant.id,
          },
        }),
        ...(clientMetadata && { client: clientMetadata }),
      },
      ...(silent && { silent: true }),
    };

    // Offline @mentions in a same-channel message: the sender gets an automatic
    // system notice after delivery (lib/collab-offline-mention-notice.ts).
    let offlineMentions: OfflineMention[] = [];
    if (!isCrossChannel) {
      try {
        offlineMentions = findOfflineMentions({ channel, data, sender: participant, message: newMessage, recipients });
      } catch (err) {
        console.error('[Collab] Offline-mention check failed:', err);
      }
    }

    if (!silent) {
      prepareDurableDelivery(participantId as string, newMessage, channel);
    }

    // Write message to appropriate storage
    if (silent) {
      const { appendSilentMessage } = await import('@/lib/collab-message-io');
      await appendSilentMessage(channelId as string, newMessage);
    } else {
      await appendChannelMessage(channelId as string, newMessage);
      await archiveOldMessages(channelId as string);
    }

    channel.lastActivity = now;
    participant.lastSeen = now;

    await saveChannels(data);

    // Persist runtime delivery authority before any SSE wake-up is emitted.
    if (!silent) {
      await enqueueDurableDeliveries(participantId as string, newMessage, channel);
    }

    // Emit SSE event so real-time listeners (Grok agents, frontend) receive it
    eventBus.emitEvent('collab:message', {
      channelId,
      message: newMessage,
    });

    // Deliver to terminal/PTY/Gemini participants (inbox writes, PTY routing)
    deliverMessage(participantId as string, newMessage, channel);

    if (offlineMentions.length > 0) {
      await postOfflineMentionNotice({ channel, sender: participant, offline: offlineMentions, hidden: isHidden });
    }

    emitApiEvent({
      action: isCrossChannel ? 'collab.cross_channel_message' : 'collab.message',
      status: 200,
      durationMs: 0,
      requestId: _auth.requestId,
      severity: 'info',
      actor: participantId as string,
      channelId: channelId as string,
      summary: isCrossChannel
        ? `${participant.name} sent cross-channel message from ${sourceChannel!.name} to ${channel.name}`
        : `${participant.name} sent message in ${channel.name}`,
    });

    return {
      messageId,
      sent: true,
      ...(offlineRecipients && { offlineRecipients }),
      ...(offlineMentions.length > 0 && { offlineMentions: offlineMentions.map(o => o.name) }),
      ...(attachmentReport && { attachments: attachmentReport }),
    };
  });
}

/**
 * collab.poll - Poll for new messages in a channel
 */
export async function poll(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  messages: CollabMessage[];
  participants: CollabParticipant[];
  timestamp: string;
  hasMore?: boolean;
  oldestTimestamp?: string;
}> {
  const channelId = body.channelId;
  const since = body.since;

  if (!channelId || typeof channelId !== 'string') {
    throw invalidField('channelId is required');
  }

  const data = await loadChannelsData();
  const channel = data.channels.find(ch => ch.id === channelId);

  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  const now = new Date().toISOString();

  // Read from per-channel message file, filtered to messages targeted at this participant
  const result = await getMessagesPaginated(channelId as string, {
    since: typeof since === 'string' ? since : undefined,
    participantId: typeof body.participantId === 'string' ? body.participantId : undefined,
  });

  return {
    messages: result.messages,
    participants: channel.participants,
    timestamp: now,
    hasMore: result.hasMore,
    oldestTimestamp: result.oldestTimestamp,
  };
}

/**
 * collab.heartbeat - Update presence status in a channel
 */
export async function heartbeat(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ updated: boolean }> {
  const channelId = body.channelId;
  const participantId = body.participantId;
  const activityStatus = body.activityStatus;

  if (!channelId || typeof channelId !== 'string') {
    throw invalidField('channelId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw invalidField('participantId is required');
  }

  return mutateChannels('agent-api:heartbeat', async data => {
    const channel = data.channels.find(ch => ch.id === channelId);

    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const participant = channel.participants.find(p => p.id === participantId);

    if (!participant) {
      throw new Error(`Participant not found: ${participantId}`);
    }

    const now = new Date().toISOString();
    participant.lastSeen = now;

    if (activityStatus && ['idle', 'typing', 'working'].includes(activityStatus as string)) {
      participant.activityStatus = activityStatus as CollabParticipant['activityStatus'];
      participant.activityUpdatedAt = now;
    }

    await saveChannels(data);

    return { updated: true };
  });
}

/**
 * collab.channels.create_subchannel - Create a private sub-channel within an existing channel
 */
export async function createSubChannel(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ channel: CollabChannel }> {
  const parentChannelId = body.parentChannelId || body.channelId;
  const participantIds = body.participantIds;
  const participantId = body.participantId;
  const name = body.name;

  if (!parentChannelId || typeof parentChannelId !== 'string') {
    throw new Error('parentChannelId (or channelId) is required');
  }
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    throw new Error('participantIds is required and must not be empty');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId (creator) is required');
  }

  return mutateChannels('agent-api:createSubChannel', async data => {
    const parentChannel = data.channels.find(ch => ch.id === parentChannelId);

    if (!parentChannel) {
      throw new Error(`Parent channel not found: ${parentChannelId}`);
    }

    // Prevent nesting beyond one level
    if (parentChannel.parentChannelId) {
      throw new Error('Cannot create a sub-channel inside another sub-channel');
    }

    // Validate creator is a member
    const creator = parentChannel.participants.find(p => p.id === participantId);
    if (!creator) {
      throw new Error('Creator is not a member of the parent channel');
    }

    // Validate all invitees are members
    const invitees: CollabParticipant[] = [];
    for (const pid of participantIds) {
      const p = parentChannel.participants.find(pp => pp.id === pid);
      if (!p) {
        throw new Error(`Participant ${pid} is not a member of the parent channel`);
      }
      if (pid !== participantId) {
        invitees.push(p);
      }
    }

    const now = new Date().toISOString();
    const subChannelId = crypto.randomUUID();
    const allMembers = [creator, ...invitees];
    const nameList = allMembers.slice(0, 3).map(p => p.name);
    const suffix = allMembers.length > 3 ? ` + ${allMembers.length - 3} more` : '';
    const subChannelName = typeof name === 'string' ? name : `${parentChannel.name} → ${nameList.join(', ')}${suffix}`;

    const creationMessage: CollabMessage = {
      id: crypto.randomUUID(),
      channelId: subChannelId,
      from: {
        id: 'system',
        type: 'user',
        name: 'System',
        source: 'DevFlow',
        joinedAt: now,
        lastSeen: now,
      },
      content: `Private conversation created by ${creator.name} with ${invitees.map(p => p.name).join(', ')}`,
      timestamp: now,
    };

    const subChannel: CollabChannel = {
      id: subChannelId,
      name: subChannelName,
      parentChannelId,
      createdAt: now,
      lastActivity: now,
      ownerId: participantId,
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

    data.channels.push(subChannel);
    await saveChannels(data);

    // Write creation message to per-channel file
    await appendChannelMessage(subChannelId, creationMessage);

    return { channel: subChannel };
  });
}

/**
 * collab.react - Add an emoji reaction to a message
 */
export async function react(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ reacted: boolean }> {
  const channelId = body.channelId;
  const messageId = body.messageId;
  const participantId = body.participantId;
  const emoji = body.emoji;

  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }
  if (!messageId || typeof messageId !== 'string') {
    throw new Error('messageId is required');
  }
  if (!participantId || typeof participantId !== 'string') {
    throw new Error('participantId is required');
  }
  if (!emoji || typeof emoji !== 'string') {
    throw new Error('emoji is required');
  }

  return mutateChannels('agent-api:react', async data => {
    const channel = data.channels.find(ch => ch.id === channelId);

    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    // Update reaction in per-channel message file
    const updated = await updateMessage(channelId as string, messageId as string, (message) => {
      if (!message.reactions) {
        message.reactions = {};
      }

      if (!message.reactions[emoji as string]) {
        message.reactions[emoji as string] = [participantId as string];
      } else if (message.reactions[emoji as string].includes(participantId as string)) {
        message.reactions[emoji as string] = message.reactions[emoji as string].filter(id => id !== participantId);
        if (message.reactions[emoji as string].length === 0) {
          delete message.reactions[emoji as string];
        }
      } else {
        message.reactions[emoji as string].push(participantId as string);
      }
    });

    if (!updated) {
      throw new Error(`Message not found: ${messageId}`);
    }

    return { reacted: true };
  });
}

/**
 * Recall an agent from another channel back to their home channel
 */
export async function recall(
  body: AgentApiRequest,
): Promise<unknown> {
  const res = await fetch(`${selfOrigin()}/api/collab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recall',
      channelId: body.channelId,
      participantId: body.participantId,
    }),
  });
  return res.json();
}
