/**
 * Slack Bridge — Channel Mappings API
 *
 * GET  /api/bridges/slack/mappings              — list all mappings
 * POST /api/bridges/slack/mappings              — create | update | delete
 *
 * POST body:
 *   action: 'create' | 'update' | 'delete'
 *
 *   create: { devflowChannelId, devflowChannelName, slackChannelId, slackChannelName, syncEnabled?, botInChannel? }
 *   update: { mappingId, ...partial fields }
 *   delete: { mappingId }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getMappings,
  createMapping,
  updateMapping,
  deleteMapping,
} from '@/slack-integration/lib/slack-bridge-data';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const GET = tracked('/api/bridges/slack/mappings', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const mappings = await getMappings();
    return NextResponse.json({ mappings });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

export const POST = tracked('/api/bridges/slack/mappings', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json() as {
      action: 'create' | 'update' | 'delete';
      // create
      devflowChannelId?: string;
      devflowChannelName?: string;
      slackChannelId?: string;
      slackChannelName?: string;
      syncEnabled?: boolean;
      botInChannel?: boolean;
      // update / delete
      mappingId?: string;
    };

    switch (body.action) {
      case 'create': {
        const { devflowChannelId, devflowChannelName, slackChannelId, slackChannelName } = body;
        if (!devflowChannelId || !devflowChannelName || !slackChannelId || !slackChannelName) {
          return NextResponse.json(
            { error: 'devflowChannelId, devflowChannelName, slackChannelId, and slackChannelName are required' },
            { status: 400 }
          );
        }
        const mapping = await createMapping({
          devflowChannelId,
          devflowChannelName,
          slackChannelId,
          slackChannelName,
          syncEnabled: body.syncEnabled ?? true,
          botInChannel: body.botInChannel ?? false,
        });
        return NextResponse.json({ success: true, mapping });
      }

      case 'update': {
        if (!body.mappingId) {
          return NextResponse.json({ error: 'mappingId is required' }, { status: 400 });
        }
        const { mappingId, action: _action, ...updates } = body;
        const mapping = await updateMapping(mappingId, updates);
        return NextResponse.json({ success: true, mapping });
      }

      case 'delete': {
        if (!body.mappingId) {
          return NextResponse.json({ error: 'mappingId is required' }, { status: 400 });
        }
        await deleteMapping(body.mappingId);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${(body as { action: string }).action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
