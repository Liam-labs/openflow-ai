/**
 * Teams Bot - Graph API Lifecycle Notification Webhook
 *
 * POST /api/teams-bot/lifecycle
 *
 * Receives subscription lifecycle events from Microsoft Graph API:
 * - reauthorizationRequired: subscription needs renewal
 * - subscriptionRemoved: subscription was deleted
 *
 * Also handles the subscription validation handshake (responds with validationToken).
 */

import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';

export const POST = tracked('/api/teams-bot/lifecycle', async (request: NextRequest) => {
  try {
    // Check for subscription validation handshake
    const validationToken = request.nextUrl.searchParams.get('validationToken');
    if (validationToken) {
      return new NextResponse(validationToken, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const body = await request.json();
    const notifications = body.value || [];

    for (const notification of notifications) {
      const lifecycleEvent = notification.lifecycleEvent;

      if (lifecycleEvent === 'reauthorizationRequired') {
        // The subscription needs to be renewed. The sync orchestrator
        // handles this automatically, but log it for awareness.
      }

      if (lifecycleEvent === 'subscriptionRemoved') {
      }
    }

    return NextResponse.json({}, { status: 202 });
  } catch (err) {
    console.error('[Teams Lifecycle] Error:', err);
    return NextResponse.json({}, { status: 202 });
  }
});

export const GET = tracked('/api/teams-bot/lifecycle', async () => {
  return NextResponse.json({ status: 'ok', service: 'teams-lifecycle' });
});
