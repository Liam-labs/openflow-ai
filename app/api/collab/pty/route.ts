/**
 * PTY Session Management API — thin dispatcher.
 *
 * POST /api/collab/pty — delegates to _handlers/ by action group
 * GET  /api/collab/pty — list PTY sessions (optional ?channelId=X filter)
 *
 * Handler modules:
 *   _handlers/spawn.ts        — spawn, message, close, detach
 *   _handlers/roster-ops.ts   — roster CRUD + skills/personalities listing
 *   _handlers/message-inject.ts — roster lifecycle (spawn/kill/respawn/launch)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import type { CollabPtySession } from '@/lib/types';
import {
  getChannelPtySessions,
  getAllActivePtySessions,
} from '@/lib/collab-pty';
import { tracked, withTiming } from '@/lib/api-tracking';
import type { PtyActionRequest, PtyListResponse } from './_pty-shared';

// Spawn / message / close / detach
import {
  handleSpawn,
  handlePtyMessage,
  handleClose,
  handleDetach,
} from './_handlers/spawn';

// Roster CRUD + skills/personalities
import {
  handleSkillsList,
  handlePersonalitiesList,
  handleSpawnCapabilities,
  handleRoleCharacterGenerate,
  handleRosterList,
  handleRosterAdd,
  handleRosterAddFromParticipant,
  handleRosterRemove,
  handleRosterUpdate,
  handleRosterDirectivesRead,
  handleRosterDirectivesWrite,
  handleRosterSystemOwnershipRead,
  handleRosterSystemOwnershipWrite,
} from './_handlers/roster-ops';

// Roster lifecycle (spawn/kill/respawn/launch)
import {
  handleRosterSpawnAction,
  handleRosterIdentitySwitchAction,
  handleRosterKillAction,
  handleRosterRespawnAction,
  handleRosterLaunchAll,
  handleRosterKillAll,
  handleRosterOpenTerminal,
  handleRosterCompact,
} from './_handlers/message-inject';

// ---------------------------------------------------------------------------
// GET /api/collab/pty
// ---------------------------------------------------------------------------

export const GET = withTiming('/api/collab/pty', tracked('/api/collab/pty', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = request.nextUrl;
    const channelId = searchParams.get('channelId');
    const sessions: CollabPtySession[] = channelId
      ? getChannelPtySessions(channelId)
      : getAllActivePtySessions();
    return NextResponse.json<PtyListResponse>({ sessions, timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json<PtyListResponse>({
      sessions: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}));

// ---------------------------------------------------------------------------
// POST /api/collab/pty
// ---------------------------------------------------------------------------

export const POST = withTiming('/api/collab/pty', tracked('/api/collab/pty', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body: PtyActionRequest = await request.json();
    const now = new Date().toISOString();

    switch (body.action) {
      // --- PTY session primitives ---
      case 'spawn':               return handleSpawn(body, now);
      case 'message':             return handlePtyMessage(body);
      case 'close':               return handleClose(body, now);
      case 'detach':              return handleDetach(body, now);

      // --- Roster CRUD + listings ---
      case 'skills_list':              return handleSkillsList(body);
      case 'personalities_list':       return handlePersonalitiesList();
      case 'spawn_capabilities':       return handleSpawnCapabilities();
      case 'role_character_generate':  return handleRoleCharacterGenerate(body);
      case 'roster_list':              return handleRosterList(body);
      case 'roster_add':               return handleRosterAdd(body, now);
      case 'roster_add_from_participant': return handleRosterAddFromParticipant(body, now);
      case 'roster_remove':            return handleRosterRemove(body, now);
      case 'roster_update':            return handleRosterUpdate(body, now);
      case 'roster_directives_read':   return handleRosterDirectivesRead(body);
      case 'roster_directives_write':  return handleRosterDirectivesWrite(body);
      case 'roster_system_ownership_read': return handleRosterSystemOwnershipRead(body);
      case 'roster_system_ownership_write': return handleRosterSystemOwnershipWrite(body);

      // --- Roster lifecycle ---
      case 'roster_spawn':        return handleRosterSpawnAction(body, now);
      case 'roster_identity_switch': return handleRosterIdentitySwitchAction(body, now);
      case 'roster_kill':         return handleRosterKillAction(body, now);
      case 'roster_respawn':      return handleRosterRespawnAction(body, now);
      case 'roster_launch_all':   return handleRosterLaunchAll(body, now);
      case 'roster_kill_all':     return handleRosterKillAll(body, now);
      case 'roster_open_terminal': return handleRosterOpenTerminal(body);
      case 'roster_compact':      return handleRosterCompact(body);

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (error) {
    // Respect statusCode attached to thrown errors (e.g. `throw Object.assign(new Error('Agent not found in roster'), { statusCode: 404 })`).
    // Without this, legitimate client-error conditions raised inside withFileLock blocks
    // were promoted to 500 and logged as critical server errors (T2.2 / T2.3).
    const statusCode = (error as { statusCode?: number })?.statusCode;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600
      ? statusCode
      : 500;
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status });
  }
}));
