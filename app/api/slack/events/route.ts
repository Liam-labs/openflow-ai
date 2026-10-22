/**
 * Slack Events API Webhook Endpoint
 *
 * Receives HTTP POST callbacks from Slack's Events API.
 * Replaces polling-based inbound message handling with push-based delivery.
 *
 * Handles:
 * - url_verification challenge (initial Slack App setup handshake)
 * - event_callback for message events (routed to handleSlackEvent)
 *
 * Security:
 * - Verifies X-Slack-Signature using HMAC-SHA256 with SLACK_SIGNING_SECRET
 * - Rejects requests older than 5 minutes (replay protection)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { getSigningSecret, isSlackConfigured } from '@/slack-integration/lib/slack-auth';
import { handleSlackEvent, type SlackMessageEvent } from '@/slack-integration/lib/slack-bridge';
import { readBridgeData } from '@/slack-integration/lib/slack-bridge-data';
import { tracked } from '@/lib/api-tracking';

/** Maximum age of a request timestamp before we reject it (5 minutes) */
const MAX_TIMESTAMP_AGE_SECONDS = 300;

/**
 * Verify Slack request signature.
 * See: https://api.slack.com/authentication/verifying-requests-from-slack
 */
function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  // Reject requests older than 5 minutes (replay attack protection). A timestamp that is not a whole number is refused outright:
  // parseInt gives NaN, and NaN > 300 is false, which would have passed the age check.
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const requestAge = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (!(requestAge <= MAX_TIMESTAMP_AGE_SECONDS)) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + createHmac('sha256', signingSecret)
    .update(sigBasestring, 'utf8')
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    // Buffers of different length throw — means signatures don't match
    return false;
  }
}

/**
 * Slack Events API envelope types
 */
interface SlackUrlVerification {
  type: 'url_verification';
  token: string;
  challenge: string;
}

interface SlackEventCallback {
  type: 'event_callback';
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackEventPayload;
  event_id: string;
  event_time: number;
}

interface SlackEventPayload {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  bot_id?: string;
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

type SlackEventEnvelope = SlackUrlVerification | SlackEventCallback;

/** Track recently processed event IDs to deduplicate retries */
const recentEventIds = new Map<string, number>();
const DEDUP_WINDOW_MS = (MAX_TIMESTAMP_AGE_SECONDS + 60) * 1000; // as long as a signed request stays valid, so a captured one cannot be replayed

function isDuplicate(eventId: string): boolean {
  const now = Date.now();

  // Prune old entries periodically
  if (recentEventIds.size > 500) {
    recentEventIds.forEach((time, id) => {
      if (now - time > DEDUP_WINDOW_MS) {
        recentEventIds.delete(id);
      }
    });
  }

  if (recentEventIds.has(eventId)) {
    return true;
  }

  recentEventIds.set(eventId, now);
  return false;
}

export const POST = tracked('/api/slack/events', async (request: NextRequest) => {
  // Check Slack is configured
  if (!isSlackConfigured()) {
    return NextResponse.json(
      { error: 'Slack integration not configured' },
      { status: 503 }
    );
  }

  // Read the raw body for signature verification
  const rawBody = await request.text();

  // Verify request signature
  const timestamp = request.headers.get('x-slack-request-timestamp') || '';
  const signature = request.headers.get('x-slack-signature') || '';

  if (!timestamp || !signature) {
    return NextResponse.json(
      { error: 'Missing Slack signature headers' },
      { status: 401 }
    );
  }

  let signingSecret: string;
  try {
    signingSecret = getSigningSecret();
  } catch {
    return NextResponse.json(
      { error: 'Slack signing secret not configured' },
      { status: 503 }
    );
  }

  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 401 }
    );
  }

  // Parse the verified body
  let payload: SlackEventEnvelope;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  // Handle url_verification challenge (Slack App setup handshake)
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Handle event_callback
  if (payload.type === 'event_callback') {
    const { event, event_id } = payload;

    // Deduplicate — Slack may retry if our response is slow
    if (isDuplicate(event_id)) {
      return NextResponse.json({ ok: true });
    }

    // Return 200 immediately, process async
    // Slack expects a response within 3 seconds or it retries
    if (event.type === 'message') {
      // Early echo prevention: skip bot messages at the webhook layer
      if (event.bot_id) {
        return NextResponse.json({ ok: true });
      }

      // Skip non-message subtypes (edits, deletes, joins, etc.)
      if (event.subtype && event.subtype !== 'file_share') {
        return NextResponse.json({ ok: true });
      }


      // Fire and forget — don't await
      processMessageEvent(event).catch((err) => {
        console.error('[slack-events] Error processing message event:', err);
      });
    }

    return NextResponse.json({ ok: true });
  }

  // Unknown event type — acknowledge anyway
  return NextResponse.json({ ok: true });
});

/**
 * Process a Slack message event asynchronously.
 * Routes to the existing handleSlackEvent() in slack-bridge.ts.
 *
 * Echo prevention layers (defense in depth):
 * 1. Webhook layer: bot_id check + subtype filter (above, before async)
 * 2. This function: botUserId check against config
 * 3. handleSlackEvent(): bot_id + subtype filter
 * 4. forwardToDevFlow(): senderUserId === botUserId check
 * 5. forwardToSlackDirect(): _slackBridge metadata source check
 */
async function processMessageEvent(
  event: SlackEventPayload,
): Promise<void> {
  // Echo prevention: check if sender is our own bot user
  // NOTE: api_app_id was previously checked here but that was WRONG —
  // api_app_id in Events API is always our app (the subscriber), not the sender.
  // The bot_id check at the webhook layer (line ~204) catches bot_message subtypes.
  // This check catches edge cases where bot_id might not be set.
  try {
    const bridgeData = await readBridgeData();
    const config = bridgeData.config;

    // Check if sender is our bot user
    if (config?.botUserId && event.user === config.botUserId) {
      return;
    }
  } catch {
    // If config read fails, still attempt processing — handleSlackEvent
    // has its own bot_id check as a safety net
  }

  // Convert Events API payload to SlackMessageEvent format
  const slackEvent: SlackMessageEvent = {
    type: 'message',
    subtype: event.subtype,
    channel: event.channel,
    user: event.user,
    text: event.text,
    ts: event.ts,
    bot_id: event.bot_id,
    team: event.team,
    files: event.files?.map((f) => ({
      id: f.id,
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
      url_private: f.url_private,
      url_private_download: f.url_private_download,
      filetype: f.filetype,
    })),
  };

  await handleSlackEvent(slackEvent);
}
