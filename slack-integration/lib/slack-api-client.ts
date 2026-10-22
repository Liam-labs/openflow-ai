/**
 * Slack Integration - Slack Web API Client
 *
 * Wraps Slack Web API endpoints for channel and message operations:
 * - List channels
 * - Create, archive, unarchive, and rename channels
 * - Post and read messages
 * - Manage bot presence in channels
 *
 * Uses the Bot User OAuth Token (xoxb-...) for all requests.
 * Includes automatic retry with exponential backoff for rate limits.
 */

import { getBotToken } from './slack-auth';

const SLACK_API_BASE = 'https://slack.com/api';

// --- Types ---

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_member: boolean;
  topic?: { value: string };
  purpose?: { value: string };
  num_members?: number;
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  team?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    size: number;
    url_private?: string;
    url_private_download?: string;
    filetype?: string;
  }>;
}

export interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  is_bot: boolean;
  profile: {
    display_name: string;
    real_name: string;
    image_48?: string;
  };
}

// --- Error classes ---

export class SlackApiError extends Error {
  constructor(
    message: string,
    public readonly slackError: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

export class RateLimitError extends SlackApiError {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message, 'ratelimited');
    this.name = 'RateLimitError';
  }
}

// --- Retry configuration ---

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make a Slack Web API call with automatic retry on rate limits and server errors.
 */
async function slackFetch<T>(
  method: string,
  params: Record<string, unknown> = {},
  retries: number = MAX_RETRIES,
  useFormEncoding: boolean = false
): Promise<T> {
  const token = getBotToken();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Some Slack methods (users.info) require form-encoded params
      const contentType = useFormEncoding
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
      const body = useFormEncoding
        ? new URLSearchParams(
            Object.entries(params).map(([k, v]) => [k, String(v)])
          ).toString()
        : JSON.stringify(params);

      const res = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body,
      });

      // Handle HTTP-level rate limiting (429)
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
        if (attempt < retries) {
          console.warn(
            `[Slack API] Rate limited on ${method}, retrying in ${retryAfter}s (attempt ${attempt + 1}/${retries + 1})`
          );
          await sleep(retryAfter * 1000);
          continue;
        }
        throw new RateLimitError(
          `Rate limited on ${method} after ${retries + 1} attempts`,
          retryAfter
        );
      }

      // Retry on server errors (5xx)
      if (res.status >= 500) {
        if (attempt < retries) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `[Slack API] Server error ${res.status} on ${method}, retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
          continue;
        }
        throw new SlackApiError(
          `Slack API server error: ${res.status} on ${method}`,
          'server_error',
          res.status
        );
      }

      const data = await res.json() as T & { ok: boolean; error?: string };

      if (!data.ok) {
        // Don't retry client errors (they won't succeed on retry)
        throw new SlackApiError(
          `Slack API error on ${method}: ${data.error}`,
          data.error || 'unknown_error'
        );
      }

      return data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry SlackApiError (client errors) — only retry transient errors
      if (err instanceof SlackApiError && !(err instanceof RateLimitError)) {
        throw err;
      }

      // For network/timeout errors, retry
      if (attempt < retries && !(err instanceof SlackApiError)) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Slack API] Transient error on ${method}, retrying in ${delayMs}ms: ${lastError.message}`
        );
        await sleep(delayMs);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error(`slackFetch failed after ${retries + 1} attempts`);
}

// --- Channels ---

/**
 * List channels in the workspace.
 * Returns public channels by default, or all channels the bot can see.
 */
export async function listChannels(options?: {
  types?: string;
  limit?: number;
  excludeArchived?: boolean;
}): Promise<SlackChannel[]> {
  const allChannels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, unknown> = {
      types: options?.types || 'public_channel,private_channel',
      limit: options?.limit || 200,
      exclude_archived: options?.excludeArchived ?? true,
    };
    if (cursor) params.cursor = cursor;

    const data = await slackFetch<{
      ok: boolean;
      channels: SlackChannel[];
      response_metadata?: { next_cursor?: string };
    }>('conversations.list', params);

    allChannels.push(...data.channels);
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return allChannels;
}

/**
 * Get info about a specific channel.
 */
export async function getChannel(channelId: string): Promise<SlackChannel> {
  const data = await slackFetch<{
    ok: boolean;
    channel: SlackChannel;
  }>('conversations.info', { channel: channelId });

  return data.channel;
}

/**
 * Create a new channel.
 */
export async function createChannel(
  name: string,
  isPrivate: boolean = false
): Promise<SlackChannel> {
  const data = await slackFetch<{
    ok: boolean;
    channel: SlackChannel;
  }>('conversations.create', {
    name,
    is_private: isPrivate,
  });

  return data.channel;
}

/**
 * Archive a channel (Slack's equivalent of delete — channels can be unarchived).
 */
export async function archiveChannel(channelId: string): Promise<void> {
  await slackFetch<{ ok: boolean }>('conversations.archive', {
    channel: channelId,
  });
}

/**
 * Unarchive a channel.
 */
export async function unarchiveChannel(channelId: string): Promise<void> {
  await slackFetch<{ ok: boolean }>('conversations.unarchive', {
    channel: channelId,
  });
}

/**
 * Rename a channel.
 */
export async function renameChannel(
  channelId: string,
  name: string
): Promise<SlackChannel> {
  const data = await slackFetch<{
    ok: boolean;
    channel: SlackChannel;
  }>('conversations.rename', {
    channel: channelId,
    name,
  });

  return data.channel;
}

/**
 * Set the channel topic.
 */
export async function setChannelTopic(
  channelId: string,
  topic: string
): Promise<void> {
  await slackFetch<{ ok: boolean }>('conversations.setTopic', {
    channel: channelId,
    topic,
  });
}

/**
 * Set the channel purpose (description).
 */
export async function setChannelPurpose(
  channelId: string,
  purpose: string
): Promise<void> {
  await slackFetch<{ ok: boolean }>('conversations.setPurpose', {
    channel: channelId,
    purpose,
  });
}

/**
 * Join a channel (bot joins itself).
 */
export async function joinChannel(channelId: string): Promise<void> {
  await slackFetch<{ ok: boolean }>('conversations.join', {
    channel: channelId,
  });
}

/**
 * Invite users to a channel.
 * Accepts one or more Slack user IDs (comma-separated if multiple).
 */
export async function inviteToChannel(
  channelId: string,
  userIds: string | string[]
): Promise<void> {
  const users = Array.isArray(userIds) ? userIds.join(',') : userIds;
  await slackFetch<{ ok: boolean }>('conversations.invite', {
    channel: channelId,
    users,
  });
}

// --- Messages ---

/**
 * Post a message to a channel.
 * Returns the message timestamp (ts) which serves as the message ID.
 */
export async function postMessage(
  channelId: string,
  text: string,
  options?: {
    username?: string;
    iconEmoji?: string;
    threadTs?: string;
    unfurlLinks?: boolean;
  }
): Promise<string> {
  const params: Record<string, unknown> = {
    channel: channelId,
    text,
    unfurl_links: options?.unfurlLinks ?? false,
  };

  if (options?.username) params.username = options.username;
  if (options?.iconEmoji) params.icon_emoji = options.iconEmoji;
  if (options?.threadTs) params.thread_ts = options.threadTs;

  const data = await slackFetch<{
    ok: boolean;
    ts: string;
  }>('chat.postMessage', params);

  return data.ts;
}

/**
 * Fetch message history for a channel.
 * Returns messages in reverse chronological order (newest first).
 */
export async function getMessages(
  channelId: string,
  options?: {
    oldest?: string;
    latest?: string;
    limit?: number;
    cursor?: string;
  }
): Promise<{ messages: SlackMessage[]; nextCursor?: string }> {
  const params: Record<string, unknown> = {
    channel: channelId,
    limit: options?.limit || 50,
  };

  if (options?.oldest) params.oldest = options.oldest;
  if (options?.latest) params.latest = options.latest;
  if (options?.cursor) params.cursor = options.cursor;

  const data = await slackFetch<{
    ok: boolean;
    messages: SlackMessage[];
    response_metadata?: { next_cursor?: string };
  }>('conversations.history', params);

  return {
    messages: data.messages,
    nextCursor: data.response_metadata?.next_cursor || undefined,
  };
}

// --- Users ---

/**
 * Get info about a Slack user.
 */
export async function getUser(userId: string): Promise<SlackUser> {
  // users.info requires form-encoded params (JSON body returns user_not_found)
  const data = await slackFetch<{
    ok: boolean;
    user: SlackUser;
  }>('users.info', { user: userId }, MAX_RETRIES, true);

  return data.user;
}

/**
 * Look up a user's display name, with caching.
 */
const userNameCache = new Map<string, string>();

export async function getUserDisplayName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const user = await getUser(userId);
    const displayName =
      user.profile.display_name ||
      user.profile.real_name ||
      user.real_name ||
      user.name;
    userNameCache.set(userId, displayName);
    return displayName;
  } catch {
    return userId; // Fallback to raw user ID
  }
}

// --- File Uploads ---

/**
 * Upload a file to a Slack channel using Slack's v2 upload flow:
 * 1. files.getUploadURLExternal — get a presigned URL
 * 2. PUT the file content to the presigned URL
 * 3. files.completeUploadExternal — finalize and share to channel
 *
 * Requires `files:write` scope on the bot token.
 *
 * @param channelId - Slack channel to share the file in
 * @param fileBuffer - File content as a Buffer
 * @param filename - Original filename (e.g., "screenshot.png")
 * @param options - Optional title and alt text
 */
export async function uploadFile(
  channelId: string,
  fileBuffer: Buffer,
  filename: string,
  options?: { title?: string; altText?: string; initialComment?: string }
): Promise<{ fileId: string }> {
  const token = getBotToken();

  // Step 1: Get upload URL
  const uploadUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      filename,
      length: String(fileBuffer.length),
    }).toString(),
  });

  const uploadUrlData = await uploadUrlRes.json() as {
    ok: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  };

  if (!uploadUrlData.ok || !uploadUrlData.upload_url || !uploadUrlData.file_id) {
    throw new SlackApiError(
      `Failed to get upload URL: ${uploadUrlData.error}`,
      uploadUrlData.error || 'upload_url_failed'
    );
  }

  // Step 2: PUT file content to presigned URL
  const putRes = await fetch(uploadUrlData.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob([fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength) as ArrayBuffer]),
  });

  if (!putRes.ok) {
    throw new SlackApiError(
      `Failed to upload file content: HTTP ${putRes.status}`,
      'upload_put_failed',
      putRes.status
    );
  }

  // Step 3: Complete upload and share to channel
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{
        id: uploadUrlData.file_id,
        title: options?.title || filename,
      }],
      channel_id: channelId,
      ...(options?.initialComment ? { initial_comment: options.initialComment } : {}),
    }),
  });

  const completeData = await completeRes.json() as { ok: boolean; error?: string };

  if (!completeData.ok) {
    throw new SlackApiError(
      `Failed to complete file upload: ${completeData.error}`,
      completeData.error || 'complete_upload_failed'
    );
  }

  return { fileId: uploadUrlData.file_id };
}
