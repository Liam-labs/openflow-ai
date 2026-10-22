/**
 * Teams Bridge API (Frontend-facing)
 *
 * GET  /api/collab/teams-bridge - Get bridge status + mappings
 * POST /api/collab/teams-bridge - Actions: test, map, unmap, list-teams, list-channels
 *
 * No token auth required (same-origin frontend requests).
 * Delegates to the Teams integration library.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { isTeamsConfigured, testConnection } from '../../../../teams-integration/lib/teams-auth';
import { getBridgeStatus } from '../../../../teams-integration/lib/teams-bridge';
import { tracked } from '@/lib/api-tracking';
import {
  getMappings,
  createMapping,
  deleteMapping,
} from '../../../../teams-integration/lib/teams-bridge-data';
import {
  listTeams,
  listChannels,
} from '../../../../teams-integration/lib/teams-graph-client';

export const GET = tracked('/api/collab/teams-bridge', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const channelId = request.nextUrl.searchParams.get('channelId');

    const [status, mappings] = await Promise.all([
      getBridgeStatus(),
      getMappings(channelId ? { devflowChannelId: channelId } : undefined),
    ]);

    return NextResponse.json({
      success: true,
      status,
      mappings,
    });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
});

export const POST = tracked('/api/collab/teams-bridge', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'test': {
        if (!isTeamsConfigured()) {
          return NextResponse.json({
            success: false,
            error: 'Teams not configured. Set TEAMS_TENANT_ID, TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET in ~/.secrets',
          });
        }
        const result = await testConnection();
        return NextResponse.json({
          success: result.success,
          data: result,
          error: result.error,
        });
      }

      case 'list-teams': {
        if (!isTeamsConfigured()) {
          return NextResponse.json({ success: false, error: 'Teams not configured' });
        }
        const teams = await listTeams();
        return NextResponse.json({ success: true, teams });
      }

      case 'list-channels': {
        const { teamId } = body;
        if (!teamId) {
          return NextResponse.json({ success: false, error: 'Missing teamId' }, { status: 400 });
        }
        if (!isTeamsConfigured()) {
          return NextResponse.json({ success: false, error: 'Teams not configured' });
        }
        const channels = await listChannels(teamId);
        return NextResponse.json({ success: true, channels });
      }

      case 'map': {
        const {
          devflowChannelId,
          devflowChannelName,
          teamsTeamId,
          teamsTeamName,
          teamsChannelId,
          teamsChannelName,
        } = body;

        if (!devflowChannelId || !teamsTeamId || !teamsChannelId) {
          return NextResponse.json({
            success: false,
            error: 'Missing required: devflowChannelId, teamsTeamId, teamsChannelId',
          }, { status: 400 });
        }

        const mapping = await createMapping({
          devflowChannelId,
          devflowChannelName: devflowChannelName || '',
          teamsTeamId,
          teamsTeamName: teamsTeamName || '',
          teamsChannelId,
          teamsChannelName: teamsChannelName || '',
          syncEnabled: true,
          conversationReference: null,
          subscriptionId: null,
          subscriptionExpiresAt: null,
        });

        return NextResponse.json({ success: true, mapping });
      }

      case 'unmap': {
        const { mappingId } = body;
        if (!mappingId) {
          return NextResponse.json({ success: false, error: 'Missing mappingId' }, { status: 400 });
        }
        await deleteMapping(mappingId);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
});
