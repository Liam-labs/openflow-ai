/**
 * Teams Integration - Bot Handler
 *
 * Handles incoming Bot Framework activities and proactive messaging.
 * Uses the M365 Agents SDK pattern but implemented with direct HTTP
 * calls for maximum control and minimal dependencies.
 *
 * The bot is needed because Graph API application permissions cannot
 * send regular channel messages — only a bot can do proactive messaging.
 */

import { verifyBotJwt } from './bot-jwt';
import { ConversationReference } from './teams-types';
import { updateMapping, getMappings } from './teams-bridge-data';
import { PRODUCT_NAME } from '@/lib/brand';

const BOT_APP_ID = process.env.TEAMS_CLIENT_ID || '';

/** The only service address the bot talks to. Anyone can create a name under *.trafficmanager.net, and the bot's access token goes to it. */
export const MICROSOFT_SERVICE_URL = /^https:\/\/smba\.trafficmanager\.net\//i;
const BOT_APP_PASSWORD = process.env.TEAMS_CLIENT_SECRET || '';

// Cache bot token separately from Graph token (different audience)
let botToken: string | null = null;
let botTokenExpiresAt: number = 0;

// --- Bot Token Management ---

/**
 * Get a token for the Bot Framework service (different from Graph API token).
 * Audience: https://api.botframework.com
 */
async function getBotToken(): Promise<string> {
  const now = Date.now();
  if (botToken && botTokenExpiresAt > now + 5 * 60 * 1000) {
    return botToken;
  }

  const tenantId = process.env.TEAMS_TENANT_ID || '';

  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: BOT_APP_ID,
        client_secret: BOT_APP_PASSWORD,
        scope: 'https://api.botframework.com/.default',
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get bot token: ${err}`);
  }

  const data = await response.json();
  botToken = data.access_token;
  botTokenExpiresAt = now + (data.expires_in - 300) * 1000;
  return botToken!;
}

// --- Activity Handling ---

export interface BotActivity {
  type: string;
  id?: string;
  timestamp?: string;
  channelId?: string;
  serviceUrl?: string;
  from?: { id: string; name?: string; aadObjectId?: string };
  conversation?: {
    id: string;
    conversationType?: string;
    isGroup?: boolean;
    name?: string;
    tenantId?: string;
  };
  recipient?: { id: string; name?: string };
  text?: string;
  membersAdded?: Array<{ id: string; name?: string }>;
  channelData?: {
    team?: { id: string; name?: string };
    channel?: { id: string; name?: string };
    tenant?: { id: string };
    eventType?: string;
  };
}

/**
 * Process an incoming Bot Framework activity.
 * Called from the /api/teams-bot/messages endpoint.
 */
export async function processActivity(
  activity: BotActivity
): Promise<{ status: number; body?: unknown }> {
  switch (activity.type) {
    case 'conversationUpdate':
      return handleConversationUpdate(activity);
    case 'message':
      return handleMessage(activity);
    case 'installationUpdate':
      return handleInstallationUpdate(activity);
    default:
      console.log(`[Teams Bot] Unhandled activity type: ${activity.type}`);
      return { status: 200 };
  }
}

/**
 * Handle conversationUpdate — bot added to channel, member changes, etc.
 * Captures the ConversationReference for proactive messaging from ANY
 * conversationUpdate that has channel data, not just bot-added events.
 * This ensures mappings created after the bot was installed still get
 * their ConversationReference populated.
 */
async function handleConversationUpdate(
  activity: BotActivity
): Promise<{ status: number; body?: unknown }> {
  const membersAdded = activity.membersAdded || [];
  const botWasAdded = membersAdded.some(
    (m) => m.id === activity.recipient?.id
  );

  if (botWasAdded) {
    console.log(
      `[Teams Bot] Bot added to channel: ${activity.channelData?.channel?.name || activity.channelData?.channel?.id || 'unknown'}`
    );
  }

  // Capture ConversationReference from any conversationUpdate with channel data
  await captureConversationReference(activity, 'conversationUpdate');

  return { status: 200 };
}

/**
 * Handle incoming messages from Teams users.
 * These are forwarded to DevFlow via the bridge service.
 * Also opportunistically captures ConversationReference if missing.
 */
async function handleMessage(
  activity: BotActivity
): Promise<{ status: number; body?: unknown }> {
  // Message handling is done by the notification webhook,
  // not the bot endpoint. The bot endpoint receives messages
  // only if the bot is directly mentioned.
  console.log(
    `[Teams Bot] Message from ${activity.from?.name}: ${activity.text?.substring(0, 100)}`
  );

  // Opportunistically capture ConversationReference from message activities
  await captureConversationReference(activity, 'message');

  return { status: 200 };
}

/**
 * Handle bot installation/uninstallation events.
 */
async function handleInstallationUpdate(
  activity: BotActivity
): Promise<{ status: number; body?: unknown }> {
  const action = activity.channelData?.eventType;
  console.log(`[Teams Bot] Installation event: ${action}`);
  return { status: 200 };
}

// --- ConversationReference Capture ---

/**
 * Extract and store a ConversationReference from any activity that has channel data.
 * Works for both conversationUpdate and message activities.
 * Only updates mappings that are missing their ConversationReference.
 */
async function captureConversationReference(
  activity: BotActivity,
  source: string
): Promise<void> {
  // Need channel data and a valid service URL to build a reference
  const teamsChannelId = activity.channelData?.channel?.id;
  if (!teamsChannelId || !activity.serviceUrl || !activity.conversation?.id) {
    return;
  }
  if (!MICROSOFT_SERVICE_URL.test(activity.serviceUrl)) {
    console.warn('[Teams Bot] Not storing a conversation reference: service address is not Microsoft\'s');
    return;
  }

  const mappings = await getMappings({ teamsChannelId });
  if (mappings.length === 0) {
    return; // No mapping for this channel
  }

  // Only update mappings that are missing their ConversationReference
  const missingRef = mappings.filter((m) => !m.conversationReference);
  if (missingRef.length === 0) {
    return; // All mappings already have references
  }

  const ref = extractConversationReference(activity);

  for (const mapping of missingRef) {
    await updateMapping(mapping.id, { conversationReference: ref });
    console.log(
      `[Teams Bot] Captured ConversationReference for mapping "${mapping.id}" ` +
        `(channel: ${activity.channelData?.channel?.name || teamsChannelId}, source: ${source})`
    );
  }
}

// --- Proactive Messaging ---

/** Sender metadata for message formatting */
export interface SenderInfo {
  color?: string;       // Hex color from DevFlow participant (e.g. '#10B981')
  type?: string;        // 'user' | 'claude-terminal' etc.
  roleName?: string;    // 'Team Lead' | 'Backend Dev' etc.
}

// Map DevFlow hex colors to Adaptive Card name colors (no container backgrounds)
const COLOR_NAME_MAP: Record<string, string> = {
  '#8B5CF6': 'accent',    // purple
  '#F97316': 'warning',   // orange
  '#10B981': 'good',      // green
  '#F59E0B': 'warning',   // amber
  '#3B82F6': 'accent',    // blue
  '#EF4444': 'attention', // red
  '#EC4899': 'accent',    // pink
  '#06B6D4': 'accent',    // cyan
};

/**
 * Build an Adaptive Card for a DevFlow message.
 * Colored agent name for visual differentiation, no container background.
 * Text uses default sizing for natural Teams appearance.
 */
function buildAdaptiveCard(
  message: string,
  senderName: string,
  senderInfo?: SenderInfo
): Record<string, unknown> {
  const color = senderInfo?.color || '#8B5CF6';
  const nameColor = COLOR_NAME_MAP[color] || 'accent';
  const roleName = senderInfo?.roleName || '';
  const isAgent = senderInfo?.type === 'claude-terminal' ||
                  senderInfo?.type === 'claude-pty';

  // Build role suffix
  let roleText = '';
  if (roleName) {
    roleText = `  ·  ${roleName}`;
  } else if (isAgent) {
    roleText = `  ·  AI Agent`;
  }

  // Header: colored name + subtle role
  const headerColumns: Record<string, unknown>[] = [
    {
      type: 'Column',
      width: 'auto',
      items: [
        {
          type: 'TextBlock',
          text: senderName,
          weight: 'Bolder',
          color: nameColor,
          size: 'Default',
          spacing: 'None',
        },
      ],
    },
  ];

  if (roleText) {
    headerColumns.push({
      type: 'Column',
      width: 'stretch',
      items: [
        {
          type: 'TextBlock',
          text: roleText,
          isSubtle: true,
          size: 'Default',
          spacing: 'None',
        },
      ],
    });
  }

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      {
        type: 'ColumnSet',
        columns: headerColumns,
      },
      {
        type: 'TextBlock',
        text: message,
        wrap: true,
        size: 'Default',
        spacing: 'Small',
      },
    ],
  };
}

/**
 * Send a proactive message to a Teams channel using a stored ConversationReference.
 * This is the primary way to send messages FROM DevFlow TO Teams.
 * Uses Adaptive Cards with colored containers and colored agent names.
 */
export async function sendProactiveMessage(
  conversationRef: ConversationReference,
  message: string,
  senderName?: string,
  senderInfo?: SenderInfo
): Promise<void> {
  const token = await getBotToken();

  const name = senderName || PRODUCT_NAME;
  const card = buildAdaptiveCard(message, name, senderInfo);

  const activity = {
    type: 'message',
    // summary shows in notifications/toast only — prevents duplication with card
    summary: `${name}: ${message.substring(0, 100)}`,
    // importance: high triggers mobile push notifications for channel messages
    importance: 'high',
    from: conversationRef.bot,
    conversation: {
      id: conversationRef.conversation.id,
      isGroup: conversationRef.conversation.isGroup,
      conversationType: conversationRef.conversation.conversationType,
      tenantId: conversationRef.conversation.tenantId,
    },
    channelData: {
      teamsChannelId: conversationRef.conversation.id,
    },
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: card,
      },
    ],
  };

  if (!MICROSOFT_SERVICE_URL.test(conversationRef.serviceUrl || '')) {
    throw new Error('Refusing to send: the stored service address is not Microsoft\'s Bot Framework host');
  }
  const serviceUrl = conversationRef.serviceUrl.replace(/\/$/, '');
  const url = `${serviceUrl}/v3/conversations/${encodeURIComponent(conversationRef.conversation.id)}/activities`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(activity),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(
      `Failed to send proactive message (${response.status}): ${err}`
    );
  }
}

// --- Backfill ---

/**
 * Backfill ConversationReferences for mappings that are missing them.
 * Synthesizes references using:
 *   - serviceUrl + bot info from an existing working reference (same tenant)
 *   - teamsChannelId from the mapping itself (becomes the conversation.id)
 *
 * This is needed for channels that were mapped after the bot was installed,
 * before any conversationUpdate event arrived to capture the reference naturally.
 *
 * Returns the number of mappings backfilled.
 */
export async function backfillConversationReferences(): Promise<{
  backfilled: number;
  skipped: number;
  errors: string[];
}> {
  const allMappings = await getMappings();
  const missingRef = allMappings.filter((m) => !m.conversationReference);

  if (missingRef.length === 0) {
    return { backfilled: 0, skipped: 0, errors: [] };
  }

  // Find a donor reference (any mapping that has a working ConversationReference)
  const donor = allMappings.find((m) => m.conversationReference);
  let donorRef = donor?.conversationReference;

  // If no donor exists, construct a template from environment variables
  if (!donorRef) {
    const botId = process.env.TEAMS_CLIENT_ID || BOT_APP_ID;
    const tenantId = process.env.TEAMS_TENANT_ID || '';
    // Default Bot Framework service URL for commercial cloud
    const serviceUrl = process.env.TEAMS_SERVICE_URL || 'https://smba.trafficmanager.net/amer/';

    if (!botId || !tenantId) {
      return {
        backfilled: 0,
        skipped: missingRef.length,
        errors: [
          'No existing ConversationReference and missing env vars (TEAMS_CLIENT_ID, TEAMS_TENANT_ID) to synthesize one.',
        ],
      };
    }

    donorRef = {
      bot: { id: botId, name: `${PRODUCT_NAME} Bridge` },
      channelId: 'msteams',
      conversation: {
        conversationType: 'channel',
        id: '',  // Will be overridden per-mapping
        isGroup: true,
        name: '',
        tenantId,
      },
      serviceUrl,
    };
    console.log(`[Teams Bot] No donor reference found, synthesizing from env vars (serviceUrl: ${serviceUrl})`);
  }
  const errors: string[] = [];
  let backfilled = 0;

  for (const mapping of missingRef) {
    try {
      // Synthesize a ConversationReference using the donor's serviceUrl and bot info
      // The conversation.id is the Teams channel ID (a thread-style id)
      const syntheticRef: ConversationReference = {
        bot: { ...donorRef.bot },
        channelId: 'msteams',
        conversation: {
          conversationType: 'channel',
          id: mapping.teamsChannelId,
          isGroup: true,
          name: mapping.teamsChannelName,
          tenantId: donorRef.conversation.tenantId,
        },
        serviceUrl: donorRef.serviceUrl,
      };

      await updateMapping(mapping.id, { conversationReference: syntheticRef });
      console.log(
        `[Teams Bot] Backfilled ConversationReference for mapping "${mapping.id}" (channel: ${mapping.teamsChannelName})`
      );
      backfilled++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to backfill mapping ${mapping.id}: ${errMsg}`);
    }
  }

  return { backfilled, skipped: missingRef.length - backfilled, errors };
}

// --- Helpers ---

/**
 * Extract a ConversationReference from a bot activity.
 */
function extractConversationReference(
  activity: BotActivity
): ConversationReference {
  return {
    activityId: activity.id,
    bot: {
      id: activity.recipient?.id || '',
      name: activity.recipient?.name || `${PRODUCT_NAME} Bridge`,
    },
    channelId: activity.channelId || 'msteams',
    conversation: {
      conversationType:
        activity.conversation?.conversationType || 'channel',
      id: activity.conversation?.id || '',
      isGroup: activity.conversation?.isGroup ?? true,
      name: activity.conversation?.name || '',
      tenantId:
        activity.conversation?.tenantId ||
        activity.channelData?.tenant?.id ||
        '',
    },
    serviceUrl: activity.serviceUrl || '',
  };
}

/**
 * Verify a Bot Framework auth token: RS256 signature against Microsoft's published keys, issuer, audience (this bot's App ID),
 * expiry, and that the caller's serviceUrl is a smba.trafficmanager.net address matching the token. See lib/bot-jwt.ts.
 * Fails closed when no bot App ID is configured.
 */
export async function verifyBotToken(
  authHeader: string,
  serviceUrl?: string
): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('[Teams Bot] Auth rejected: missing or malformed Authorization header');
    return false;
  }

  // Only accept requests originating from Microsoft Bot Framework endpoints.
  if (serviceUrl) {
    // Microsoft's own service host only: anyone can create a name under *.trafficmanager.net, and the bot's access token and every
    // proactive message are sent to the serviceUrl a mapping stores.
    if (!MICROSOFT_SERVICE_URL.test(serviceUrl)) {
      console.warn(`[Teams Bot] Auth rejected: serviceUrl not in allowlist: ${serviceUrl}`);
      return false;
    }
  }

  // The signature, issuer, audience and expiry are all checked (lib/bot-jwt.ts). Without a configured bot app id nothing can pass.
  const botAppId =
    process.env.TEAMS_BOT_APP_ID ||
    process.env.MICROSOFT_APP_ID ||
    process.env.TEAMS_CLIENT_ID ||
    BOT_APP_ID;
  const verdict = await verifyBotJwt(authHeader.slice(7), { audiences: [botAppId], entraTenants: [process.env.TEAMS_TENANT_ID || ''], serviceUrl });
  if (!verdict.ok) {
    console.warn(`[Teams Bot] Auth rejected: ${verdict.reason}`);
    return false;
  }
  return true;
}
