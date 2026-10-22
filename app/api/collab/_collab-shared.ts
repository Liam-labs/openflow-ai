/**
 * Shared utilities for /api/collab route handlers.
 * Extracted from route.ts to reduce per-file TypeScript compilation size.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import type {
  CollabChannel,
  CollabChannelsData,
  CollabParticipant,
  CollabMessage,
  AgentRosterEntry,
} from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import {
  appendMessages as appendChannelMessages,
} from '@/lib/collab-message-io';
import {
  CODEX_NATIVE_PARTICIPANT_SOURCE,
  isDurableCodexNativeParticipant,
  isInheritedLiveMember,
} from '@/lib/collab-participant-cleanup';
import { isMessageHiddenFromHumans } from '@/lib/hidden-messages';
import { participantPresence } from '@/lib/collab-presence';
import { dedupeAllChannelParticipants } from '@/lib/collab-participants';
import { appPath } from '@/lib/app-paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DATA_PATH = DataPaths.collabChannels;
export const COLLAB_IMAGES_DIR = appPath('.AppData', 'collab-images');
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_FILES_PER_MESSAGE = 10;
export { ONLINE_THRESHOLD_MS } from '@/lib/collab-presence';

// ---------------------------------------------------------------------------
// Optimization 1: Unread count cache
// Channel-list GET reads all message files just to compute unread counts.
// Cache per-channel unread maps with a 5s TTL to avoid repeated disk I/O.
// Invalidated immediately when a new message is posted to a channel.
// ---------------------------------------------------------------------------
interface UnreadCacheEntry {
  /** participantId → unread count */
  counts: Map<string, number>;
  /** Latest visible human/agent message, used for sidebar ordering. */
  lastMessageAt?: string;
  /** One-line "Sender: text" of that message, for the sidebar. */
  lastMessagePreview?: string;
  computedAt: number;
}
const UNREAD_CACHE_TTL_MS = 30000; // 30s — reduces repeated 300KB JSON parses from 8 concurrent agent polls
const unreadCache = new Map<string, UnreadCacheEntry>();

function getValidUnreadCacheEntry(channelId: string): UnreadCacheEntry | null {
  const entry = unreadCache.get(channelId);
  if (!entry) return null;
  if (Date.now() - entry.computedAt > UNREAD_CACHE_TTL_MS) {
    unreadCache.delete(channelId);
    return null;
  }
  return entry;
}

export function getCachedUnreadCounts(channelId: string): Map<string, number> | null {
  return getValidUnreadCacheEntry(channelId)?.counts ?? null;
}

export function getCachedLastMessageAt(channelId: string): string | undefined {
  return getValidUnreadCacheEntry(channelId)?.lastMessageAt;
}

export function getCachedLastMessagePreview(channelId: string): string | undefined {
  return getValidUnreadCacheEntry(channelId)?.lastMessagePreview;
}

export function setCachedUnreadCounts(
  channelId: string,
  counts: Map<string, number>,
  lastMessageAt?: string,
  lastMessagePreview?: string,
): void {
  unreadCache.set(channelId, { counts, lastMessageAt, lastMessagePreview, computedAt: Date.now() });
}

/** Call this whenever a new message is posted to invalidate stale counts. */
export function invalidateUnreadCache(channelId: string): void {
  unreadCache.delete(channelId);
}

// ---------------------------------------------------------------------------
// Optimization 2: Slim message format
// ---------------------------------------------------------------------------
export type SlimMessage = Omit<CollabMessage, 'from'> & { fromId: string };

/**
 * Slim messages carry only `fromId`; the client rebuilds `from` from the channel
 * participants. A sender who is not a participant (e.g. a cross-channel message
 * from an agent in another channel) cannot be rebuilt, so keep its full `from`.
 */
export function toSlimMessages(
  messages: CollabMessage[],
  participants: ReadonlyArray<{ id: string }> = [],
): Array<SlimMessage | CollabMessage> {
  const memberIds = new Set(participants.map(p => p.id));
  return messages.map(msg => {
    if (!memberIds.has(msg.from.id)) return msg;
    const { from, ...rest } = msg;
    return { ...rest, fromId: from.id };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a promise within ms milliseconds, or return undefined on timeout. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));
  return Promise.race([promise, timeout]);
}

/** Map MIME types to file extensions */
function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
    'text/html': 'html', 'text/css': 'css', 'text/javascript': 'js',
    'application/json': 'json', 'application/xml': 'xml',
    'application/zip': 'zip', 'application/gzip': 'gz',
    'application/x-tar': 'tar', 'application/x-7z-compressed': '7z',
    'application/x-rar-compressed': 'rar',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
    'application/vnd.ms-powerpoint': 'ppt',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
    'application/octet-stream': 'bin',
  };
  return map[mimeType] || mimeType.split('/').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
}

/**
 * Save a base64 data URL file to disk and return the serving URL.
 * Files are saved to .AppData/collab-images/ and served via /api/collab/images/[id]
 */
export async function saveFileToDisk(
  dataUrl: string,
  messageId: string,
  index: number,
  originalName?: string
): Promise<{ url: string; filename: string } | null> {
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;

    const mimeType = match[1];
    const base64Data = match[2];

    const sizeInBytes = Math.ceil(base64Data.length * 3 / 4);
    if (sizeInBytes > MAX_FILE_SIZE) {
      return null;
    }

    let ext = getExtensionFromMime(mimeType);
    if (originalName) {
      const nameExt = originalName.split('.').pop()?.toLowerCase();
      // Only a plain alphanumeric extension may reach the filename: the name is
      // client-supplied and must never add path separators.
      if (nameExt && /^[a-z0-9]{1,10}$/.test(nameExt)) ext = nameExt;
    }

    const filename = `${messageId}-${index}.${ext}`;
    const filePath = path.join(COLLAB_IMAGES_DIR, filename);

    await fs.mkdir(COLLAB_IMAGES_DIR, { recursive: true });
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));

    const url = `/api/collab/images/${filename}`;
    return { url, filename };
  } catch (error) {
    console.error('[Collab] Failed to save file:', error);
    return null;
  }
}

// Participant colors for UI
export const PARTICIPANT_COLORS = [
  '#8B5CF6', // Purple (Claude)
  '#3B82F6', // Blue (Gemini)
  '#10B981', // Green (User)
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#EC4899', // Pink
  '#6366F1', // Indigo
  '#14B8A6', // Teal
];

export function getNextColor(existingParticipants: CollabParticipant[]): string {
  const usedColors = new Set(existingParticipants.map(p => p.color));
  return PARTICIPANT_COLORS.find(c => !usedColors.has(c)) || PARTICIPANT_COLORS[0];
}

/**
 * Generate a stable participant ID based on identifying properties.
 * Same agent with same properties always gets the same ID, preventing duplicates.
 */
export function generateStableParticipantId(participant: {
  name?: string;
  type?: string;
  projectPath?: string;
  pid?: number;
}): string {
  const nameStr = participant.name || 'unknown';

  const identityString = [
    nameStr,
    participant.type || 'unknown',
    participant.projectPath || '',
  ].join(':');

  const hash = createHash('sha256').update(identityString).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Data I/O
// ---------------------------------------------------------------------------

const DEFAULT_CHANNELS_DATA: CollabChannelsData = {
  channels: [],
  lastUpdated: new Date().toISOString(),
};

export async function readData(): Promise<CollabChannelsData> {
  const data = await readJsonFile<CollabChannelsData>(DATA_PATH, DEFAULT_CHANNELS_DATA);
  // One record per participant id: a duplicate makes mark_read and the unread
  // count disagree. Heals in memory here; the next saveChannels persists it.
  dedupeAllChannelParticipants(data);
  return data;
}

// Writing the channels file is not done here: every change goes through
// `mutateChannels` / `saveChannels` in lib/collab-channel-store.ts, the only write path.

// ---------------------------------------------------------------------------
// Agent presence helpers
// ---------------------------------------------------------------------------

/**
 * Mark an agent as "away" in all OTHER channels where they appear as a participant.
 * Called when an agent joins a new channel.
 */
export function markAgentAwayInOtherChannels(
  data: CollabChannelsData,
  agentName: string,
  agentType: string | undefined,
  joinedChannelId: string,
  joinedChannelName: string,
  joiningProjectPath?: string
): void {
  const isAgentType = (t?: string) => t?.includes('terminal') || t === 'claude' || t?.includes('gemini');
  if (!isAgentType(agentType)) return;

  for (const otherChannel of data.channels) {
    if (otherChannel.id === joinedChannelId) continue;

    const matchingParticipant = otherChannel.participants.find(
      (p: CollabParticipant) => {
        if (p.name !== agentName || !isAgentType(p.type)) return false;
        if (joiningProjectPath && p.projectPath && p.projectPath !== joiningProjectPath) return false;
        return true;
      }
    );

    if (matchingParticipant) {
      matchingParticipant.status = 'away';
      matchingParticipant.awayInChannelId = joinedChannelId;
      matchingParticipant.awayInChannelName = joinedChannelName;

      if (otherChannel.roster?.agents) {
        const rosterAgent = otherChannel.roster.agents.find(
          (a: AgentRosterEntry) =>
            a.name === agentName &&
            a.channelId === otherChannel.id &&
            (a.status === 'running' || a.status === 'starting')
        );
        if (rosterAgent) {
          if (!rosterAgent.homeChannelId) {
            rosterAgent.homeChannelId = rosterAgent.channelId;
            rosterAgent.homeChannelName = otherChannel.name;
          }
          rosterAgent.status = 'away';
          rosterAgent.awayInChannelId = joinedChannelId;
          rosterAgent.awayInChannelName = joinedChannelName;
          otherChannel.roster.lastUpdated = new Date().toISOString();
        }
      }
    }
  }
}

/**
 * Clear "away" status for an agent returning to a channel.
 */
export function clearAgentAwayStatus(
  data: CollabChannelsData,
  agentName: string,
  channelId: string
): void {
  const channel = data.channels.find(c => c.id === channelId);
  if (!channel) return;

  const participant = channel.participants.find(
    (p: CollabParticipant) => p.name === agentName
  );

  if (participant && participant.status === 'away') {
    participant.status = undefined;
    participant.awayInChannelId = undefined;
    participant.awayInChannelName = undefined;
  }

  if (channel.roster?.agents) {
    const rosterAgent = channel.roster.agents.find(
      (a: AgentRosterEntry) => a.name === agentName && a.status === 'away'
    );
    if (rosterAgent) {
      rosterAgent.status = 'running';
      rosterAgent.awayInChannelId = undefined;
      rosterAgent.awayInChannelName = undefined;
      channel.roster.lastUpdated = new Date().toISOString();
    }
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

let migrationDone = false;
const MIGRATION_MARKER = path.join(DataPaths.collabMessages, '.migrated');

export async function migrateMessagesToSeparateFiles(): Promise<void> {
  if (migrationDone) return;
  migrationDone = true;

  const {
    ensureMessagesDir,
    readChannelMessages,
    writeChannelMessages,
    verifyChannelMessages,
    backupMessageFiles,
  } = await import('@/lib/collab-message-io');

  await backupMessageFiles();

  try {
    await fs.access(MIGRATION_MARKER);
    return;
  } catch {
    // Marker doesn't exist, proceed
  }

  await mutateChannels('collab-api:message-migration', async data => {
    let needsSave = false;

    await ensureMessagesDir();

    for (const channel of data.channels) {
      if (channel.messages && channel.messages.length > 0) {

        const existing = await readChannelMessages(channel.id);
        if (existing.messages.length > 0) {
          const existingIds = new Set(existing.messages.map(m => m.id));
          const newMsgs = channel.messages.filter(m => !existingIds.has(m.id));
          if (newMsgs.length > 0) {
            const merged = [...existing.messages, ...newMsgs].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            await writeChannelMessages(channel.id, {
              channelId: channel.id,
              messages: merged,
              lastUpdated: new Date().toISOString(),
            });
          }
        } else {
          await writeChannelMessages(channel.id, {
            channelId: channel.id,
            messages: channel.messages,
            lastUpdated: new Date().toISOString(),
          });
        }

        const verified = await verifyChannelMessages(channel.id);
        if (verified >= channel.messages.length) {
          channel.messages = [];
          needsSave = true;
        } else {
          console.error(`[Collab Migration] Write verification failed for "${channel.name}" — keeping inline messages as fallback (expected ${channel.messages.length}, got ${verified})`);
        }
      }
    }

    if (needsSave) {
      await saveChannels(data);
    }

    await fs.writeFile(MIGRATION_MARKER, new Date().toISOString(), 'utf-8');
  });
}

// ---------------------------------------------------------------------------
// Channel helpers
// ---------------------------------------------------------------------------

export function generateChannelName(): string {
  const adjectives = ['Swift', 'Bright', 'Quick', 'Sharp', 'Bold', 'Cool', 'Keen', 'Prime'];
  const nouns = ['Team', 'Squad', 'Hub', 'Zone', 'Space', 'Channel', 'Room', 'Lab'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const BLOCKED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function cleanupStaleParticipants(data: CollabChannelsData): Promise<number> {
  const now = Date.now();
  let totalRemoved = 0;

  for (const channel of data.channels) {
    const participantsToRemove: string[] = [];

    for (const participant of channel.participants) {
      const isBridgeParticipant = participant.id.startsWith('teams-')
        || participant.id.startsWith('slack-')
        || participant.source === CODEX_NATIVE_PARTICIPANT_SOURCE;
      if (participant.type === 'user' && !isBridgeParticipant) continue;

      // Codex Native is a durable channel-to-Desktop binding, not a process-backed
      // roster agent. Its lastSeen only changes when bridge traffic flows, so an
      // idle native chat must not be mistaken for an abandoned participant.
      if (isDurableCodexNativeParticipant(participant)) continue;

      const isRosterAgent = channel.roster?.agents?.some(
        a => a.participantId === participant.id || a.name === participant.name
      );
      if (isRosterAgent) continue;

      if (participant.status === 'away') continue;

      const parentChannel = channel.parentChannelId && channel.parentChannelId !== channel.id
        ? data.channels.find(c => c.id === channel.parentChannelId) : undefined;
      if (isInheritedLiveMember(participant, parentChannel, now)) continue;

      if (participant.pid && participant.projectPath?.startsWith('/home/')) {
        try {
          await fs.access(`/proc/${participant.pid}`);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            participantsToRemove.push(participant.id);
          } else {
          }
          continue;
        }
      }

      const lastSeen = participant.lastSeen ? new Date(participant.lastSeen).getTime() : 0;
      if ((now - lastSeen) > STALE_THRESHOLD_MS) {
        participantsToRemove.push(participant.id);
      }
    }

    if (participantsToRemove.length > 0) {
      const systemMessages: CollabMessage[] = [];
      for (const pId of participantsToRemove) {
        const participant = channel.participants.find(p => p.id === pId);
        const name = participant?.name || 'Unknown Agent';

        channel.participants = channel.participants.filter(p => p.id !== pId);

        systemMessages.push({
          id: randomUUID(),
          channelId: channel.id,
          from: {
            id: 'system',
            type: 'user',
            name: 'System',
            source: 'DevFlow',
            joinedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          },
          content: `${name} was removed (${participant?.pid ? 'session closed' : 'inactive for 30+ minutes'})`,
          timestamp: new Date().toISOString(),
        });

        totalRemoved++;
      }

      if (systemMessages.length > 0) {
        await appendChannelMessages(channel.id, systemMessages);
      }

      channel.lastActivity = new Date().toISOString();
    }

    // Prune blockedParticipantIds entries older than 7 days
    if (channel.blockedParticipantIds?.length && channel.blockedParticipantTimestamps) {
      const timestamps = channel.blockedParticipantTimestamps;
      const before = channel.blockedParticipantIds.length;
      channel.blockedParticipantIds = channel.blockedParticipantIds.filter(
        entry => !timestamps[entry] || (now - timestamps[entry]) < BLOCKED_TTL_MS
      );
      for (const key of Object.keys(timestamps)) {
        if (!channel.blockedParticipantIds.includes(key)) {
          delete timestamps[key];
        }
      }
      const pruned = before - channel.blockedParticipantIds.length;
      if (pruned > 0) {
      }
    }
  }

  return totalRemoved;
}

/**
 * Find the browser user from existing channels and add to a new channel.
 */
export function ensureBrowserUserInChannel(channel: CollabChannel, data: CollabChannelsData, now: string): void {
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
 * Compute unread message counts for each participant (respects targeted delivery)
 */
export function computeUnreadCounts(channel: CollabChannel, messages?: CollabMessage[]): void {
  const msgs = messages || [];
  for (const participant of channel.participants) {
    const messagesForParticipant = msgs.filter(m => {
      if (m.from.id === participant.id) return false;
      if (participant.type === 'user' && isMessageHiddenFromHumans(m)) return false;
      if (!m.recipients) return true;
      return m.recipients.includes(participant.id);
    });

    const baseline = participant.lastRead || participant.joinedAt;
    if (baseline) {
      const baselineTime = new Date(baseline).getTime();
      participant.unreadCount = messagesForParticipant.filter(
        m => new Date(m.timestamp).getTime() > baselineTime
      ).length;
    } else {
      participant.unreadCount = messagesForParticipant.length;
    }
  }
}

/**
 * Compute presence status for each participant based on lastSeen
 */
export function computePresenceStatus(channel: CollabChannel): void {
  const now = Date.now();
  const ACTIVITY_STALE_MS = 60 * 1000;
  for (const participant of channel.participants) {
    participant.status = participantPresence(participant, channel, now);

    if (participant.activityStatus && participant.activityStatus !== 'idle') {
      const activityAge = participant.activityUpdatedAt
        ? now - new Date(participant.activityUpdatedAt).getTime()
        : Infinity;
      if (activityAge > ACTIVITY_STALE_MS) {
        participant.activityStatus = 'idle';
        participant.activityUpdatedAt = new Date().toISOString();
      }
    }
  }
}
