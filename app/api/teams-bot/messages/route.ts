/**
 * Teams Bot - Messaging Endpoint
 *
 * POST /api/teams-bot/messages
 *
 * This is the Bot Framework messaging endpoint that Azure Bot Service
 * sends all bot activities to (conversationUpdate, message, installation, etc.)
 *
 * The endpoint URL must be configured in Azure Portal > Bot > Configuration > Messaging endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import {
  processActivity,
  verifyBotToken,
} from '../../../../teams-integration/lib/teams-bot';

export const POST = tracked('/api/teams-bot/messages', async (request: NextRequest) => {
  try {
    // Parse body first so we can pass serviceUrl to verifyBotToken for allowlist check.
    const activity = await request.json();

    // Verify the authorization header from Bot Framework.
    // serviceUrl from the activity body is passed to enforce the trafficmanager.net allowlist.
    const authHeader = request.headers.get('Authorization') || '';
    if (!(await verifyBotToken(authHeader, activity?.serviceUrl))) {
      // Only an explicit opt-in lets an unsigned request through, and never in production.
      const unsignedAllowed = process.env.TEAMS_BOT_ALLOW_UNSIGNED === '1' && process.env.NODE_ENV !== 'production';
      if (!unsignedAllowed) {
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }
    }


    const result = await processActivity(activity);

    return NextResponse.json(result.body || {}, { status: result.status });
  } catch (err) {
    console.error('[Teams Bot API] Error processing activity:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
