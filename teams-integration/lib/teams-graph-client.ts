/**
 * Teams Integration - Microsoft Graph API Client
 *
 * Wraps Graph API endpoints for Teams operations:
 * - List teams and channels
 * - Read channel messages (with delta queries)
 * - Create, update, and delete channels
 * - Manage subscriptions (change notifications)
 *
 * NOTE: Sending messages requires a Bot (see teams-bot.ts).
 * Graph API ChannelMessage.Send is delegated-only.
 */

import { getGraphToken } from './teams-auth';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// --- Types ---

export interface GraphTeam {
  id: string;
  displayName: string;
  description: string;
}

export interface GraphChannel {
  id: string;
  displayName: string;
  description: string | null;
  membershipType: 'standard' | 'private' | 'shared';
}

export interface GraphMessage {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  body: {
    contentType: 'text' | 'html';
    content: string;
  };
  from: {
    application?: { id: string; displayName: string };
    user?: { id: string; displayName: string };
  } | null;
  attachments: Array<{
    id: string;
    contentType: string;
    contentUrl: string;
    name: string;
  }>;
  mentions: Array<{
    id: number;
    mentionText: string;
    mentioned: { user?: { id: string; displayName: string } };
  }>;
  messageType: string;
}

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState: string;
}

interface GraphError {
  code: string;
  message: string;
}

// --- Retry configuration ---

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Internal helpers ---

/**
 * Make a Graph API request with automatic retry for transient failures.
 * Retries on: 429 (rate limit), 500, 502, 503, 504 (server errors).
 * Does NOT retry on: 400, 401, 403, 404 (client errors).
 */
async function graphFetch<T>(
  path: string,
  options: RequestInit = {},
  retries: number = MAX_RETRIES
): Promise<T> {
  const token = await getGraphToken();

  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
      if (attempt < retries) {
        console.warn(
          `[Graph API] Rate limited (attempt ${attempt + 1}/${retries + 1}), retrying in ${waitMs}ms`
        );
        await sleep(waitMs);
        continue;
      }
      throw new RateLimitError(
        `Graph API rate limited after ${retries + 1} attempts. Retry after ${retryAfter || '5'}s`,
        waitMs
      );
    }

    // Retry on server errors (5xx)
    if (response.status >= 500 && attempt < retries) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `[Graph API] Server error ${response.status} (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
      continue;
    }

    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json();

    if (!response.ok) {
      const error = data?.error as GraphError;
      throw new GraphApiError(
        error?.message || `Graph API error: ${response.status}`,
        error?.code || 'UNKNOWN',
        response.status
      );
    }

    return data as T;
  }

  // Should not reach here, but TypeScript needs it
  throw new GraphApiError('Max retries exceeded', 'MAX_RETRIES', 0);
}

// --- Error classes ---

export class GraphApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterMs: number
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// --- Teams ---

/**
 * List all teams the app has access to.
 * Requires: Team.ReadBasic.All (application)
 */
export async function listTeams(): Promise<GraphTeam[]> {
  const data = await graphFetch<{ value: GraphTeam[] }>('/teams');
  return data.value;
}

/**
 * Get a specific team by ID.
 */
export async function getTeam(teamId: string): Promise<GraphTeam> {
  return graphFetch<GraphTeam>(`/teams/${teamId}`);
}

// --- Channels ---

/**
 * List channels in a team.
 * Requires: Channel.ReadBasic.All (application)
 */
export async function listChannels(teamId: string): Promise<GraphChannel[]> {
  const data = await graphFetch<{ value: GraphChannel[] }>(
    `/teams/${teamId}/channels`
  );
  return data.value;
}

/**
 * Get a specific channel.
 */
export async function getChannel(
  teamId: string,
  channelId: string
): Promise<GraphChannel> {
  return graphFetch<GraphChannel>(
    `/teams/${teamId}/channels/${channelId}`
  );
}

/**
 * Create a new channel in a team.
 * Requires: Channel.Create (application)
 */
export async function createChannel(
  teamId: string,
  displayName: string,
  description?: string,
  membershipType: 'standard' | 'private' = 'standard'
): Promise<GraphChannel> {
  return graphFetch<GraphChannel>(`/teams/${teamId}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      displayName,
      description: description || null,
      membershipType,
    }),
  });
}

/**
 * Delete a channel from a team.
 * Requires: Channel.Delete.All (application)
 *
 * Note: The "General" channel cannot be deleted.
 * Deleted channels are moved to a "Deleted" list and can be recovered
 * within 21 days (soft delete).
 */
export async function deleteChannel(
  teamId: string,
  channelId: string
): Promise<void> {
  await graphFetch<void>(`/teams/${teamId}/channels/${channelId}`, {
    method: 'DELETE',
  });
}

/**
 * Update a channel's display name and/or description.
 * Requires: Channel.ReadWrite.All (application) or ChannelSettings.ReadWrite.All
 *
 * Note: The "General" channel's displayName cannot be changed.
 */
export async function updateChannel(
  teamId: string,
  channelId: string,
  updates: { displayName?: string; description?: string | null }
): Promise<void> {
  await graphFetch<void>(`/teams/${teamId}/channels/${channelId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

// --- Messages ---

/**
 * Read messages from a channel.
 * Requires: ChannelMessage.Read.All (application)
 *
 * @param top - Number of messages to return (max 50)
 */
export async function listMessages(
  teamId: string,
  channelId: string,
  top: number = 50
): Promise<GraphMessage[]> {
  const data = await graphFetch<{ value: GraphMessage[] }>(
    `/teams/${teamId}/channels/${channelId}/messages?$top=${top}`
  );
  return data.value;
}

/**
 * Read messages using delta query (get only new/changed messages).
 * On first call, pass no deltaLink. On subsequent calls, pass the returned deltaLink.
 *
 * Returns messages and a deltaLink for the next call.
 */
export async function listMessagesDelta(
  teamId: string,
  channelId: string,
  deltaLink?: string
): Promise<{ messages: GraphMessage[]; deltaLink: string }> {
  const url = deltaLink ||
    `/teams/${teamId}/channels/${channelId}/messages/delta`;

  const data = await graphFetch<{
    value: GraphMessage[];
    '@odata.nextLink'?: string;
    '@odata.deltaLink'?: string;
  }>(url);

  // Collect all pages
  let allMessages = data.value || [];
  let nextLink = data['@odata.nextLink'];
  let newDeltaLink = data['@odata.deltaLink'] || '';

  // Follow pagination
  while (nextLink) {
    const page = await graphFetch<{
      value: GraphMessage[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    }>(nextLink);
    allMessages = allMessages.concat(page.value || []);
    nextLink = page['@odata.nextLink'];
    if (page['@odata.deltaLink']) {
      newDeltaLink = page['@odata.deltaLink'];
    }
  }

  return { messages: allMessages, deltaLink: newDeltaLink };
}

// --- Subscriptions (Change Notifications) ---

/**
 * Create a subscription for channel message notifications.
 * Requires: ChannelMessage.Read.All (application)
 *
 * The notificationUrl must be a publicly accessible HTTPS endpoint.
 * Max subscription lifetime for chatMessage: 4320 minutes (3 days).
 */
export async function createMessageSubscription(
  teamId: string,
  channelId: string,
  notificationUrl: string,
  lifecycleNotificationUrl: string,
  clientState: string,
  includeResourceData: boolean = false,
  encryptionCertificate?: string,
  encryptionCertificateId?: string
): Promise<GraphSubscription> {
  // Set expiration to 2 days (buffer before 3-day max)
  const expirationDateTime = new Date(
    Date.now() + 2 * 24 * 60 * 60 * 1000
  ).toISOString();

  const body: Record<string, unknown> = {
    changeType: 'created',
    notificationUrl,
    lifecycleNotificationUrl,
    resource: `/teams/${teamId}/channels/${channelId}/messages`,
    expirationDateTime,
    clientState,
  };

  if (includeResourceData && encryptionCertificate) {
    body.includeResourceData = true;
    body.encryptionCertificate = encryptionCertificate;
    body.encryptionCertificateId = encryptionCertificateId;
  }

  return graphFetch<GraphSubscription>('/subscriptions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Renew an existing subscription.
 * Should be called before the subscription expires (every ~2 days).
 */
export async function renewSubscription(
  subscriptionId: string
): Promise<GraphSubscription> {
  const expirationDateTime = new Date(
    Date.now() + 2 * 24 * 60 * 60 * 1000
  ).toISOString();

  return graphFetch<GraphSubscription>(
    `/subscriptions/${subscriptionId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ expirationDateTime }),
    }
  );
}

/**
 * Delete a subscription.
 */
export async function deleteSubscription(
  subscriptionId: string
): Promise<void> {
  await graphFetch<void>(`/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
  });
}

/**
 * List all active subscriptions.
 */
export async function listSubscriptions(): Promise<GraphSubscription[]> {
  const data = await graphFetch<{ value: GraphSubscription[] }>(
    '/subscriptions'
  );
  return data.value;
}

// --- Team Members ---

export interface GraphTeamMember {
  id: string;
  displayName: string;
  userId: string;
  email: string;
  roles: string[];
}

/**
 * List members of a team.
 * Requires: TeamMember.Read.All (application)
 */
export async function listTeamMembers(
  teamId: string
): Promise<GraphTeamMember[]> {
  const data = await graphFetch<{ value: GraphTeamMember[] }>(
    `/teams/${teamId}/members`
  );
  return data.value;
}
