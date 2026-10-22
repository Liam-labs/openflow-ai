/**
 * Teams Actions (Agent API)
 *
 * Provides programmatic access to persistent team management.
 */

import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { selfOrigin } from '@/lib/self-origin';

const TEAMS_API_URL = `${selfOrigin()}/api/teams`;

async function callTeamsApi(body: Record<string, unknown>) {
  const token = process.env.DEVFLOW_API_TOKEN || '';
  const res = await fetch(TEAMS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * teams.list - List all teams
 */
export async function list(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const data = await callTeamsApi({ action: 'list' });
  if (!data.success) throw new Error(data.error || 'Failed to list teams');
  return data.data;
}

/**
 * teams.get - Get a single team
 */
export async function get(body: AgentApiRequest, _auth: AgentAuthContext) {
  const teamId = body.teamId as string;
  if (!teamId) throw new Error('teamId is required');

  const data = await callTeamsApi({ action: 'get', teamId });
  if (!data.success) throw new Error(data.error || 'Failed to get team');
  return data.data;
}

/**
 * teams.create - Create a new team
 */
export async function create(body: AgentApiRequest, _auth: AgentAuthContext) {
  const name = body.name as string;
  if (!name) throw new Error('name is required');

  const data = await callTeamsApi({
    action: 'create',
    name,
    description: body.description,
    projectId: body.projectId,
  });
  if (!data.success) throw new Error(data.error || 'Failed to create team');
  return data.data;
}

/**
 * teams.update - Update team metadata
 */
export async function update(body: AgentApiRequest, _auth: AgentAuthContext) {
  const teamId = body.teamId as string;
  if (!teamId) throw new Error('teamId is required');

  const data = await callTeamsApi({
    action: 'update',
    teamId,
    name: body.name,
    description: body.description,
    projectId: body.projectId,
  });
  if (!data.success) throw new Error(data.error || 'Failed to update team');
  return data.data;
}

/**
 * teams.delete - Delete a team
 */
export async function remove(body: AgentApiRequest, _auth: AgentAuthContext) {
  const teamId = body.teamId as string;
  if (!teamId) throw new Error('teamId is required');

  const data = await callTeamsApi({ action: 'delete', teamId });
  if (!data.success) throw new Error(data.error || 'Failed to delete team');
  return data.data;
}

/**
 * teams.launch - Launch a team into a channel
 */
export async function launch(body: AgentApiRequest, _auth: AgentAuthContext) {
  const teamId = body.teamId as string;
  if (!teamId) throw new Error('teamId is required');

  const data = await callTeamsApi({
    action: 'launch',
    teamId,
    channelId: body.channelId,
    channelName: body.channelName,
  });
  if (!data.success) throw new Error(data.error || 'Failed to launch team');
  return data.data;
}

/**
 * teams.add_agent - Add agent to team template
 */
export async function addAgent(body: AgentApiRequest, _auth: AgentAuthContext) {
  const teamId = body.teamId as string;
  if (!teamId) throw new Error('teamId is required');

  const data = await callTeamsApi({
    action: 'add_agent',
    teamId,
    name: body.name,
    workingDirectory: body.workingDirectory,
    color: body.color,
    autoResume: body.autoResume,
    useCollabWrapper: body.useCollabWrapper,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions,
    claudeFlags: body.claudeFlags,
  });
  if (!data.success) throw new Error(data.error || 'Failed to add agent');
  return data.data;
}

/**
 * teams.remove_agent - Remove agent from team template
 */
export async function removeAgent(body: AgentApiRequest, _auth: AgentAuthContext) {
  const teamId = body.teamId as string;
  const agentId = body.agentId as string;
  if (!teamId || !agentId) throw new Error('teamId and agentId are required');

  const data = await callTeamsApi({ action: 'remove_agent', teamId, agentId });
  if (!data.success) throw new Error(data.error || 'Failed to remove agent');
  return data.data;
}

/**
 * teams.update_agent - Update agent in team template
 */
export async function updateAgent(body: AgentApiRequest, _auth: AgentAuthContext) {
  const teamId = body.teamId as string;
  const agentId = body.agentId as string;
  if (!teamId || !agentId) throw new Error('teamId and agentId are required');

  const data = await callTeamsApi({
    action: 'update_agent',
    teamId,
    agentId,
    name: body.name,
    workingDirectory: body.workingDirectory,
    color: body.color,
    autoResume: body.autoResume,
    useCollabWrapper: body.useCollabWrapper,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions,
    claudeFlags: body.claudeFlags,
  });
  if (!data.success) throw new Error(data.error || 'Failed to update agent');
  return data.data;
}
