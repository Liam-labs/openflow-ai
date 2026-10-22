/**
 * Teams API
 *
 * POST /api/teams — actions: list, get, create, update, delete, launch, add_agent, remove_agent, update_agent
 * GET  /api/teams — list all teams
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { requireAuthOrLocal, validateApiToken, hasPermission, isLocalRequest, isCloudflaredRequest } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import {
  createTeam,
  getTeam,
  listTeams,
  updateTeam,
  deleteTeam,
  addAgentToTeam,
  removeAgentFromTeam,
  updateAgentInTeam,
  launchTeam,
} from '@/lib/team-operations';
import { appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

/** Guard: workingDirectory must resolve within HOME or process.cwd() */
function isAllowedWorkingDirectory(dir: string): boolean {
  const resolved = path.resolve(dir);
  const home = getHomeDir();
  const cwd = appRoot();
  return resolved.startsWith(home + path.sep) || resolved === home ||
         resolved.startsWith(cwd + path.sep) || resolved === cwd;
}

interface TeamsActionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export const GET = tracked('/api/teams', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const teams = await listTeams();
    return NextResponse.json<TeamsActionResponse>({
      success: true,
      data: { teams },
    });
  } catch (error) {
    return NextResponse.json<TeamsActionResponse>({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
});

/** Actions that require write scope */
const WRITE_ACTIONS = new Set(['create', 'update', 'delete', 'launch', 'add_agent', 'remove_agent', 'update_agent']);

export const POST = tracked('/api/teams', async (request: NextRequest) => {
  // Read scope for list/get; write scope enforced per-action below
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { action } = body;

    // Enforce write scope for mutating actions
    if (WRITE_ACTIONS.has(action)) {
      const tokenResult = await validateApiToken(request);
      if (tokenResult.valid && tokenResult.token) {
        // Authenticated via token — check write permission
        if (!hasPermission(tokenResult.token.scope, 'write')) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: "Scope 'write' required for this action",
          }, { status: 403 });
        }
      } else if (!isLocalRequest(request) && !isCloudflaredRequest(request)) {
        // Non-local, non-tunnel, no valid token — reject
        return NextResponse.json<TeamsActionResponse>({
          success: false,
          error: 'Authentication required',
        }, { status: 401 });
      }
      // Local and Cloudflared requests pass through (trusted network)
    }

    switch (action) {
      case 'list': {
        const teams = await listTeams();
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { teams },
        });
      }

      case 'get': {
        if (!body.teamId) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'teamId is required',
          }, { status: 400 });
        }
        const team = await getTeam(body.teamId);
        if (!team) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'Team not found',
          }, { status: 404 });
        }
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { team },
        });
      }

      case 'create': {
        if (!body.name) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'name is required',
          }, { status: 400 });
        }
        if (typeof body.name === 'string' && body.name.length > 100) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'name must be 100 characters or fewer',
          }, { status: 400 });
        }
        if (typeof body.description === 'string' && body.description.length > 1000) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'description must be 1000 characters or fewer',
          }, { status: 400 });
        }
        const team = await createTeam(body.name, body.description, body.projectId);
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { team },
        });
      }

      case 'update': {
        if (!body.teamId) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'teamId is required',
          }, { status: 400 });
        }
        if (typeof body.name === 'string' && body.name.length > 100) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'name must be 100 characters or fewer',
          }, { status: 400 });
        }
        if (typeof body.description === 'string' && body.description.length > 1000) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'description must be 1000 characters or fewer',
          }, { status: 400 });
        }
        const updated = await updateTeam(body.teamId, {
          name: body.name,
          description: body.description,
          projectId: body.projectId,
        });
        if (!updated) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'Team not found',
          }, { status: 404 });
        }
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { team: updated },
        });
      }

      case 'delete': {
        if (!body.teamId) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'teamId is required',
          }, { status: 400 });
        }
        const deleted = await deleteTeam(body.teamId);
        if (!deleted) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'Team not found',
          }, { status: 404 });
        }
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { message: 'Team deleted' },
        });
      }

      case 'launch': {
        if (!body.teamId) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'teamId is required',
          }, { status: 400 });
        }
        const result = await launchTeam(body.teamId, {
          channelId: body.channelId,
          channelName: body.channelName,
        });
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: result,
        });
      }

      case 'add_agent': {
        if (!body.teamId) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'teamId is required',
          }, { status: 400 });
        }
        if (!body.name || !body.workingDirectory) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'name and workingDirectory are required',
          }, { status: 400 });
        }
        if (typeof body.name === 'string' && body.name.length > 100) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'name must be 100 characters or fewer',
          }, { status: 400 });
        }
        if (typeof body.claudeFlags === 'string' && body.claudeFlags.length > 500) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'claudeFlags must be 500 characters or fewer',
          }, { status: 400 });
        }
        if (!isAllowedWorkingDirectory(body.workingDirectory)) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'workingDirectory is outside allowed paths',
          }, { status: 400 });
        }
        const agent = await addAgentToTeam(body.teamId, {
          name: body.name,
          workingDirectory: body.workingDirectory,
          color: body.color || '',
          autoResume: body.autoResume ?? true,
          useCollabWrapper: body.useCollabWrapper ?? true,
          dangerouslySkipPermissions: body.dangerouslySkipPermissions ?? true,
          claudeFlags: body.claudeFlags,
          lastClaudeSessionId: body.lastClaudeSessionId,
          lastLaunchedAt: undefined,
        });
        if (!agent) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'Team not found',
          }, { status: 404 });
        }
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { agent },
        });
      }

      case 'remove_agent': {
        if (!body.teamId || !body.agentId) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'teamId and agentId are required',
          }, { status: 400 });
        }
        const removed = await removeAgentFromTeam(body.teamId, body.agentId);
        if (!removed) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'Team or agent not found',
          }, { status: 404 });
        }
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { message: 'Agent removed from team' },
        });
      }

      case 'update_agent': {
        if (!body.teamId || !body.agentId) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'teamId and agentId are required',
          }, { status: 400 });
        }
        if (typeof body.name === 'string' && body.name.length > 100) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'name must be 100 characters or fewer',
          }, { status: 400 });
        }
        if (typeof body.claudeFlags === 'string' && body.claudeFlags.length > 500) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'claudeFlags must be 500 characters or fewer',
          }, { status: 400 });
        }
        if (body.workingDirectory !== undefined && !isAllowedWorkingDirectory(body.workingDirectory)) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'workingDirectory is outside allowed paths',
          }, { status: 400 });
        }
        const updatedAgent = await updateAgentInTeam(body.teamId, body.agentId, {
          name: body.name,
          workingDirectory: body.workingDirectory,
          color: body.color,
          autoResume: body.autoResume,
          useCollabWrapper: body.useCollabWrapper,
          dangerouslySkipPermissions: body.dangerouslySkipPermissions,
          claudeFlags: body.claudeFlags,
        });
        if (!updatedAgent) {
          return NextResponse.json<TeamsActionResponse>({
            success: false,
            error: 'Team or agent not found',
          }, { status: 404 });
        }
        return NextResponse.json<TeamsActionResponse>({
          success: true,
          data: { agent: updatedAgent },
        });
      }

      default:
        return NextResponse.json<TeamsActionResponse>({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    console.error('[Teams API] Error:', error);
    return NextResponse.json<TeamsActionResponse>({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
});
