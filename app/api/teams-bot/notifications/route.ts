/**
 * Teams Bot - Graph API Notification Webhook
 *
 * POST /api/teams-bot/notifications
 *
 * Receives change notifications from Microsoft Graph API subscriptions.
 * When a new message is posted in a mapped Teams channel, Graph sends
 * a notification here, and we forward it to the DevFlow Collab channel.
 *
 * Also handles the subscription validation handshake (responds with validationToken).
 */

import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import {
  forwardToDevFlow,
  handleNotification,
  GraphNotification,
} from '../../../../teams-integration/lib/teams-bridge';
import {
  listMessages,
} from '../../../../teams-integration/lib/teams-graph-client';

import { matchesTeamsNotificationSecret } from '../../../../teams-integration/lib/notification-secret';
import { requireAuthOrLocal } from '@/lib/api-auth';
// Client state secret for validating notifications are from our subscription

export const POST = tracked('/api/teams-bot/notifications', async (request: NextRequest) => {
  try {
    // Check for subscription validation handshake
    const validationToken = request.nextUrl.searchParams.get('validationToken');
    if (validationToken) {
      // Graph API sends a validation request when creating a subscription.
      // We must respond with the validationToken in plain text.
      return new NextResponse(validationToken, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const body = await request.json();

    // Graph API sends notifications as an array in body.value
    const notifications: GraphNotification[] = body.value || [];


    for (const notification of notifications) {
      // Validate client state
      if (!matchesTeamsNotificationSecret(notification.clientState)) {
        continue;
      }

      // Handle the notification
      await handleNotification(notification);

      // For basic notifications (no inline resource data),
      // we need to fetch the message via Graph API
      if (notification.changeType === 'created' && !notification.resourceData) {
        await fetchAndForwardMessage(notification);
      }

      // For rich notifications with inline resource data
      if (notification.changeType === 'created' && notification.resourceData) {
        await handleRichNotification(notification);
      }
    }

    // Must respond 202 Accepted to acknowledge
    return NextResponse.json({}, { status: 202 });
  } catch (err) {
    console.error('[Teams Notifications] Error:', err);
    // Still return 202 — failing to process shouldn't cause Graph to retry endlessly
    return NextResponse.json({}, { status: 202 });
  }
});

/**
 * Fetch the actual message from Graph API and forward to DevFlow.
 * Used when we get a basic notification (no inline data).
 */
async function fetchAndForwardMessage(
  notification: GraphNotification
): Promise<void> {
  // Parse resource path: /teams({team-id})/channels({channel-id})/messages({msg-id})
  const teamMatch = notification.resource.match(/teams\('([^']+)'\)/);
  const channelMatch = notification.resource.match(/channels\('([^']+)'\)/);

  if (!teamMatch || !channelMatch) {
    return;
  }

  const teamId = teamMatch[1];
  const channelId = channelMatch[1];

  try {
    // Fetch the most recent message(s) from the channel
    const messages = await listMessages(teamId, channelId, 1);

    for (const msg of messages) {
      // Skip system messages
      if (msg.messageType !== 'message') continue;

      // Skip messages from our bot (echo prevention)
      const botId = process.env.TEAMS_CLIENT_ID;
      if (msg.from?.application?.id === botId) continue;

      const senderName =
        msg.from?.user?.displayName ||
        msg.from?.application?.displayName ||
        'Unknown';

      await forwardToDevFlow(
        channelId,
        msg.id,
        senderName,
        msg.body.content,
        msg.createdDateTime,
        msg.attachments?.length > 0 ? msg.attachments : undefined
      );
    }
  } catch (err) {
    console.error(
      `[Teams Notifications] Error fetching message: ${err}`
    );
  }
}

/**
 * Handle a rich notification that includes encrypted resource data.
 * Falls back to Graph API fetch — inline decryption requires encryption
 * certificates and is deferred until certificates are configured.
 */
async function handleRichNotification(
  notification: GraphNotification
): Promise<void> {
  // Rich notifications include the message data inline but encrypted.
  // Fall back to fetching via Graph API until encryption certificates are set up.
  await fetchAndForwardMessage(notification);
}

/**
 * GET handler for lifecycle notifications.
 * Graph API may send GET requests to check endpoint availability.
 */
export const GET = tracked('/api/teams-bot/notifications', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  return NextResponse.json({ status: 'ok', service: 'teams-notifications' });
});
