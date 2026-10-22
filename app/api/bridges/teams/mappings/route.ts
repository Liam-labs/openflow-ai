/**
 * Teams Bridge — Channel Mappings API
 *
 * GET  /api/bridges/teams/mappings              — list all mappings
 * POST /api/bridges/teams/mappings              — create | update | delete
 *
 * POST body:
 *   action: 'create' | 'update' | 'delete'
 *
 *   create: { devflowChannelId, devflowChannelName, teamsTeamId, teamsTeamName,
 *             teamsChannelId, teamsChannelName, syncEnabled? }
 *   update: { mappingId, ...partial fields }
 *   delete: { mappingId }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getMappings,
  createMapping,
  updateMapping,
  deleteMapping,
} from '@/teams-integration/lib/teams-bridge-data';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const GET = tracked('/api/bridges/teams/mappings', async (request: NextRequest) => {
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

export const POST = tracked('/api/bridges/teams/mappings', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json() as {
      action: 'create' | 'update' | 'delete';
      // create
      devflowChannelId?: string;
      devflowChannelName?: string;
      teamsTeamId?: string;
      teamsTeamName?: string;
      teamsChannelId?: string;
      teamsChannelName?: string;
      syncEnabled?: boolean;
      // update / delete
      mappingId?: string;
    };

    switch (body.action) {
      case 'create': {
        const {
          devflowChannelId,
          devflowChannelName,
          teamsTeamId,
          teamsTeamName,
          teamsChannelId,
          teamsChannelName,
        } = body;

        if (
          !devflowChannelId ||
          !devflowChannelName ||
          !teamsTeamId ||
          !teamsTeamName ||
          !teamsChannelId ||
          !teamsChannelName
        ) {
          return NextResponse.json(
            {
              error:
                'devflowChannelId, devflowChannelName, teamsTeamId, teamsTeamName, teamsChannelId, and teamsChannelName are required',
            },
            { status: 400 }
          );
        }

        const mapping = await createMapping({
          devflowChannelId,
          devflowChannelName,
          teamsTeamId,
          teamsTeamName,
          teamsChannelId,
          teamsChannelName,
          syncEnabled: body.syncEnabled ?? true,
          conversationReference: null,
          subscriptionId: null,
          subscriptionExpiresAt: null,
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
