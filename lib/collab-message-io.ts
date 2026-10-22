/**
 * Collab Message I/O Module
 *
 * Handles per-channel message storage, pagination, and archiving.
 * Messages are stored in individual files per channel (data/collab-messages/{channelId}.json)
 * instead of embedded in collab-channels.json, reducing I/O from 1.7MB to ~50KB per poll.
 *
 * Archive files are created when a channel exceeds 200 messages, splitting
 * the oldest 100 messages into {channelId}-archive-{timestamp}.json.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths, collabMessageFile, collabSilentMessageFile } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { emitCollabError } from '@/lib/event-bus';
import type {
  CollabMessage,
  CollabChannel,
  CollabChannelsData,
  ChannelMessagesData,
  ChannelMessagesArchive,
} from '@/lib/types';

const DEFAULT_CHANNELS_DATA: CollabChannelsData = { channels: [], lastUpdated: new Date().toISOString() };

/**
 * Load a single channel by ID without returning the full channels array.
 * Uses the readJsonFile cache (5s TTL) — avoids a disk read on repeated calls.
 * Returns null if the channel is not found.
 */
export async function getChannelById(channelId: string): Promise<CollabChannel | null> {
  const data = await readJsonFile<CollabChannelsData>(DataPaths.collabChannels, DEFAULT_CHANNELS_DATA);
  return data.channels.find(c => c.id === channelId) ?? null;
}

const MESSAGES_DIR = DataPaths.collabMessages;
const MAX_ACTIVE_MESSAGES = 200;
const ARCHIVE_BATCH_SIZE = 100;

/**
 * Ensure the collab-messages directory exists
 */
export async function ensureMessagesDir(): Promise<void> {
  try {
    await fs.mkdir(MESSAGES_DIR, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error('[collab-message-io] Failed to create messages dir:', error);
    }
  }
}

/**
 * Read all messages for a channel from its dedicated file
 */
export async function readChannelMessages(channelId: string): Promise<ChannelMessagesData> {
  const filePath = collabMessageFile(channelId);
  const defaultData: ChannelMessagesData = {
    channelId,
    messages: [],
    lastUpdated: new Date().toISOString(),
  };
  return readJsonFile<ChannelMessagesData>(filePath, defaultData);
}

/**
 * Write all messages for a channel atomically
 */
export async function writeChannelMessages(channelId: string, data: ChannelMessagesData): Promise<void> {
  await ensureMessagesDir();
  const filePath = collabMessageFile(channelId);
  data.lastUpdated = new Date().toISOString();
  await writeJsonFile(filePath, data);
}

/**
 * Append a message to a channel's message file (locked per-channel)
 */
export async function appendMessage(channelId: string, message: CollabMessage): Promise<void> {
  const filePath = collabMessageFile(channelId);
  await withFileLock(filePath, async () => {
    const data = await readChannelMessages(channelId);
    data.messages.push(message);
    await writeChannelMessages(channelId, data);
  });
}

/**
 * Append a message exactly once by its stable ID. Used by external transports
 * whose caller may retry after losing the HTTP response.
 */
export async function appendMessageIfAbsent(
  channelId: string,
  message: CollabMessage,
): Promise<{ message: CollabMessage; appended: boolean }> {
  const filePath = collabMessageFile(channelId);
  return withFileLock(filePath, async () => {
    const data = await readChannelMessages(channelId);
    const existing = data.messages.find(item => item.id === message.id);
    if (existing) return { message: existing, appended: false };
    data.messages.push(message);
    await writeChannelMessages(channelId, data);
    return { message, appended: true };
  });
}

/**
 * Append multiple messages to a channel's message file (locked per-channel)
 */
export async function appendMessages(channelId: string, messages: CollabMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const filePath = collabMessageFile(channelId);
  await withFileLock(filePath, async () => {
    const data = await readChannelMessages(channelId);
    data.messages.push(...messages);
    await writeChannelMessages(channelId, data);
  });
}

// ─── Silent Message I/O ───────────────────────────────────────────────────────

const MAX_SILENT_MESSAGES = 50;

/**
 * Read silent messages for a channel from its dedicated file
 */
export async function readSilentMessages(channelId: string): Promise<ChannelMessagesData> {
  const filePath = collabSilentMessageFile(channelId);
  const defaultData: ChannelMessagesData = {
    channelId,
    messages: [],
    lastUpdated: new Date().toISOString(),
  };
  return readJsonFile<ChannelMessagesData>(filePath, defaultData);
}

/**
 * Append a silent message to its dedicated per-channel file (locked, capped at 50)
 */
export async function appendSilentMessage(channelId: string, message: CollabMessage): Promise<void> {
  const filePath = collabSilentMessageFile(channelId);
  await withFileLock(filePath, async () => {
    const data = await readSilentMessages(channelId);
    data.messages.push(message);
    if (data.messages.length > MAX_SILENT_MESSAGES) {
      data.messages = data.messages.slice(-MAX_SILENT_MESSAGES);
    }
    data.lastUpdated = new Date().toISOString();
    await ensureMessagesDir();
    await writeJsonFile(filePath, data);
  });
}

// ─── End Silent Message I/O ───────────────────────────────────────────────────

/**
 * Find a message by ID in a channel's messages
 */
export async function findMessage(channelId: string, messageId: string): Promise<CollabMessage | undefined> {
  const data = await readChannelMessages(channelId);
  return data.messages.find(m => m.id === messageId);
}

/**
 * Find a recent message with identical content from the same sender.
 * Defends against model double-invocation where the agent shell-execs
 * collab_helper.py mid-reasoning AND the wrapper posts stdout afterward
 * (e.g. Antigravity/Gemini — see Expertise: Ask-owner T1.4 pattern).
 */
export async function findRecentDuplicate(
  channelId: string,
  participantId: string,
  content: string,
  windowMs: number = 10_000
): Promise<CollabMessage | undefined> {
  const data = await readChannelMessages(channelId);
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  for (let i = data.messages.length - 1; i >= 0; i--) {
    const m = data.messages[i];
    if (m.timestamp < cutoff) break; // older than window, stop scanning
    if (m.from?.id === participantId && m.content === content) return m;
  }
  return undefined;
}

/**
 * Update a message in-place (for reactions, pins, edits)
 * Returns true if the message was found and updated
 */
export async function updateMessage(
  channelId: string,
  messageId: string,
  updater: (msg: CollabMessage) => void
): Promise<boolean> {
  const filePath = collabMessageFile(channelId);
  return withFileLock(filePath, async () => {
    const data = await readChannelMessages(channelId);
    const msg = data.messages.find(m => m.id === messageId);
    if (!msg) return false;
    updater(msg);
    await writeChannelMessages(channelId, data);
    return true;
  });
}

/**
 * Delete a message by ID from a channel
 * Returns true if the message was found and deleted
 */
export async function deleteMessage(channelId: string, messageId: string): Promise<boolean> {
  const filePath = collabMessageFile(channelId);
  return withFileLock(filePath, async () => {
    const data = await readChannelMessages(channelId);
    const idx = data.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return false;
    data.messages.splice(idx, 1);
    await writeChannelMessages(channelId, data);
    return true;
  });
}

export interface PaginationOptions {
  before?: string;        // ISO timestamp cursor — return messages older than this
  since?: string;         // ISO timestamp — return messages newer than this
  limit?: number;         // Max messages to return (default 50, max 200)
  participantId?: string; // Filter by recipient (targeted delivery)
  oldestFirst?: boolean;  // Polling catch-up: page forward from `since`
}

export interface PaginatedMessages {
  messages: CollabMessage[];
  hasMore: boolean;
  oldestTimestamp?: string;
}

/**
 * Get messages with cursor-based pagination
 *
 * - `since`: Return messages newer than this timestamp (for polling)
 * - `before`: Return messages older than this timestamp (for scroll-back)
 * - `limit`: Max messages to return (default 50)
 * - `participantId`: Filter for targeted delivery (only broadcast + messages targeted to this participant)
 */
export async function getMessagesPaginated(
  channelId: string,
  options: PaginationOptions = {}
): Promise<PaginatedMessages> {
  const { before, since, limit: rawLimit, participantId, oldestFirst } = options;
  const limit = Math.min(Math.max(rawLimit || 50, 1), 200);

  // Read active messages
  const data = await readChannelMessages(channelId);
  let messages = data.messages;

  // Apply recipient filtering if participantId provided
  if (participantId) {
    messages = messages.filter(m => {
      if (!m.recipients) return true; // Broadcast
      return m.recipients.includes(participantId);
    });
  }

  // Polling mode: return messages newer than `since`
  if (since) {
    const sinceDate = new Date(since);
    // Use > (not >=) — boundary message was already processed by the caller.
    // >= caused the same message to be returned on every poll, wasting bandwidth.
    // Client dedup (injected_message_ids) catches edge cases if needed.
    const newMessages = messages.filter(m => new Date(m.timestamp) > sinceDate);
    // Apply limit to prevent message floods on catch-up polls.
    // Return the NEWEST messages (tail of the sorted array) so agents
    // see the most recent state, not the oldest backlog.
    const limited = newMessages.length > limit
      ? (oldestFirst ? newMessages.slice(0, limit) : newMessages.slice(-limit))
      : newMessages;
    return {
      messages: limited,
      hasMore: newMessages.length > limit,
    };
  }

  // Scroll-back mode: return messages older than `before`
  if (before) {
    const beforeDate = new Date(before);
    const olderMessages = messages.filter(m => new Date(m.timestamp) < beforeDate);

    // Take the last `limit` messages (most recent of the older ones)
    const sliced = olderMessages.slice(-limit);
    const hasMoreInActive = olderMessages.length > limit;

    // If we didn't fill the limit from active messages, check archives
    if (!hasMoreInActive && sliced.length < limit) {
      const archived = await loadArchivedMessages(channelId, before);
      if (archived.length > 0) {
        // Filter archived messages and combine
        let filteredArchived = archived;
        if (participantId) {
          filteredArchived = archived.filter(m => {
            if (!m.recipients) return true;
            return m.recipients.includes(participantId);
          });
        }
        const remaining = limit - sliced.length;
        const archivedSlice = filteredArchived.slice(-remaining);
        const combined = [...archivedSlice, ...sliced];
        return {
          messages: combined,
          hasMore: filteredArchived.length > remaining,
          oldestTimestamp: combined.length > 0 ? combined[0].timestamp : undefined,
        };
      }
    }

    return {
      messages: sliced,
      hasMore: hasMoreInActive,
      oldestTimestamp: sliced.length > 0 ? sliced[0].timestamp : undefined,
    };
  }

  // Default: return last `limit` messages (initial load)
  const sliced = oldestFirst ? messages.slice(0, limit) : messages.slice(-limit);
  const hasMore = messages.length > limit;

  // Also check if archives exist when active messages alone aren't enough
  let hasMoreFromArchive = false;
  if (!hasMore) {
    try {
      const files = await fs.readdir(MESSAGES_DIR);
      hasMoreFromArchive = files.some(f => f.startsWith(`${channelId}-archive-`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[collab-message-io] Failed to read messages dir for archive check:', error);
        emitCollabError(error, 'collab-message-io/getMessagesPaginated', { severity: 'low', context: { channelId } });
      }
    }
  }

  return {
    messages: sliced,
    hasMore: hasMore || hasMoreFromArchive,
    oldestTimestamp: sliced.length > 0 ? sliced[0].timestamp : undefined,
  };
}

/**
 * Archive old messages when a channel exceeds MAX_ACTIVE_MESSAGES
 * Moves the oldest ARCHIVE_BATCH_SIZE messages to an archive file
 */
export async function archiveOldMessages(channelId: string): Promise<void> {
  const filePath = collabMessageFile(channelId);
  await withFileLock(filePath, async () => {
    const data = await readChannelMessages(channelId);

    if (data.messages.length <= MAX_ACTIVE_MESSAGES) return;

    // Split: oldest ARCHIVE_BATCH_SIZE go to archive, rest stay active
    const toArchive = data.messages.slice(0, ARCHIVE_BATCH_SIZE);
    data.messages = data.messages.slice(ARCHIVE_BATCH_SIZE);

    if (toArchive.length === 0) return;

    // Create archive file
    const archiveTs = Date.now();
    const archivePath = path.join(MESSAGES_DIR, `${channelId}-archive-${archiveTs}.json`);
    const archive: ChannelMessagesArchive = {
      channelId,
      messages: toArchive,
      archivedAt: new Date().toISOString(),
      oldestTimestamp: toArchive[0].timestamp,
      newestTimestamp: toArchive[toArchive.length - 1].timestamp,
    };

    await ensureMessagesDir();
    await writeJsonFile(archivePath, archive);
    await writeChannelMessages(channelId, data);

    console.log(`[collab-message-io] Archived ${toArchive.length} messages for channel ${channelId}`);
  });
}

/**
 * Load archived messages for a channel, finding the right archive file for the cursor
 */
export async function loadArchivedMessages(
  channelId: string,
  before: string
): Promise<CollabMessage[]> {
  try {
    const files = await fs.readdir(MESSAGES_DIR);
    const archiveFiles = files
      .filter(f => f.startsWith(`${channelId}-archive-`) && f.endsWith('.json'))
      .sort(); // Sorted by timestamp suffix (ascending)

    if (archiveFiles.length === 0) return [];

    const beforeDate = new Date(before);
    const allOlderMessages: CollabMessage[] = [];

    // Aggregate messages from every archive that contains content older than `before`.
    // Earlier behavior returned only the first matching archive, so scroll-back would
    // stop after one batch even when many older archives existed.
    for (const file of archiveFiles) {
      const archivePath = path.join(MESSAGES_DIR, file);
      const archive = await readJsonFile<ChannelMessagesArchive>(archivePath, {
        channelId,
        messages: [],
        archivedAt: '',
        oldestTimestamp: '',
        newestTimestamp: '',
      });
      if (archive.messages.length === 0) continue;

      const oldestInArchive = archive.oldestTimestamp ? new Date(archive.oldestTimestamp) : null;
      if (oldestInArchive && oldestInArchive >= beforeDate) continue; // entire archive newer than cursor

      const newestInArchive = archive.newestTimestamp ? new Date(archive.newestTimestamp) : null;
      if (newestInArchive && newestInArchive < beforeDate) {
        allOlderMessages.push(...archive.messages);
      } else {
        allOlderMessages.push(...archive.messages.filter(m => new Date(m.timestamp) < beforeDate));
      }
    }

    allOlderMessages.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    return allOlderMessages;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[collab-message-io] Failed to load archived messages:', error);
      emitCollabError(error, 'collab-message-io/loadArchivedMessages', { severity: 'medium', context: { channelId } });
    }
    return [];
  }
}

/**
 * Delete all message files for a channel (when channel is deleted)
 */
export async function deleteChannelMessages(channelId: string): Promise<void> {
  try {
    const files = await fs.readdir(MESSAGES_DIR);
    const channelFiles = files.filter(
      f => f === `${channelId}.json`
        || f.startsWith(`${channelId}-archive-`)
        || f === `${channelId}-silent.json`
    );
    await Promise.all(
      channelFiles.map(f => fs.unlink(path.join(MESSAGES_DIR, f)).catch(() => {}))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[collab-message-io] Failed to delete channel messages:', error);
      emitCollabError(error, 'collab-message-io/deleteChannelMessages', { severity: 'medium', context: { channelId } });
    }
  }
}

const BACKUPS_DIR = path.join(MESSAGES_DIR, 'backups');
const MAX_BACKUPS = 5; // Keep last N backup sets

/**
 * Backup all per-channel message files to a timestamped subdirectory.
 * Called at server startup to prevent data loss during crash loops.
 * Keeps only the last MAX_BACKUPS sets to avoid unbounded disk growth.
 */
export async function backupMessageFiles(): Promise<void> {
  try {
    const files = await fs.readdir(MESSAGES_DIR);
    const messageFiles = files.filter(f => f.endsWith('.json') && f !== '.migrated');

    if (messageFiles.length === 0) {
      console.log('[collab-message-io] No message files to backup');
      return;
    }

    // Create timestamped backup directory
    const backupName = `backup-${Date.now()}`;
    const backupDir = path.join(BACKUPS_DIR, backupName);
    await fs.mkdir(backupDir, { recursive: true });

    // Copy all message files
    let totalMessages = 0;
    for (const file of messageFiles) {
      const src = path.join(MESSAGES_DIR, file);
      const dst = path.join(backupDir, file);
      try {
        const stat = await fs.stat(src);
        if (stat.isFile()) {
          await fs.copyFile(src, dst);
          totalMessages++;
        }
      } catch (error) {
        console.warn('[collab-message-io] Skipped backup for file:', file, error instanceof Error ? error.message : error);
      }
    }

    console.log(`[collab-message-io] Backed up ${totalMessages} message files to ${backupName}`);

    // Prune old backups (keep only MAX_BACKUPS)
    try {
      const backupDirs = await fs.readdir(BACKUPS_DIR);
      const sorted = backupDirs
        .filter(d => d.startsWith('backup-'))
        .sort();

      if (sorted.length > MAX_BACKUPS) {
        const toDelete = sorted.slice(0, sorted.length - MAX_BACKUPS);
        for (const old of toDelete) {
          const oldPath = path.join(BACKUPS_DIR, old);
          const oldFiles = await fs.readdir(oldPath);
          await Promise.all(oldFiles.map(f => fs.unlink(path.join(oldPath, f)).catch(() => {})));
          await fs.rmdir(oldPath).catch(() => {});
        }
        console.log(`[collab-message-io] Pruned ${toDelete.length} old backup(s)`);
      }
    } catch {
      // Pruning is best-effort
    }
  } catch (error) {
    console.error('[collab-message-io] Backup failed:', error);
  }
}

/**
 * Verify a per-channel message file was written correctly by reading it back.
 * Returns the message count if valid, or -1 if the file is missing/corrupted.
 */
export async function verifyChannelMessages(channelId: string): Promise<number> {
  try {
    const data = await readChannelMessages(channelId);
    return data.messages.length;
  } catch {
    return -1;
  }
}

const ARCHIVE_MAX_AGE_DAYS = 30;
const ARCHIVE_STALE_DAYS = 7;
const MIN_ACTIVE_MESSAGES = 50;

/**
 * Rotate message archives:
 * - Delete archive files older than 30 days
 * - Archive messages older than 7 days into archive files
 * - Always preserve the last MIN_ACTIVE_MESSAGES in the main file so
 *   inactive channels still render history in the UI (union of fresh + tail-N)
 * Call periodically (e.g., on server startup or daily cron).
 */
export async function rotateMessageArchives(): Promise<{ deleted: number; archived: number }> {
  let deleted = 0;
  let archived = 0;

  try {
    const files = await fs.readdir(MESSAGES_DIR);
    const now = Date.now();
    const maxAgeMs = ARCHIVE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const staleMs = ARCHIVE_STALE_DAYS * 24 * 60 * 60 * 1000;

    // 1. Delete archive files older than 30 days
    const archiveFiles = files.filter(f => f.includes('-archive-') && f.endsWith('.json'));
    for (const file of archiveFiles) {
      const tsMatch = file.match(/-archive-(\d+)\.json$/);
      if (!tsMatch) continue;
      const archiveTs = parseInt(tsMatch[1], 10);
      if (now - archiveTs > maxAgeMs) {
        try {
          await fs.unlink(path.join(MESSAGES_DIR, file));
          deleted++;
        } catch {
          // File already gone
        }
      }
    }

    // 2. Archive messages older than 7 days from active channel files
    const activeFiles = files.filter(f =>
      f.endsWith('.json') &&
      !f.includes('-archive-') &&
      !f.includes('-silent') &&
      f !== '.migrated' &&
      !f.startsWith('backup')
    );
    const staleThreshold = new Date(now - staleMs).toISOString();

    for (const file of activeFiles) {
      const channelId = file.replace('.json', '');
      const filePath = path.join(MESSAGES_DIR, file);

      try {
        await withFileLock(filePath, async () => {
          const data = await readChannelMessages(channelId);
          if (data.messages.length === 0) return;

          // Keep the union of: (1) fresh messages (<7d), (2) the last MIN_ACTIVE_MESSAGES by order.
          // This guarantees inactive channels still render history in the UI, while active
          // channels continue to shed genuinely stale overflow to archives.
          const tailStartIdx = Math.max(0, data.messages.length - MIN_ACTIVE_MESSAGES);
          const keepIds = new Set<string>();
          for (let i = tailStartIdx; i < data.messages.length; i++) {
            keepIds.add(data.messages[i].id);
          }
          for (const m of data.messages) {
            if (m.timestamp >= staleThreshold) keepIds.add(m.id);
          }

          const staleMessages = data.messages.filter(m => !keepIds.has(m.id));
          if (staleMessages.length === 0) return;

          // Move stale messages to archive
          const archivePath = path.join(MESSAGES_DIR, `${channelId}-archive-${now}.json`);
          const archive: ChannelMessagesArchive = {
            channelId,
            messages: staleMessages,
            archivedAt: new Date().toISOString(),
            oldestTimestamp: staleMessages[0].timestamp,
            newestTimestamp: staleMessages[staleMessages.length - 1].timestamp,
          };

          await writeJsonFile(archivePath, archive);

          // Keep the union set (preserves insertion order from original array)
          data.messages = data.messages.filter(m => keepIds.has(m.id));
          await writeChannelMessages(channelId, data);

          archived += staleMessages.length;
        });
      } catch (error) {
        console.error(`[collab-message-io] Rotation failed for ${channelId}:`, error);
      }
    }

    if (deleted > 0 || archived > 0) {
      console.log(`[collab-message-io] Archive rotation: deleted ${deleted} old archives, archived ${archived} stale messages`);
    }
  } catch (error) {
    console.error('[collab-message-io] Archive rotation failed:', error);
  }

  return { deleted, archived };
}
